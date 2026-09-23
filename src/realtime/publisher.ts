import { getRedis } from '../lib/redis';
import { logger } from '../lib/logger';
import {
  REALTIME_CHANNEL,
  type RealtimeEnvelope,
  type RealtimeEventName,
} from './events';

/**
 * Workers run in their own process, so real-time events travel over Redis
 * pub/sub and are fanned out to sockets by the API process.
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

  try {
    await getRedis().publish(REALTIME_CHANNEL, JSON.stringify(envelope));
  } catch (error) {
    // A dropped realtime event must never fail the business operation.
    logger.warn({ err: error, event }, 'failed to publish realtime event');
  }
}
