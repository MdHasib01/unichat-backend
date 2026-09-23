import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const bool = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_NAME: z.string().default('Unichat'),
  API_URL: z.string().default('http://localhost:4000'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: bool('false'),

  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/unichat?schema=public'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().default(0),
  REDIS_TLS: bool('false'),

  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me-please'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me-please'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // 32-byte key, hex or base64, for AES-256-GCM credential encryption.
  ENCRYPTION_KEY: z.string().default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),

  MOCK_MODE: bool('true'),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().default('unichat-verify-token'),
  META_GRAPH_VERSION: z.string().default('v21.0'),
  META_REDIRECT_URI: z.string().default('http://localhost:4000/api/integrations/meta/callback'),
  META_SCOPES: z
    .string()
    .default(
      'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,instagram_basic,instagram_manage_messages,business_management,whatsapp_business_messaging,whatsapp_business_management',
    ),

  AI_PROVIDER: z.enum(['openai', 'anthropic', 'mock']).default('mock'),
  AI_MODEL: z.string().default('claude-sonnet-5'),
  AI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  RUN_WORKERS_INLINE: bool('false'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(15),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const metaScopes = env.META_SCOPES.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Real Meta traffic requires app credentials. Without them we stay in mock mode
 * so the product is fully usable out of the box (spec section 40).
 */
export const metaConfigured = Boolean(env.META_APP_ID && env.META_APP_SECRET);
export const mockMode = env.MOCK_MODE || !metaConfigured;
