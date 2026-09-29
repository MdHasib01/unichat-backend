import type { Response } from 'express';
import { createRedisConnection, getRedis } from '../lib/redis';
import { logger } from '../lib/logger';

/**
 * Real-time delivery to website-chat visitors over Server-Sent Events.
 *
 * Any process (API or worker) publishes with `emitToVisitor`; every API
 * process runs one shared Redis subscriber and writes the event to the SSE
 * streams it holds for that visitor. This keeps the widget free of a socket
 * library and works unchanged with several API instances behind a balancer.
 */

export const WIDGET_CHANNEL = 'unichat:widget-events';

export type WidgetEventName = 'message' | 'message:updated' | 'typing' | 'config';

interface WidgetEnvelope {
  widgetId: string;
  /** Omitted for widget-wide events (e.g. config changed). */
  visitorId?: string;
  event: WidgetEventName;
  payload: unknown;
}

const MAX_STREAMS_PER_VISITOR = 3;
const HEARTBEAT_MS = 25_000;

const streams = new Map<string, Set<Response>>();
let subscriber: ReturnType<typeof createRedisConnection> | null = null;
let heartbeat: NodeJS.Timeout | null = null;

const roomKey = (widgetId: string, visitorId: string) => `${widgetId}:${visitorId}`;

export async function emitToVisitor(
  widgetId: string,
  visitorId: string | undefined,
  event: WidgetEventName,
  payload: unknown,
): Promise<void> {
  const envelope: WidgetEnvelope = { widgetId, visitorId, event, payload };

  const redis = getRedis();
  if (redis.status === 'ready') {
    try {
      await redis.publish(WIDGET_CHANNEL, JSON.stringify(envelope));
      return;
    } catch (error) {
      logger.warn({ err: error, event }, 'failed to publish widget event; delivering locally');
    }
  }

  // No Redis: deliver to the streams this process holds (single-process
  // installs and local development). Anything missed is recovered by the
  // widget's history sync.
  try {
    deliver(JSON.parse(JSON.stringify(envelope)) as WidgetEnvelope);
  } catch (error) {
    logger.warn({ err: error, event }, 'failed to deliver widget event locally');
  }
}

function write(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Holds an SSE response open for one visitor until the browser disconnects. */
export function attachVisitorStream(widgetId: string, visitorId: string, res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Nginx must not buffer the stream.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`retry: 3000\n\n`);

  const key = roomKey(widgetId, visitorId);
  let set = streams.get(key);
  if (!set) {
    set = new Set();
    streams.set(key, set);
  }

  // A visitor with many open tabs keeps only the newest few streams.
  if (set.size >= MAX_STREAMS_PER_VISITOR) {
    const oldest = set.values().next().value as Response | undefined;
    if (oldest) {
      set.delete(oldest);
      oldest.end();
    }
  }
  set.add(res);
  write(res, 'ready', { at: new Date().toISOString() });

  res.on('close', () => {
    const current = streams.get(key);
    current?.delete(res);
    if (current && current.size === 0) streams.delete(key);
  });
}

function deliver(envelope: WidgetEnvelope) {
  if (envelope.visitorId) {
    const set = streams.get(roomKey(envelope.widgetId, envelope.visitorId));
    if (!set) return;
    for (const res of set) write(res, envelope.event, envelope.payload);
    return;
  }

  const prefix = `${envelope.widgetId}:`;
  for (const [key, set] of streams) {
    if (!key.startsWith(prefix)) continue;
    for (const res of set) write(res, envelope.event, envelope.payload);
  }
}

/**
 * True when this process can actually push events to visitors: through the
 * Redis bridge, or — with Redis down — directly, because emitToVisitor then
 * delivers in-process.
 */
export function isWidgetHubReady(): boolean {
  return subscriber?.status === 'ready' || getRedis().status !== 'ready';
}

/** Starts the Redis bridge. Called once by the API process. */
export function initWidgetHub(): void {
  if (subscriber) return;

  try {
    subscriber = createRedisConnection();
    subscriber.on('error', (err) => logger.debug({ err: err.message }, 'widget hub subscriber connection'));
    subscriber.subscribe(WIDGET_CHANNEL, (err) => {
      if (err) logger.warn({ err: err.message }, 'failed to subscribe to widget channel');
      else logger.info('widget hub subscribed');
    });
    subscriber.on('message', (_channel, raw) => {
      try {
        deliver(JSON.parse(raw) as WidgetEnvelope);
      } catch (error) {
        logger.warn({ err: error }, 'failed to relay widget event');
      }
    });
  } catch (error) {
    logger.warn({ err: error }, 'failed to initialize widget hub');
  }

  // Comment lines keep proxies from closing idle streams.
  heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

export async function closeWidgetHub(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  for (const set of streams.values()) for (const res of set) res.end();
  streams.clear();
  if (subscriber) {
    await subscriber.quit().catch(() => undefined);
    subscriber = null;
  }
}
