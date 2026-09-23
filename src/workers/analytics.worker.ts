import { Worker, type Job } from 'bullmq';
import { ConversationStatus, MessageDirection, SenderType } from '@prisma/client';
import { createRedisConnection } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { QUEUE_NAMES } from '../queues';
import type { AnalyticsJob } from '../queues/jobTypes';

/**
 * Rolls one organization's day into AnalyticsDaily so the Insights screens
 * read pre-aggregated rows instead of scanning the message table
 * (spec sections 31 and 38).
 *
 * Every query is filtered by organizationId — analytics are never combined
 * across tenants.
 */
export function createAnalyticsWorker(): Worker<AnalyticsJob> {
  return new Worker<AnalyticsJob>(
    QUEUE_NAMES.ANALYTICS_PROCESSING,
    async (job: Job<AnalyticsJob>) => {
      const { organizationId } = job.data;
      const day = job.data.date ? new Date(job.data.date) : new Date();
      await rollupDay(organizationId, day);
    },
    { connection: createRedisConnection(), concurrency: 2 },
  );
}

export async function rollupDay(organizationId: string, day: Date): Promise<void> {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const range = { gte: start, lt: end };

  const [conversationsNew, conversationsResolved, inbound, outbound, aiMessages, automationRuns, responses] =
    await Promise.all([
      prisma.conversation.count({ where: { organizationId, createdAt: range } }),
      prisma.conversation.count({
        where: { organizationId, status: ConversationStatus.RESOLVED, resolvedAt: range },
      }),
      prisma.message.count({
        where: { organizationId, direction: MessageDirection.INBOUND, createdAt: range },
      }),
      prisma.message.count({
        where: { organizationId, direction: MessageDirection.OUTBOUND, isInternal: false, createdAt: range },
      }),
      prisma.message.count({
        where: { organizationId, senderType: SenderType.AI, createdAt: range },
      }),
      prisma.automationExecution.count({ where: { organizationId, startedAt: range } }),
      prisma.conversation.aggregate({
        where: { organizationId, createdAt: range, firstResponseSeconds: { not: null } },
        _avg: { firstResponseSeconds: true },
      }),
    ]);

  const avgFirstResponseSeconds = responses._avg.firstResponseSeconds
    ? Math.round(responses._avg.firstResponseSeconds)
    : null;

  await prisma.analyticsDaily.upsert({
    where: {
      organizationId_date_platform: { organizationId, date: start, platform: null as never },
    },
    create: {
      organizationId,
      date: start,
      conversationsNew,
      conversationsResolved,
      messagesInbound: inbound,
      messagesOutbound: outbound,
      aiMessages,
      automationRuns,
      avgFirstResponseSeconds,
    },
    update: {
      conversationsNew,
      conversationsResolved,
      messagesInbound: inbound,
      messagesOutbound: outbound,
      aiMessages,
      automationRuns,
      avgFirstResponseSeconds,
    },
  });
}
