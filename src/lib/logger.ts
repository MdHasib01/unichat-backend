import pino from 'pino';
import { env, isProd } from '../config/env';

/**
 * Secrets must never reach the logs (spec section 33).
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'accessToken',
  '*.accessToken',
  'access_token',
  '*.access_token',
  'accessTokenEnc',
  '*.accessTokenEnc',
  'refreshToken',
  '*.refreshToken',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'token',
  '*.token',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'unichat-api', env: env.NODE_ENV },
  transport: isProd
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
});

export type Logger = typeof logger;
