import {
  AiMode,
  ConversationStatus,
  MessageDirection,
  MessageType,
  Platform,
  Prisma,
  SenderType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { assertAllBelongToOrg } from '../repositories/tenant.repository';
import { emitRealtime } from '../realtime/publisher';
import { RealtimeEvent } from '../realtime/events';

export const conversationListSelect = {
  id: true,
  organizationId: true,
  platform: true,
  status: true,
  priority: true,
  unreadCount: true,
  messageCount: true,
  aiMode: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  createdAt: true,
  updatedAt: true,
  contact: {
    select: { id: true, displayName: true, avatarUrl: true, email: true, phone: true },
  },
  socialAccount: { select: { id: true, name: true, platform: true, avatarUrl: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
  assignments: {
    where: { isActive: true },
    take: 1,
    select: {
      assignee: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
    },
  },
} satisfies Prisma.ConversationSelect;

export interface ListConversationsParams {
  page: number;
  pageSize: number;
  status?: ConversationStatus;
  platform?: Platform;
  assigneeId?: string;
  /** "me" resolves to the requesting user; "unassigned" to no active assignee. */
  assignment?: 'me' | 'unassigned' | 'all';
  tagId?: string;
  search?: string;
  unreadOnly?: boolean;
  currentUserId: string;
}

export async function listConversations(organizationId: string, params: ListConversationsParams) {
  const where: Prisma.ConversationWhereInput = { organizationId };

  if (params.status) where.status = params.status;
  if (params.platform) where.platform = params.platform;
  if (params.tagId) where.tags = { some: { tagId: params.tagId } };
  if (params.unreadOnly) where.unreadCount = { gt: 0 };

  if (params.assignment === 'me') {
    where.assignments = { some: { isActive: true, assigneeId: params.currentUserId } };
  } else if (params.assignment === 'unassigned') {
    where.assignments = { none: { isActive: true, assigneeId: { not: null } } };
  } else if (params.assigneeId) {
    where.assignments = { some: { isActive: true, assigneeId: params.assigneeId } };
  }

  if (params.search) {
    where.OR = [
      { contact: { displayName: { contains: params.search, mode: 'insensitive' } } },
      { contact: { email: { contains: params.search, mode: 'insensitive' } } },
      { contact: { phone: { contains: params.search, mode: 'insensitive' } } },
      { lastMessagePreview: { contains: params.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      select: conversationListSelect,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.conversation.count({ where }),
  ]);

  return { items, total };
}

export async function getConversation(organizationId: string, conversationId: string) {
  // Tenant check is part of the query, exactly as spec section 4 requires.
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
    include: {
      contact: {
        include: {
          tags: { include: { tag: true } },
          identifiers: true,
          fieldValues: { include: { field: true } },
        },
      },
      socialAccount: { select: { id: true, name: true, platform: true, avatarUrl: true, isActive: true } },
      tags: { include: { tag: true } },
      assignments: {
        where: { isActive: true },
        include: {
          assignee: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, email: true } },
        },
      },
      aiSessions: true,
    },
  });

  if (!conversation) throw new NotFoundError('Conversation');
  return conversation;
}

export async function listMessages(
  organizationId: string,
  conversationId: string,
  params: { limit: number; before?: string },
) {
  const exists = await prisma.conversation.count({ where: { id: conversationId, organizationId } });
  if (!exists) throw new NotFoundError('Conversation');

  const where: Prisma.MessageWhereInput = { organizationId, conversationId };
  if (params.before) {
    const cursor = await prisma.message.findFirst({
      where: { id: params.before, organizationId },
      select: { createdAt: true },
    });
    if (cursor) where.createdAt = { lt: cursor.createdAt };
  }

  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: params.limit,
    include: {
      user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      contact: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });

  // Return oldest-first for rendering; `hasMore` drives infinite scroll up.
  return {
    items: messages.reverse(),
    hasMore: messages.length === params.limit,
  };
}

export interface UpdateConversationInput {
  status?: ConversationStatus;
  priority?: Prisma.ConversationUpdateInput['priority'];
  aiMode?: AiMode;
  subject?: string | null;
  snoozedUntil?: Date | null;
}

export async function updateConversation(
  organizationId: string,
  conversationId: string,
  input: UpdateConversationInput,
) {
  const data: Prisma.ConversationUpdateManyMutationInput = { ...input };
  if (input.status === ConversationStatus.RESOLVED) data.resolvedAt = new Date();
  if (input.status === ConversationStatus.OPEN) data.resolvedAt = null;

  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, organizationId },
    data,
  });
  if (result.count === 0) throw new NotFoundError('Conversation');

  const conversation = await getConversation(organizationId, conversationId);
  await emitRealtime(organizationId, RealtimeEvent.CONVERSATION_UPDATED, conversation, {
    conversationId,
  });
  return conversation;
}

export async function assignConversation(
  organizationId: string,
  conversationId: string,
  assigneeId: string | null,
  assignedById: string,
  note?: string,
) {
  const exists = await prisma.conversation.count({ where: { id: conversationId, organizationId } });
  if (!exists) throw new NotFoundError('Conversation');

  if (assigneeId) {
    // The assignee must be a member of *this* organization.
    const member = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: assigneeId } },
      select: { id: true, status: true },
    });
    if (!member || member.status !== 'ACTIVE') {
      throw new ForbiddenError('That user is not an active member of this organization');
    }
  }

  await prisma.$transaction([
    prisma.conversationAssignment.updateMany({
      where: { conversationId, organizationId, isActive: true },
      data: { isActive: false, unassignedAt: new Date() },
    }),
    ...(assigneeId
      ? [
          prisma.conversationAssignment.create({
            data: { organizationId, conversationId, assigneeId, assignedById, note },
          }),
        ]
      : []),
  ]);

  const conversation = await getConversation(organizationId, conversationId);

  await emitRealtime(organizationId, RealtimeEvent.CONVERSATION_ASSIGNED, conversation, {
    conversationId,
  });

  if (assigneeId) {
    const { createNotification } = await import('./notification.service');
    await createNotification({
      organizationId,
      userId: assigneeId,
      type: 'CONVERSATION_ASSIGNED',
      title: `${conversation.contact.displayName} was assigned to you`,
      body: conversation.lastMessagePreview ?? undefined,
      link: `/inbox/${conversationId}`,
    });
  }

  return conversation;
}

export async function setConversationTags(
  organizationId: string,
  conversationId: string,
  tagIds: string[],
) {
  const exists = await prisma.conversation.count({ where: { id: conversationId, organizationId } });
  if (!exists) throw new NotFoundError('Conversation');
  await assertAllBelongToOrg('tag', organizationId, tagIds, 'Tag');

  await prisma.$transaction([
    prisma.conversationTag.deleteMany({ where: { conversationId, organizationId } }),
    prisma.conversationTag.createMany({
      data: tagIds.map((tagId) => ({ organizationId, conversationId, tagId })),
      skipDuplicates: true,
    }),
  ]);

  const conversation = await getConversation(organizationId, conversationId);
  await emitRealtime(organizationId, RealtimeEvent.CONVERSATION_UPDATED, conversation, {
    conversationId,
  });
  return conversation;
}

export async function markConversationRead(organizationId: string, conversationId: string) {
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, organizationId },
    data: { unreadCount: 0 },
  });
  if (result.count === 0) throw new NotFoundError('Conversation');

  await prisma.message.updateMany({
    where: { conversationId, organizationId, direction: MessageDirection.INBOUND, readAt: null },
    data: { readAt: new Date() },
  });

  await emitRealtime(
    organizationId,
    RealtimeEvent.CONVERSATION_UPDATED,
    { id: conversationId, unreadCount: 0 },
    { conversationId },
  );
}

/** Internal notes are visible to the team only and never sent to a channel. */
export async function addInternalNote(
  organizationId: string,
  conversationId: string,
  userId: string,
  body: string,
) {
  const exists = await prisma.conversation.count({ where: { id: conversationId, organizationId } });
  if (!exists) throw new NotFoundError('Conversation');

  const message = await prisma.message.create({
    data: {
      organizationId,
      conversationId,
      platform: Platform.INTERNAL,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.NOTE,
      senderType: SenderType.AGENT,
      isInternal: true,
      body,
      userId,
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
  });

  await emitRealtime(organizationId, RealtimeEvent.MESSAGE_CREATED, message, { conversationId });
  return message;
}

/**
 * Finds the conversation an inbound message belongs to, or opens a new one.
 * Always scoped to the organization owning the receiving social account.
 */
export async function findOrCreateConversation(params: {
  organizationId: string;
  contactId: string;
  platform: Platform;
  socialAccountId?: string | null;
  externalId?: string | null;
}) {
  const existing = await prisma.conversation.findFirst({
    where: {
      organizationId: params.organizationId,
      contactId: params.contactId,
      platform: params.platform,
      ...(params.socialAccountId ? { socialAccountId: params.socialAccountId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    // Reopen a resolved thread when the customer writes again.
    if (existing.status === ConversationStatus.RESOLVED) {
      return prisma.conversation.update({
        where: { id: existing.id },
        data: { status: ConversationStatus.OPEN, resolvedAt: null },
      });
    }
    return existing;
  }

  const conversation = await prisma.conversation.create({
    data: {
      organizationId: params.organizationId,
      contactId: params.contactId,
      platform: params.platform,
      socialAccountId: params.socialAccountId ?? undefined,
      externalId: params.externalId ?? undefined,
      status: ConversationStatus.OPEN,
    },
  });

  const full = await getConversation(params.organizationId, conversation.id);
  await emitRealtime(params.organizationId, RealtimeEvent.CONVERSATION_CREATED, full);

  return conversation;
}

export async function countConversationsByStatus(organizationId: string) {
  const grouped = await prisma.conversation.groupBy({
    by: ['status'],
    where: { organizationId },
    _count: { _all: true },
  });

  const counts: Record<string, number> = { OPEN: 0, PENDING: 0, RESOLVED: 0, SNOOZED: 0 };
  for (const row of grouped) counts[row.status] = row._count._all;

  const [unread, mine] = await Promise.all([
    prisma.conversation.count({ where: { organizationId, unreadCount: { gt: 0 } } }),
    prisma.conversation.count({
      where: { organizationId, assignments: { none: { isActive: true, assigneeId: { not: null } } } },
    }),
  ]);

  return { ...counts, unread, unassigned: mine, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
