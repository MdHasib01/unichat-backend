import {
  MessageDirection,
  MessageStatus,
  MessageType,
  Platform,
  Prisma,
  SenderType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { emitRealtime } from '../realtime/publisher';
import { RealtimeEvent } from '../realtime/events';
import { sendQueue } from '../queues';
import type { SendMessageJob } from '../queues/jobTypes';
import type { NormalizedAttachment } from '../integrations/types';

const messageInclude = {
  user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
  contact: { select: { id: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.MessageInclude;

export interface CreateOutboundInput {
  organizationId: string;
  conversationId: string;
  userId?: string;
  body?: string;
  attachments?: NormalizedAttachment[];
  type?: MessageType;
  senderType?: SenderType;
  aiGenerated?: boolean;
  aiConfidence?: number;
  template?: { name: string; language: string };
}

/**
 * Queues an outbound message.
 *
 * The message row is written immediately with status QUEUED so the agent sees
 * it instantly, then the message-sending queue talks to the provider. Network
 * calls never happen inside the request (spec sections 13 and 15).
 */
export async function queueOutboundMessage(input: CreateOutboundInput) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, organizationId: input.organizationId },
    include: {
      contact: { include: { identifiers: true } },
      socialAccount: { select: { id: true, isActive: true, externalId: true } },
    },
  });

  if (!conversation) throw new NotFoundError('Conversation');

  if (!input.body?.trim() && !input.attachments?.length && !input.template) {
    throw new BadRequestError('A message needs text, an attachment or a template');
  }

  const identifier = conversation.contact.identifiers.find(
    (i) => i.platform === conversation.platform,
  );
  if (!identifier) {
    throw new BadRequestError(
      `This contact has no ${conversation.platform} identity, so the message cannot be delivered`,
      [],
      'NO_PLATFORM_IDENTITY',
    );
  }

  const message = await prisma.message.create({
    data: {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      platform: conversation.platform,
      direction: MessageDirection.OUTBOUND,
      type: input.type ?? (input.attachments?.length ? attachmentMessageType(input.attachments[0]) : MessageType.TEXT),
      status: MessageStatus.QUEUED,
      senderType: input.senderType ?? SenderType.AGENT,
      body: input.body?.trim() || null,
      attachments: (input.attachments ?? []) as never,
      userId: input.userId,
      contactId: conversation.contactId,
      socialAccountId: conversation.socialAccountId,
      aiGenerated: input.aiGenerated ?? false,
      aiConfidence: input.aiConfidence,
    },
    include: messageInclude,
  });

  await touchConversationForOutbound(input.organizationId, input.conversationId, input.body ?? '[attachment]');

  await emitRealtime(input.organizationId, RealtimeEvent.MESSAGE_CREATED, message, {
    conversationId: input.conversationId,
  });

  const job: SendMessageJob = {
    organizationId: input.organizationId,
    messageId: message.id,
    conversationId: input.conversationId,
    platform: conversation.platform,
    socialAccountId: conversation.socialAccountId,
    recipientExternalId: identifier.externalId,
    body: message.body,
    type: message.type,
    attachments: input.attachments,
  };

  await sendQueue().add('send-message', job, { jobId: `send:${message.id}` });

  return message;
}

function attachmentMessageType(attachment: NormalizedAttachment): MessageType {
  switch (attachment.type) {
    case 'image':
      return MessageType.IMAGE;
    case 'video':
      return MessageType.VIDEO;
    case 'audio':
      return MessageType.AUDIO;
    case 'sticker':
      return MessageType.STICKER;
    case 'location':
      return MessageType.LOCATION;
    default:
      return MessageType.FILE;
  }
}

export async function markMessageSent(
  organizationId: string,
  messageId: string,
  externalMessageId: string,
) {
  const message = await prisma.message.update({
    where: { id: messageId },
    data: { status: MessageStatus.SENT, externalId: externalMessageId },
    include: messageInclude,
  });

  await emitRealtime(organizationId, RealtimeEvent.MESSAGE_UPDATED, message, {
    conversationId: message.conversationId,
  });
  return message;
}

export async function markMessageFailed(
  organizationId: string,
  messageId: string,
  error: string,
) {
  const message = await prisma.message.update({
    where: { id: messageId },
    data: { status: MessageStatus.FAILED, errorMessage: error.slice(0, 500) },
    include: messageInclude,
  });

  await emitRealtime(organizationId, RealtimeEvent.MESSAGE_UPDATED, message, {
    conversationId: message.conversationId,
  });
  return message;
}

export async function applyStatusUpdate(
  platform: Platform,
  externalMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  error?: string,
) {
  const message = await prisma.message.findFirst({
    where: { platform, externalId: externalMessageId },
    select: { id: true, organizationId: true, conversationId: true },
  });
  if (!message) return;

  const data: Prisma.MessageUpdateInput = {};
  switch (status) {
    case 'delivered':
      data.status = MessageStatus.DELIVERED;
      data.deliveredAt = new Date();
      break;
    case 'read':
      data.status = MessageStatus.READ;
      data.readAt = new Date();
      break;
    case 'failed':
      data.status = MessageStatus.FAILED;
      data.errorMessage = error?.slice(0, 500);
      break;
    default:
      data.status = MessageStatus.SENT;
  }

  const updated = await prisma.message.update({
    where: { id: message.id },
    data,
    include: messageInclude,
  });

  await emitRealtime(message.organizationId, RealtimeEvent.MESSAGE_UPDATED, updated, {
    conversationId: message.conversationId,
  });
}

/**
 * Stores an inbound message. Returns null when the provider redelivers a
 * message we already have (idempotency, spec section 13).
 */
export async function storeInboundMessage(params: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  platform: Platform;
  externalMessageId: string;
  socialAccountId?: string | null;
  body?: string;
  type: MessageType;
  attachments: NormalizedAttachment[];
  timestamp: Date;
  raw?: unknown;
}) {
  const existing = await prisma.message.findFirst({
    where: {
      organizationId: params.organizationId,
      platform: params.platform,
      externalId: params.externalMessageId,
    },
    select: { id: true },
  });

  if (existing) {
    logger.debug({ externalId: params.externalMessageId }, 'duplicate inbound message ignored');
    return null;
  }

  const message = await prisma.message.create({
    data: {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      platform: params.platform,
      direction: MessageDirection.INBOUND,
      type: params.type,
      status: MessageStatus.DELIVERED,
      senderType: SenderType.CONTACT,
      body: params.body ?? null,
      attachments: params.attachments as never,
      externalId: params.externalMessageId,
      contactId: params.contactId,
      socialAccountId: params.socialAccountId,
      deliveredAt: params.timestamp,
      createdAt: params.timestamp,
      metadata: (params.raw ?? undefined) as never,
    },
    include: messageInclude,
  });

  const preview = params.body ?? `[${params.type.toLowerCase()}]`;

  const conversation = await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      unreadCount: { increment: 1 },
      messageCount: { increment: 1 },
      lastMessageAt: params.timestamp,
      lastInboundAt: params.timestamp,
      lastMessagePreview: preview.slice(0, 280),
    },
  });

  await prisma.contact.update({
    where: { id: params.contactId },
    data: { lastContactedAt: params.timestamp },
  });

  await emitRealtime(params.organizationId, RealtimeEvent.MESSAGE_CREATED, message, {
    conversationId: params.conversationId,
  });
  await emitRealtime(params.organizationId, RealtimeEvent.CONVERSATION_UPDATED, conversation, {
    conversationId: params.conversationId,
  });

  return message;
}

async function touchConversationForOutbound(
  organizationId: string,
  conversationId: string,
  preview: string,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
    select: { lastInboundAt: true, firstResponseSeconds: true },
  });

  const now = new Date();
  const data: Prisma.ConversationUpdateInput = {
    messageCount: { increment: 1 },
    lastMessageAt: now,
    lastOutboundAt: now,
    lastMessagePreview: preview.slice(0, 280),
  };

  // First response time is measured from the customer's first waiting message.
  if (conversation?.lastInboundAt && conversation.firstResponseSeconds == null) {
    data.firstResponseSeconds = Math.max(
      0,
      Math.round((now.getTime() - conversation.lastInboundAt.getTime()) / 1000),
    );
  }

  await prisma.conversation.update({ where: { id: conversationId }, data });
}

export async function searchMessages(
  organizationId: string,
  query: string,
  limit = 20,
): Promise<Array<{ id: string; conversationId: string; body: string | null; createdAt: Date }>> {
  return prisma.message.findMany({
    where: { organizationId, body: { contains: query, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, conversationId: true, body: true, createdAt: true },
  });
}
