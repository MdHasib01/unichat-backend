import { Worker, type Job } from 'bullmq';
import type { NotificationType } from '@prisma/client';
import { env } from '../config/env';
import { createRedisConnection } from '../lib/redis';
import { QUEUE_NAMES } from '../queues';
import type { NotificationJob } from '../queues/jobTypes';
import { createNotification, notifyOrganization } from '../services/notification.service';

export function createNotificationWorker(): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    QUEUE_NAMES.NOTIFICATION_PROCESSING,
    async (job: Job<NotificationJob>) => {
      const { organizationId, userIds, type, title, body, link, metadata } = job.data;

      if (userIds?.length) {
        await Promise.all(
          userIds.map((userId) =>
            createNotification({
              organizationId,
              userId,
              type: type as NotificationType,
              title,
              body,
              link,
              metadata,
            }),
          ),
        );
        return;
      }

      // Unassigned conversations are everyone's problem, so the whole team
      // hears about them.
      await notifyOrganization(organizationId, {
        type: type as NotificationType,
        title,
        body,
        link,
        metadata,
      });
    },
    { connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY },
  );
}
