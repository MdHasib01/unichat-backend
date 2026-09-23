import type { Worker } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { disconnectPrisma } from '../lib/prisma';
import { closeRedis } from '../lib/redis';
import { closeQueues } from '../queues';
import { createWebhookWorker } from './webhook.worker';
import { createMessageWorker, createSendWorker } from './message.worker';
import { createAutomationWorker } from './automation.worker';
import { createAIWorker } from './ai.worker';
import { createNotificationWorker } from './notification.worker';
import { createAnalyticsWorker } from './analytics.worker';

let workers: Worker[] = [];

export function startWorkers(): Worker[] {
  if (workers.length) return workers;

  workers = [
    createWebhookWorker(),
    createMessageWorker(),
    createSendWorker(),
    createAutomationWorker(),
    createAIWorker(),
    createNotificationWorker(),
    createAnalyticsWorker(),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, err) =>
      logger.error(
        { queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err },
        'job failed',
      ),
    );
    worker.on('completed', (job) => logger.debug({ queue: worker.name, jobId: job.id }, 'job completed'));
    worker.on('error', (err) => logger.error({ queue: worker.name, err }, 'worker error'));
  }

  logger.info({ count: workers.length, concurrency: env.WORKER_CONCURRENCY }, 'workers started');
  return workers;
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
  workers = [];
}

/**
 * Entry point for the dedicated worker container. The API process can also run
 * workers inline (RUN_WORKERS_INLINE=true) for single-process development.
 */
async function main() {
  startWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down workers');
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection in worker'));
}

if (require.main === module) {
  void main();
}
