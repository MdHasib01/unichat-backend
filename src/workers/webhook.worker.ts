import { Worker, type Job } from 'bullmq';
import { Platform, WebhookEventStatus } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createRedisConnection } from '../lib/redis';
import { QUEUE_NAMES } from '../queues';
import type { WebhookJob } from '../queues/jobTypes';
import { getProvider } from '../integrations/registry';
import { profileNameFromRaw } from '../integrations/meta/normalize';
import { applyStatusUpdate } from '../services/message.service';
import { ingestInboundMessage } from '../services/inbound.service';
import type { NormalizedMessage } from '../integrations/types';

/**
 * Webhook worker (spec section 13).
 *
 * Meta → identify integration → identify organization → normalize → contact →
 * conversation → message → hand off to the automation queue.
 */
export function createWebhookWorker(): Worker<WebhookJob> {
  return new Worker<WebhookJob>(
    QUEUE_NAMES.WEBHOOK_PROCESSING,
    async (job: Job<WebhookJob>) => {
      const { webhookEventId } = job.data;

      const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
      if (!event) {
        logger.warn({ webhookEventId }, 'webhook event vanished before processing');
        return;
      }
      if (event.status === WebhookEventStatus.PROCESSED) return;

      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: WebhookEventStatus.PROCESSING, attempts: { increment: 1 } },
      });

      try {
        const platform = event.platform ?? Platform.FACEBOOK;
        const provider = getProvider(platform);
        const { messages, statuses } = provider.handleWebhook(event.payload);

        for (const status of statuses) {
          await applyStatusUpdate(
            status.platform,
            status.externalMessageId,
            status.status,
            status.error,
          );
        }

        for (const message of messages) {
          // Echoes are our own outbound messages reflected back.
          if (message.isEcho) continue;
          await processInboundMessage(message, webhookEventId);
        }

        await prisma.webhookEvent.update({
          where: { id: webhookEventId },
          data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date(), error: null },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Webhook processing failed';
        await prisma.webhookEvent.update({
          where: { id: webhookEventId },
          data: { status: WebhookEventStatus.FAILED, error: message.slice(0, 500) },
        });
        throw error;
      }
    },
    { connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY },
  );
}

async function processInboundMessage(message: NormalizedMessage, webhookEventId: string) {
  /**
   * The receiving business account is what ties a webhook to a tenant. If we
   * cannot match it, the message belongs to no organization we serve and is
   * dropped rather than guessed at.
   */
  const socialAccount = await prisma.socialAccount.findFirst({
    where: {
      platform: message.platform,
      externalId: message.recipientExternalId,
    },
    select: { id: true, organizationId: true, integrationId: true, isActive: true },
  });

  if (!socialAccount) {
    logger.warn(
      { platform: message.platform, recipient: message.recipientExternalId },
      'no connected channel matches this webhook recipient; dropping',
    );
    return;
  }

  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { organizationId: socialAccount.organizationId, integrationId: socialAccount.integrationId },
  });

  await ingestInboundMessage({
    organizationId: socialAccount.organizationId,
    socialAccountId: socialAccount.id,
    message,
    profile: {
      displayName: profileNameFromRaw(message.raw),
      phone: message.platform === Platform.WHATSAPP ? message.senderExternalId : undefined,
    },
  });
}
