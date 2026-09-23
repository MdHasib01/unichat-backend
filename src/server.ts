import http from 'http';
import { createApp } from './app';
import { env, mockMode } from './config/env';
import { logger } from './lib/logger';
import { checkDatabase, disconnectPrisma } from './lib/prisma';
import { checkRedis, closeRedis } from './lib/redis';
import { closeQueues } from './queues';
import { closeRealtime, initRealtime } from './realtime/socket';
import { startWorkers, stopWorkers } from './workers';

async function bootstrap() {
  const app = createApp();
  const server = http.createServer(app);

  initRealtime(server);

  // Single-process mode for small VPS installs and local development; in
  // Docker the worker runs as its own service (spec sections 34 and 38).
  if (env.RUN_WORKERS_INLINE) startWorkers();

  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  if (!database) logger.error('database is unreachable — the API will keep retrying');
  if (!redis) logger.error('redis is unreachable — queues and caching are degraded');

  server.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        mockMode,
        inlineWorkers: env.RUN_WORKERS_INLINE,
      },
      'Unichat API listening',
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');

    // Stop accepting new connections, then drain.
    server.close(() => logger.info('http server closed'));

    await closeRealtime();
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
