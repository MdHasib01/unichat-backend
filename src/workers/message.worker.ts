import { Worker, type Job } from 'bullmq';
import { MessageStatus } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createRedisConnection } from '../lib/redis';
import { QUEUE_NAMES, aiQueue, analyticsQueue, notificationQueue } from '../queues';
import type { AIJob, AnalyticsJob, InboundMessageJob, NotificationJob, SendMessageJob } from '../queues/jobTypes';
import { getProvider, resolveCredentials } from '../integrations/registry';
import { markMessageFailed, markMessageSent } from '../services/message.service';
import { canAutoReply } from '../services/ai.service';
import type { NormalizedAttachment } from '../integrations/types';

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

      await aiQueue().add('ai-respond', aiJob, { jobId: `ai:${messageId}` });

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
      const { organizationId, messageId, socialAccountId, platform, recipientExternalId } = job.data;

      const message = await prisma.message.findFirst({
        where: { id: messageId, organizationId },
        select: { id: true, status: true },
      });
      if (!message) return;
      // Never send the same message twice on a retry of an already-sent job.
      if (message.status !== MessageStatus.QUEUED) return;

      if (!socialAccountId) {
        await markMessageFailed(
          organizationId,
          messageId,
          'This conversation has no connected channel to send from',
        );
        return;
      }

      try {
        const credentials = await resolveCredentials(organizationId, socialAccountId);
        const provider = getProvider(platform);

        const result = await provider.sendMessage(credentials, {
          recipientExternalId,
          text: job.data.body ?? undefined,
          attachments: job.data.attachments as NormalizedAttachment[] | undefined,
        });

        await markMessageSent(organizationId, messageId, result.externalMessageId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Send failed';
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

        if (isLastAttempt) {
          await markMessageFailed(organizationId, messageId, reason);
          await prisma.socialAccount
            .update({ where: { id: socialAccountId }, data: { lastError: reason.slice(0, 500) } })
            .catch(() => undefined);
        }
        throw error;
      }
    },
    { connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY },
  );
}
