import http from 'http';
import { createApp } from './app';
import { env, isProd, mockMode } from './config/env';
import { logger } from './lib/logger';
import { checkDatabase, disconnectPrisma } from './lib/prisma';
import { checkRedis, closeRedis } from './lib/redis';
import { closeQueues } from './queues';
import { closeRealtime, initRealtime } from './realtime/socket';
import { closeWidgetHub, initWidgetHub } from './realtime/widgetHub';
import { startWorkers, stopWorkers } from './workers';

async function bootstrap() {
  const app = createApp();
  const server = http.createServer(app);

  initRealtime(server);
  initWidgetHub();

  // Single-process mode for small VPS installs and local development; in
  // Docker the worker runs as its own service (spec sections 34 and 38).
  if (env.RUN_WORKERS_INLINE) startWorkers();

  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  if (!database) logger.error('database is unreachable — the API will keep retrying');
  if (!redis) logger.error('redis is unreachable — queues and caching are degraded');

  // Mock mode switches itself on when Meta credentials are missing. In
  // production that would show Meta's reviewers demo channels instead of the
  // real integration, so make it impossible to miss in the logs.
  if (isProd && mockMode) {
    logger.error(
      {
        MOCK_MODE: env.MOCK_MODE,
        META_APP_ID: Boolean(env.META_APP_ID),
        META_APP_SECRET: Boolean(env.META_APP_SECRET),
      },
      'running in MOCK MODE in production — set MOCK_MODE=false, META_APP_ID and META_APP_SECRET for real Meta channels',
    );
  }

  server.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        mockMode,
        inlineWorkers: env.RUN_WORKERS_INLINE,
      },
      'Repliva API listening',
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');

    // Stop accepting new connections, then drain.
    server.close(() => logger.info('http server closed'));

    await closeRealtime();
    await closeWidgetHub();
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await disconnectPrisma();

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

void bootstrap();
