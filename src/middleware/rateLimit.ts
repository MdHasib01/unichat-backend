import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type { Request } from 'express';
import { env } from '../config/env';
import { getRedis } from '../lib/redis';
import { fail } from '../utils/response';

function build(prefix: string, windowMs: number, max: number, keyGenerator?: Options['keyGenerator']) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (_req, res) =>
      fail(res, 429, 'Too many requests, please slow down and try again shortly', 'RATE_LIMITED'),
  });
}

/** Per-IP guard on the whole API surface. */
export const apiLimiter = build('api', env.RATE_LIMIT_WINDOW_MS, env.RATE_LIMIT_MAX);

/** Stricter guard on credential endpoints to blunt brute-force attempts. */
export const authLimiter = build('auth', 15 * 60 * 1000, env.AUTH_RATE_LIMIT_MAX);

/** Per-organization guard on outbound sending. */
export const sendLimiter = build('send', 60 * 1000, 120, (req: Request) =>
  req.tenant?.organizationId ?? req.ip ?? 'unknown',
);

/** AI endpoints are expensive; keep them tighter. */
export const aiLimiter = build('ai', 60 * 1000, 30, (req: Request) =>
  req.tenant?.organizationId ?? req.ip ?? 'unknown',
);
