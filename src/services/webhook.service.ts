import { Platform, WebhookEventStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { webhookQueue } from '../queues';
import type { WebhookJob } from '../queues/jobTypes';
import type { MetaWebhookBody } from '../integrations/meta/normalize';

/**
 * Webhook intake (spec section 13).
 *
 * The HTTP handler does three cheap things — persist, dedupe, enqueue — and
 * returns 200 immediately. All matching, normalization, automation and AI work
 * happens in the worker.
 */
export async function ingestMetaWebhook(body: MetaWebhookBody, rawBody: string): Promise<number> {
  const platform = platformFromObject(body.object);
  const entries = body.entry ?? [];
  let queued = 0;

  for (const entry of entries) {
    const eventKey = buildEventKey(entry, rawBody);

    try {
      const event = await prisma.webhookEvent.create({
        data: {
          provider: 'meta',
          platform,
          eventKey,
          objectType: body.object,
          // The entry is stored whole so a failed job can be replayed.
          payload: { object: body.object, entry: [entry] } as never,
          status: WebhookEventStatus.RECEIVED,
        },
        select: { id: true },
      });

      const job: WebhookJob = { webhookEventId: event.id };
      await webhookQueue().add('process-webhook', job, { jobId: `webhook:${event.id}` });
      queued += 1;
    } catch (error) {
      // A unique violation on eventKey means Meta redelivered — that is the
      // idempotency guarantee working, not an error.
      if (isUniqueViolation(error)) {
        logger.debug({ eventKey }, 'duplicate webhook entry ignored');
        continue;
      }
      logger.error({ err: error, eventKey }, 'failed to persist webhook entry');
    }
  }

  return queued;
}

function platformFromObject(object?: string): Platform {
  switch (object) {
    case 'instagram':
      return Platform.INSTAGRAM;
    case 'whatsapp_business_account':
      return Platform.WHATSAPP;
    default:
      return Platform.FACEBOOK;
  }
}

interface EntryLike {
  id?: string;
  time?: number;
  messaging?: Array<{ message?: { mid?: string }; timestamp?: number }>;
  changes?: Array<{ value?: { messages?: Array<{ id?: string }>; statuses?: Array<{ id?: string; status?: string }> } }>;
}

/**
 * Prefers the provider's own message id as the dedupe key. Falls back to a
 * content hash so non-message entries are still deduplicated.
 */
function buildEventKey(entry: EntryLike, rawBody: string): string {
  const ids: string[] = [];

  for (const event of entry.messaging ?? []) {
    if (event.message?.mid) ids.push(event.message.mid);
  }
  for (const change of entry.changes ?? []) {
    for (const msg of change.value?.messages ?? []) if (msg.id) ids.push(msg.id);
    for (const status of change.value?.statuses ?? []) {
      if (status.id) ids.push(`${status.id}:${status.status}`);
    }
  }

  if (ids.length) return `meta:${ids.sort().join('|')}`.slice(0, 500);

  const hash = simpleHash(`${entry.id ?? ''}:${entry.time ?? ''}:${rawBody.length}:${rawBody.slice(0, 2000)}`);
  return `meta:${entry.id ?? 'unknown'}:${entry.time ?? Date.now()}:${hash}`;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

export async function listWebhookEvents(
  organizationId: string,
  params: { page: number; pageSize: number; status?: WebhookEventStatus },
) {
  const where = { organizationId, ...(params.status ? { status: params.status } : {}) };

  const [items, total] = await Promise.all([
    prisma.webhookEvent.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true,
        platform: true,
        objectType: true,
        status: true,
        attempts: true,
        error: true,
        receivedAt: true,
        processedAt: true,
      },
    }),
    prisma.webhookEvent.count({ where }),
  ]);

  return { items, total };
}
