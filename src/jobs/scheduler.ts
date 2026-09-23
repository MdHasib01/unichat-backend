import { AutomationTriggerType, ConversationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { withLock } from '../lib/redis';
import { analyticsQueue, automationQueue } from '../queues';
import type { AnalyticsJob, AutomationJob } from '../queues/jobTypes';

/**
 * Recurring work that nothing else triggers.
 *
 * Two things need a clock rather than an event:
 *   - the daily analytics rollup, so Insights reads pre-aggregated rows;
 *   - the CONVERSATION_IDLE automation trigger, which by definition fires
 *     because *nothing* happened.
 *
 * Every tick takes a distributed lock, so running several worker containers
 * does not schedule the same work more than once.
 */

const ANALYTICS_INTERVAL_MS = 15 * 60 * 1000;
const IDLE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

let timers: NodeJS.Timeout[] = [];

export function startScheduler(): void {
  if (timers.length) return;

  timers = [
    setInterval(() => void safely('analytics rollup', scheduleAnalyticsRollups), ANALYTICS_INTERVAL_MS),
    setInterval(() => void safely('idle scan', scanIdleConversations), IDLE_SCAN_INTERVAL_MS),
  ];

  // Prevent the timers from holding the process open during shutdown.
  for (const timer of timers) timer.unref();

  logger.info('recurring job scheduler started');
}

export function stopScheduler(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}

async function safely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error({ err: error, job: label }, 'scheduled job failed');
  }
}

/** Queues today's rollup for every organization that saw activity. */
export async function scheduleAnalyticsRollups(): Promise<void> {
  await withLock('scheduler:analytics', 5 * 60 * 1000, async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const active = await prisma.organization.findMany({
      where: {
        OR: [
          { messages: { some: { createdAt: { gte: since } } } },
          { conversations: { some: { updatedAt: { gte: since } } } },
        ],
      },
      select: { id: true },
    });

    const date = new Date().toISOString().slice(0, 10);

    for (const organization of active) {
      const job: AnalyticsJob = { organizationId: organization.id, kind: 'rollup_day', date };
      await analyticsQueue().add('rollup', job, {
        // One rollup per organization per day, however often we tick.
        jobId: `rollup:${organization.id}:${date}`,
      });
    }

    if (active.length) logger.debug({ count: active.length }, 'queued analytics rollups');
  });
}

/**
 * Fires CONVERSATION_IDLE automations for conversations that have gone quiet
 * for longer than each rule's configured window.
 */
export async function scanIdleConversations(): Promise<void> {
  await withLock('scheduler:idle-scan', 4 * 60 * 1000, async () => {
    const triggers = await prisma.automationTrigger.findMany({
      where: {
        type: AutomationTriggerType.CONVERSATION_IDLE,
        automation: { isActive: true },
      },
      select: { organizationId: true, automationId: true, config: true },
    });

    if (!triggers.length) return;

    for (const trigger of triggers) {
      const config = (trigger.config ?? {}) as { idleMinutes?: number };
      const idleMinutes = Math.max(1, config.idleMinutes ?? 60);
      const cutoff = new Date(Date.now() - idleMinutes * 60 * 1000);

      const conversations = await prisma.conversation.findMany({
        where: {
          organizationId: trigger.organizationId,
          status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
          lastMessageAt: { lt: cutoff },
          // Only chase threads where the customer spoke last.
          lastInboundAt: { not: null },
          // Skip anything this automation already handled.
          automationExecutions: { none: { automationId: trigger.automationId } },
        },
        select: { id: true, contactId: true },
        take: 200,
      });

      for (const conversation of conversations) {
        const job: AutomationJob = {
          organizationId: trigger.organizationId,
          conversationId: conversation.id,
          contactId: conversation.contactId,
          triggerType: AutomationTriggerType.CONVERSATION_IDLE,
        };
        await automationQueue().add('run-automation', job, {
          jobId: `idle:${trigger.automationId}:${conversation.id}`,
        });
      }

      if (conversations.length) {
        logger.debug(
          { automationId: trigger.automationId, count: conversations.length },
          'queued idle-conversation automations',
        );
      }
    }
  });
}
