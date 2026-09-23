import { PrismaClient } from '@prisma/client';
import { env, isProd } from '../config/env';
import { logger } from './logger';

declare global {
  // eslint-disable-next-line no-var
  var __unichatPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__unichatPrisma ??
  new PrismaClient({
    log: isProd ? ['warn', 'error'] : ['warn', 'error'],
    datasources: { db: { url: env.DATABASE_URL } },
  });

if (!isProd) global.__unichatPrisma = prisma;

export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'database health check failed');
    return false;
  }
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
