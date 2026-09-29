import { getRedis } from '../lib/redis';
import { logger } from '../lib/logger';
import {
  REALTIME_CHANNEL,
  type RealtimeEnvelope,
  type RealtimeEventName,
} from './events';

type LocalSink = (envelope: RealtimeEnvelope) => void;

let localSink: LocalSink | null = null;

/**
 * Registered by the Socket.IO server in the API process. Used when Redis is
 * unavailable, so a single-process install (and local development) still
 * updates open dashboards live.
 */
export function setLocalRealtimeSink(sink: LocalSink | null): void {
  localSink = sink;
}

/**
 * Workers run in their own process, so real-time events travel over Redis
 * pub/sub and are fanned out to sockets by the API process. When Redis is
 * down, events are delivered straight to the sockets this process holds —
 * which covers everything when workers run inline (RUN_WORKERS_INLINE).
 */
export async function emitRealtime<T>(
  organizationId: string,
  event: RealtimeEventName,
  payload: T,
  options: { conversationId?: string; userId?: string } = {},
): Promise<void> {
  const envelope: RealtimeEnvelope<T> = {
    organizationId,
    event,
    payload,
    conversationId: options.conversationId,
    userId: options.userId,
    emittedAt: new Date().toISOString(),
  };

  const redis = getRedis();
  if (redis.status === 'ready') {
    try {
      await redis.publish(REALTIME_CHANNEL, JSON.stringify(envelope));
      return;
    } catch (error) {
      logger.warn({ err: error, event }, 'failed to publish realtime event; delivering locally');
    }
  }

  try {
    // Round-trip through JSON so local delivery sends exactly what the Redis
    // bridge would (dates as strings, no class instances).
    localSink?.(JSON.parse(JSON.stringify(envelope)) as RealtimeEnvelope);
  } catch (error) {
    // A dropped realtime event must never fail the business operation.
    logger.warn({ err: error, event }, 'failed to deliver realtime event locally');
  }
}
