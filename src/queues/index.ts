import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { createRedisConnection } from '../lib/redis';
import { logger } from '../lib/logger';

export const QUEUE_NAMES = {
  WEBHOOK_PROCESSING: 'webhook-processing',
  MESSAGE_PROCESSING: 'message-processing',
  MESSAGE_SENDING: 'message-sending',
  AUTOMATION_PROCESSING: 'automation-processing',
  AI_PROCESSING: 'ai-processing',
  NOTIFICATION_PROCESSING: 'notification-processing',
  ANALYTICS_PROCESSING: 'analytics-processing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600, count: 5_000 },
};

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: createRedisConnection(), defaultJobOptions });
    queue.on('error', (err) => logger.error({ err, queue: name }, 'queue error'));
    queues.set(name, queue);
  }
  return queue;
}

export const webhookQueue = () => getQueue(QUEUE_NAMES.WEBHOOK_PROCESSING);
export const messageQueue = () => getQueue(QUEUE_NAMES.MESSAGE_PROCESSING);
export const sendQueue = () => getQueue(QUEUE_NAMES.MESSAGE_SENDING);
export const automationQueue = () => getQueue(QUEUE_NAMES.AUTOMATION_PROCESSING);
export const aiQueue = () => getQueue(QUEUE_NAMES.AI_PROCESSING);
export const notificationQueue = () => getQueue(QUEUE_NAMES.NOTIFICATION_PROCESSING);
export const analyticsQueue = () => getQueue(QUEUE_NAMES.ANALYTICS_PROCESSING);

export const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES);

export async function queueHealth(): Promise<{
  healthy: boolean;
  queues: Record<string, { waiting: number; active: number; failed: number; delayed: number }>;
}> {
  const result: Record<string, { waiting: number; active: number; failed: number; delayed: number }> = {};
  let healthy = true;

  for (const name of ALL_QUEUE_NAMES) {
    try {
      const q = getQueue(name);
      const counts = await q.getJobCounts('waiting', 'active', 'failed', 'delayed');
      result[name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      };
    } catch (error) {
      healthy = false;
      logger.warn({ err: error, queue: name }, 'queue health check failed');
      result[name] = { waiting: -1, active: -1, failed: -1, delayed: -1 };
    }
  }

  return { healthy, queues: result };
}

export async function closeQueues(): Promise<void> {
  await Promise.all(Array.from(queues.values()).map((q) => q.close().catch(() => undefined)));
  queues.clear();
}

export function createQueueEvents(name: QueueName): QueueEvents {
  return new QueueEvents(name, { connection: createRedisConnection() });
}
