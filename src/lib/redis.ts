import Redis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Redis runs as a private container on the VPS (spec section 14/36).
 * Never expose it publicly; the app always reaches it over the docker network.
 */
export const redisOptions: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  db: env.REDIS_DB,
  tls: env.REDIS_TLS ? {} : undefined,
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
  enableOfflineQueue: false,
  lazyConnect: true,
};

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(redisOptions);
    client.on('error', (err) => logger.error({ err }, 'redis error'));
    client.on('connect', () => logger.debug('redis connected'));
  }
  return client;
}

/** BullMQ needs its own connections; sharing a blocking client breaks it. */
export function createRedisConnection(): Redis {
  const conn = new Redis(redisOptions);
  conn.on('error', (err) => logger.error({ err }, 'redis connection error'));
  return conn;
}

export async function checkRedis(): Promise<boolean> {
  try {
    const redis = getRedis();
    if (redis.status === 'wait') {
      await Promise.race([
        redis.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timeout')), 1500)),
      ]);
    }
    const pong = await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis ping timeout')), 1500)),
    ]);
    return pong === 'PONG';
  } catch (error) {
    logger.error({ err: error }, 'redis health check failed');
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}

// --- small helpers used across services -----------------------------------

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const redis = getRedis();
    if (redis.status !== 'ready') return null;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
  try {
    const redis = getRedis();
    if (redis.status !== 'ready') return;
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // no-op if redis unreachable
  }
}

export async function cacheDel(pattern: string): Promise<void> {
  try {
    const redis = getRedis();
    if (redis.status !== 'ready') return;
    if (!pattern.includes('*')) {
      await redis.del(pattern);
      return;
    }
    const stream = redis.scanStream({ match: pattern, count: 200 });
    const keys: string[] = [];
    for await (const batch of stream) keys.push(...(batch as string[]));
    if (keys.length) await redis.del(...keys);
  } catch {
    // no-op if redis unreachable
  }
}

/**
 * Distributed lock — used to stop two workers double-processing a webhook or
 * double-sending a welcome message.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    const redis = getRedis();
    if (redis.status !== 'ready') {
      return await fn();
    }
    const token = `${process.pid}-${Date.now()}-${Math.random()}`;
    const acquired = await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    if (!acquired) return null;
    try {
      return await fn();
    } finally {
      const current = await redis.get(`lock:${key}`);
      if (current === token) await redis.del(`lock:${key}`);
    }
  } catch {
    return await fn();
  }
}
