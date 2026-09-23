import { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { emitRealtime } from '../realtime/publisher';
import { RealtimeEvent } from '../realtime/events';
import { NotFoundError } from '../utils/errors';

export interface CreateNotificationInput {
  organizationId: string;
  userId?: string | null;
  type: keyof typeof NotificationType | NotificationType;
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export async function createNotification(input: CreateNotificationInput) {
  const notification = await prisma.notification.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      type: input.type as NotificationType,
      title: input.title,
      body: input.body,
      link: input.link,
      metadata: (input.metadata ?? undefined) as never,
    },
  });

  await emitRealtime(input.organizationId, RealtimeEvent.NOTIFICATION_CREATED, notification, {
    userId: input.userId ?? undefined,
  });

  return notification;
}

/** Fans a notification out to every member holding a given role. */
export async function notifyOrganization(
  organizationId: string,
  input: Omit<CreateNotificationInput, 'organizationId' | 'userId'>,
  roles?: Array<'OWNER' | 'ADMIN' | 'MANAGER' | 'AGENT'>,
) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, status: 'ACTIVE', ...(roles ? { role: { in: roles } } : {}) },
    select: { userId: true },
  });

  await Promise.all(
    members.map((m) => createNotification({ ...input, organizationId, userId: m.userId })),
  );
}

export async function listNotifications(
  organizationId: string,
  userId: string,
  params: { page: number; pageSize: number; unreadOnly?: boolean },
) {
  const where: Prisma.NotificationWhereInput = {
    organizationId,
    OR: [{ userId }, { userId: null }],
    ...(params.unreadOnly ? { readAt: null } : {}),
  };

  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: { organizationId, OR: [{ userId }, { userId: null }], readAt: null },
    }),
  ]);

  return { items, total, unread };
}

export async function markNotificationRead(
  organizationId: string,
  userId: string,
  notificationId: string,
) {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, organizationId, OR: [{ userId }, { userId: null }] },
    data: { readAt: new Date() },
  });
  if (result.count === 0) throw new NotFoundError('Notification');
}

export async function markAllNotificationsRead(organizationId: string, userId: string) {
  const result = await prisma.notification.updateMany({
    where: { organizationId, OR: [{ userId }, { userId: null }], readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}
