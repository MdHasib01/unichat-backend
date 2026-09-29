import { Worker, type Job } from 'bullmq';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createRedisConnection } from '../lib/redis';
import { QUEUE_NAMES, aiQueue, analyticsQueue, notificationQueue } from '../queues';
import type { AIJob, AnalyticsJob, InboundMessageJob, NotificationJob, SendMessageJob } from '../queues/jobTypes';
import { deliverOutbound } from '../services/delivery.service';
import { canAutoReply } from '../services/ai.service';

/**
 * Inbound pipeline stage: after a message is stored, decide who should hear
 * about it — the team (notification) and the AI assistant (auto reply).
 */
export function createMessageWorker(): Worker<InboundMessageJob> {
  return new Worker<InboundMessageJob>(
    QUEUE_NAMES.MESSAGE_PROCESSING,
    async (job: Job<InboundMessageJob>) => {
      const { organizationId, conversationId, messageId, contactId } = job.data;

      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, organizationId },
        select: {
          id: true,
          lastMessagePreview: true,
          contact: { select: { displayName: true } },
          assignments: { where: { isActive: true }, select: { assigneeId: true } },
        },
      });
      if (!conversation) return;

      const assignedUserIds = conversation.assignments
        .map((a) => a.assigneeId)
        .filter((id): id is string => Boolean(id));

      const notification: NotificationJob = {
        organizationId,
        userIds: assignedUserIds.length ? assignedUserIds : undefined,
        type: 'NEW_MESSAGE',
        title: `New message from ${conversation.contact.displayName}`,
        body: conversation.lastMessagePreview ?? undefined,
        link: `/inbox/${conversationId}`,
        metadata: { conversationId, messageId },
      };
      await notificationQueue().add('notify', notification);

      const { allowed, reason } = await canAutoReply(organizationId, conversationId);

      const aiJob: AIJob = {
        organizationId,
        conversationId,
        messageId,
        contactId,
        mode: allowed ? 'auto_reply' : 'suggestion',
      };

      if (!allowed) logger.debug({ conversationId, reason }, 'ai auto-reply skipped');

      // Waiting a moment lets a burst of messages be answered as one; the AI
      // worker skips any job whose message is no longer the latest.
      await aiQueue().add('ai-respond', aiJob, { jobId: `ai:${messageId}`, delay: env.AI_DEBOUNCE_MS });

      const analytics: AnalyticsJob = { organizationId, kind: 'rollup_day' };
      await analyticsQueue().add('rollup', analytics, {
        jobId: `rollup:${organizationId}:${new Date().toISOString().slice(0, 10)}`,
        delay: 30_000,
      });
    },
    { connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY },
  );
}

/**
 * Outbound pipeline stage: hand the message to the channel provider.
 * BullMQ retries with exponential backoff; only the final failure marks the
 * message FAILED for the agent to see.
 */
export function createSendWorker(): Worker<SendMessageJob> {
  return new Worker<SendMessageJob>(
    QUEUE_NAMES.MESSAGE_SENDING,
    async (job: Job<SendMessageJob>) => {
      await deliverOutbound(job.data, {
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      });
    },
    { connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY },
  );
}
