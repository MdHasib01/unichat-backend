import { DelayedError, Worker, type Job } from 'bullmq';
import { AiMode, SenderType } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createRedisConnection, incrementWindow, setOnce } from '../lib/redis';
import { QUEUE_NAMES } from '../queues';
import type { AIJob, EmbeddingJob } from '../queues/jobTypes';
import {
  canAutoReply,
  generateAnswer,
  getAssistant,
  pendingInboundBatch,
  recordAIReply,
  recordAIUsage,
} from '../services/ai.service';
import { processTrainingImport, reembedTraining } from '../services/aiTraining.service';
import { signalVisitorTyping } from '../services/webchat.service';
import { ingestDocument } from '../ai/rag/ingest';
import { queueOutboundMessage } from '../services/message.service';
import { createNotification } from '../services/notification.service';
import { emitRealtime } from '../realtime/publisher';
import { RealtimeEvent } from '../realtime/events';

/**
 * AI worker (spec sections 24 and 25).
 *
 * auto_reply  — answers the customer when the organization enabled it and the
 *               answer clears the confidence threshold.
 * suggestion  — drafts a reply for the agent without sending anything.
 *
 * Either way the conversation can be handed to a human, which pauses the AI.
 * The same queue also indexes knowledge documents and imports training files.
 */
export function createAIWorker(): Worker<AIJob> {
  return new Worker<AIJob>(
    QUEUE_NAMES.AI_PROCESSING,
    async (job: Job<AIJob>, token?: string) => {
      if (job.name === 'ingest-document') {
        const { organizationId, documentId } = job.data as unknown as EmbeddingJob;
        await ingestDocument(organizationId, documentId);
        return;
      }

      if (job.name === 'import-training') {
        const { organizationId, importId } = job.data as unknown as { organizationId: string; importId: string };
        await processTrainingImport(organizationId, importId);
        return;
      }

      if (job.name === 'reembed-training') {
        await reembedTraining((job.data as unknown as { organizationId: string }).organizationId);
        return;
      }

      try {
        await respond(job, token);
      } catch (error) {
        if (error instanceof DelayedError) throw error;

        // Out of retries on an automatic reply: never leave the customer
        // waiting in silence — hand the conversation to the team.
        const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (lastAttempt && job.data.mode === 'auto_reply') {
          logger.error({ err: error, conversationId: job.data.conversationId }, 'ai reply failed; handing off');
          const { organizationId, conversationId } = job.data;
          const batch = await pendingInboundBatch(organizationId, conversationId);
          if (batch.latestId && (await claimAnswer(organizationId, conversationId, batch.latestId))) {
            await handoffToHuman(organizationId, conversationId, 'ai_error');
          }
          return;
        }
        throw error;
      }
    },
    { connection: createRedisConnection(), concurrency: Math.max(2, Math.floor(env.WORKER_CONCURRENCY / 2)) },
  );
}

async function respond(job: Job<AIJob>, token?: string) {
  const { organizationId, conversationId, mode } = job.data;

  // Debounce: if the customer wrote again after this job was queued, the
  // newer message's job answers everything in one reply.
  const batch = await pendingInboundBatch(organizationId, conversationId);
  if (job.data.messageId && batch.latestId && batch.latestId !== job.data.messageId) {
    logger.debug({ conversationId }, 'newer inbound message pending; skipping');
    return;
  }

  let question = batch.question;
  let answeringId = batch.latestId;

  if (!question) {
    // Already answered (by an agent or an earlier job). Only a suggestion for
    // a specific message still makes sense.
    if (mode !== 'suggestion' || !job.data.messageId) return;
    const message = await prisma.message.findFirst({
      where: { id: job.data.messageId, organizationId },
      select: { body: true },
    });
    question = message?.body?.trim() ?? '';
    answeringId = job.data.messageId;
    if (!question) return;
  }

  const assistant = await getAssistant(organizationId);
  if (mode === 'suggestion' && !assistant.suggestionsEnabled) return;

  // Fairness across tenants sharing the worker: past the per-minute budget,
  // park the job briefly instead of failing it.
  if (mode === 'auto_reply') {
    const count = await incrementWindow(`ai:rl:${organizationId}`, 60);
    if (count !== null && count > env.AI_ORG_REPLIES_PER_MIN && token) {
      await job.moveToDelayed(Date.now() + 10_000, token);
      throw new DelayedError();
    }
    await signalVisitorTyping(organizationId, conversationId, 'bot').catch(() => undefined);
  }

  const answer = await generateAnswer(organizationId, question, {
    conversationId,
    historyBefore: batch.startedAt,
  });

  await recordAIUsage(organizationId, answer.tokensUsed);

  await prisma.aIConversationSession.upsert({
    where: { conversationId },
    create: {
      organizationId,
      conversationId,
      replyCount: 0,
      lastConfidence: answer.confidence,
      totalTokens: answer.tokensUsed,
    },
    update: {
      lastConfidence: answer.confidence,
      totalTokens: { increment: answer.tokensUsed },
    },
  });

  if (mode === 'suggestion') {
    // Suggestions never reach the customer — they surface in the composer.
    await emitRealtime(
      organizationId,
      RealtimeEvent.CONVERSATION_UPDATED,
      {
        id: conversationId,
        aiSuggestion: {
          text: answer.answer || assistant.fallbackMessage,
          confidence: answer.confidence,
          sources: answer.sources,
        },
      },
      { conversationId },
    );
    return;
  }

  // Re-check immediately before sending: an agent may have taken the
  // thread while this job waited in the queue.
  const { allowed, reason } = await canAutoReply(organizationId, conversationId);
  if (!allowed) {
    logger.debug({ conversationId, reason }, 'ai auto-reply aborted before sending');
    if (reason === 'ai_quota_exhausted') await notifyQuotaExhausted(organizationId);
    return;
  }

  // Exactly one reply per customer message, even across retries and
  // overlapping jobs.
  if (!answeringId || !(await claimAnswer(organizationId, conversationId, answeringId))) {
    logger.debug({ conversationId }, 'message already answered; skipping');
    return;
  }

  if (answer.shouldHandoff) {
    await handoffToHuman(organizationId, conversationId, answer.handoffReason ?? 'low_confidence');
    return;
  }

  await queueOutboundMessage({
    organizationId,
    conversationId,
    body: answer.answer,
    senderType: SenderType.AI,
    aiGenerated: true,
    aiConfidence: answer.confidence,
  });

  await Promise.all([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { aiReplyCount: { increment: 1 } },
    }),
    prisma.aIConversationSession.update({
      where: { conversationId },
      data: { replyCount: { increment: 1 } },
    }),
    recordAIReply(organizationId),
  ]);
}

/**
 * Atomically marks `messageId` as answered. Returns false if another job (or
 * a retry of this one) already answered it.
 */
async function claimAnswer(organizationId: string, conversationId: string, messageId: string): Promise<boolean> {
  await prisma.aIConversationSession.upsert({
    where: { conversationId },
    create: { organizationId, conversationId },
    update: {},
  });
  const claimed = await prisma.aIConversationSession.updateMany({
    where: {
      conversationId,
      organizationId,
      OR: [{ lastAnsweredMessageId: null }, { lastAnsweredMessageId: { not: messageId } }],
    },
    data: { lastAnsweredMessageId: messageId },
  });
  return claimed.count > 0;
}

/** Tells the team once per month that automatic replies have stopped. */
async function notifyQuotaExhausted(organizationId: string) {
  const month = new Date().toISOString().slice(0, 7);
  if (!(await setOnce(`ai:quota-notified:${organizationId}:${month}`, 35 * 24 * 3600))) return;

  const { notifyOrganization } = await import('../services/notification.service');
  await notifyOrganization(
    organizationId,
    {
      type: 'SYSTEM',
      title: 'AI auto-replies are paused for this month',
      body: 'Your plan’s AI reply quota is used up. The assistant still drafts suggestions for your team.',
      link: '/settings/billing',
    },
    ['OWNER', 'ADMIN'],
  );
}

const HANDOFF_EXPLANATIONS: Record<string, string> = {
  customer_requested_human: 'The customer asked to talk to a person.',
  low_confidence: 'The assistant was not confident enough to answer.',
  ai_error: 'The assistant could not generate a reply.',
};

/**
 * Human handoff (spec section 25): pause the AI, tell the customer a person is
 * coming, leave an internal note and alert the team.
 */
export async function handoffToHuman(
  organizationId: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  const assistant = await getAssistant(organizationId);

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { aiMode: AiMode.PAUSED },
  });

  await prisma.aIConversationSession
    .update({
      where: { conversationId },
      data: { handedOff: true, handoffReason: reason },
    })
    .catch(() => undefined);

  const customerMessage =
    reason === 'customer_requested_human' ? assistant.handoffMessage : assistant.fallbackMessage;

  await queueOutboundMessage({
    organizationId,
    conversationId,
    body: customerMessage,
    senderType: SenderType.AI,
    aiGenerated: true,
  });

  await prisma.message.create({
    data: {
      organizationId,
      conversationId,
      platform: 'INTERNAL',
      direction: 'OUTBOUND',
      type: 'NOTE',
      senderType: SenderType.SYSTEM,
      isInternal: true,
      body: `AI paused and handed this conversation to the team (${reason.replace(/_/g, ' ')}).`,
    },
  });

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contact: { select: { displayName: true } } },
  });

  const { notifyOrganization } = await import('../services/notification.service');
  await notifyOrganization(
    organizationId,
    {
      type: 'AI_HANDOFF',
      title: `${conversation?.contact.displayName ?? 'A customer'} needs a human`,
      body: HANDOFF_EXPLANATIONS[reason] ?? HANDOFF_EXPLANATIONS.low_confidence,
      link: `/inbox/${conversationId}`,
    },
    ['OWNER', 'ADMIN', 'MANAGER', 'AGENT'],
  );

  await emitRealtime(
    organizationId,
    RealtimeEvent.CONVERSATION_UPDATED,
    { id: conversationId, aiMode: AiMode.PAUSED },
    { conversationId },
  );
}

export { createNotification };
