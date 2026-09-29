import { AutomationTriggerType, MessageType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { withLock } from '../lib/redis';
import { automationQueue, messageQueue } from '../queues';
import type { AutomationJob, InboundMessageJob } from '../queues/jobTypes';
import type { NormalizedMessage } from '../integrations/types';
import { findOrCreateContactByIdentifier } from './contact.service';
import { findOrCreateConversation } from './conversation.service';
import { storeInboundMessage } from './message.service';

export interface InboundProfile {
  displayName?: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
}

export interface IngestedMessage {
  messageId: string;
  conversationId: string;
  contactId: string;
  isFirstMessage: boolean;
  message: NonNullable<Awaited<ReturnType<typeof storeInboundMessage>>>;
}

/**
 * The channel-independent half of inbound processing:
 * contact → conversation → message → hand off to the message and automation
 * queues. Meta webhooks and the website chat widget both end up here, so
 * every channel gets identical inbox, automation and AI behaviour.
 *
 * Returns null when the message was already stored (provider redelivery, or a
 * widget retry with the same client id).
 */
export async function ingestInboundMessage(params: {
  organizationId: string;
  socialAccountId: string;
  message: NormalizedMessage;
  profile?: InboundProfile;
}): Promise<IngestedMessage | null> {
  const { organizationId, socialAccountId, message, profile } = params;

  // Two workers may pick up redelivered entries at once.
  const result = await withLock(
    `inbound:${message.platform}:${message.externalMessageId}`,
    30_000,
    async (): Promise<IngestedMessage | null> => {
      const contact = await findOrCreateContactByIdentifier({
        organizationId,
        platform: message.platform,
        externalId: message.senderExternalId,
        socialAccountId,
        displayName: profile?.displayName,
        phone: profile?.phone,
        email: profile?.email,
        avatarUrl: profile?.avatarUrl,
      });

      const conversation = await findOrCreateConversation({
        organizationId,
        contactId: contact.id,
        platform: message.platform,
        socialAccountId,
        externalId: message.threadExternalId ?? message.senderExternalId,
      });

      const existingInbound = await prisma.message.count({
        where: { organizationId, conversationId: conversation.id, direction: 'INBOUND' },
      });

      const stored = await storeInboundMessage({
        organizationId,
        conversationId: conversation.id,
        contactId: contact.id,
        platform: message.platform,
        externalMessageId: message.externalMessageId,
        socialAccountId,
        body: message.text,
        type: message.type ?? MessageType.TEXT,
        attachments: message.attachments,
        timestamp: message.timestamp,
        raw: message.raw,
      });

      if (!stored) return null;

      return {
        messageId: stored.id,
        conversationId: conversation.id,
        contactId: contact.id,
        isFirstMessage: existingInbound === 0,
        message: stored,
      };
    },
  );

  if (!result) return null;

  // The message is stored and visible in the inbox from here on. If the queue
  // is unreachable, follow-up work (notifications, AI, automations) is lost,
  // but the customer's message itself was received — so the caller must not
  // report it as failed.
  try {
    await enqueueFollowUps(organizationId, message, result);
  } catch (error) {
    logger.error(
      { err: error, organizationId, messageId: result.messageId },
      'inbound message stored, but follow-up jobs could not be queued',
    );
  }

  return result;
}

async function enqueueFollowUps(organizationId: string, message: NormalizedMessage, result: IngestedMessage) {
  const inboundJob: InboundMessageJob = {
    organizationId,
    messageId: result.messageId,
    conversationId: result.conversationId,
    contactId: result.contactId,
    platform: message.platform,
    isFirstMessage: result.isFirstMessage,
  };
  await messageQueue().add('process-inbound', inboundJob, {
    jobId: `inbound:${result.messageId}`,
  });

  // First message and keyword automations both start from the same event.
  const automationJob: AutomationJob = {
    organizationId,
    conversationId: result.conversationId,
    contactId: result.contactId,
    messageId: result.messageId,
    triggerType: result.isFirstMessage
      ? AutomationTriggerType.FIRST_MESSAGE
      : AutomationTriggerType.KEYWORD,
  };
  await automationQueue().add('run-automation', automationJob);
}
