import { Worker, type Job } from 'bullmq';
import { AiMode, SenderType } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createRedisConnection } from '../lib/redis';
import { QUEUE_NAMES } from '../queues';
import type { AIJob, EmbeddingJob } from '../queues/jobTypes';
import { canAutoReply, generateAnswer, getAssistant, recordAIUsage } from '../services/ai.service';
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
 */
export function createAIWorker(): Worker<AIJob> {
  return new Worker<AIJob>(
    QUEUE_NAMES.AI_PROCESSING,
    async (job: Job<AIJob>) => {
      // The AI queue carries two kinds of work: answering a customer, and
      // indexing a knowledge document.
      if (job.name === 'ingest-document') {
        const { organizationId, documentId } = job.data as unknown as EmbeddingJob;
        await ingestDocument(organizationId, documentId);
        return;
      }

      const { organizationId, conversationId, messageId, mode } = job.data;

      const message = messageId
        ? await prisma.message.findFirst({
            where: { id: messageId, organizationId },
            select: { body: true },
          })
        : null;

      const question = message?.body?.trim();
      if (!question) return;

      const assistant = await getAssistant(organizationId);
      if (mode === 'suggestion' && !assistant.suggestionsEnabled) return;

      const answer = await generateAnswer(organizationId, question, { conversationId });

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

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiReplyCount: { increment: 1 } },
      });
      await prisma.aIConversationSession.update({
        where: { conversationId },
        data: { replyCount: { increment: 1 } },
      });
    },
    { connection: createRedisConnection(), concurrency: Math.max(2, Math.floor(env.WORKER_CONCURRENCY / 2)) },
  );
}

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
      body: reason === 'customer_requested_human' ? 'The customer asked to talk to a person.' : 'The assistant was not confident enough to answer.',
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
