import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, type ApiErrorDetail } from '../utils/errors';
import { fail } from '../utils/response';
import { logger } from '../lib/logger';
import { isProd } from '../config/env';

export function notFoundHandler(req: Request, res: Response) {
  return fail(res, 404, `Route ${req.method} ${req.path} does not exist`, 'ROUTE_NOT_FOUND');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.id;

  if (err instanceof ZodError) {
    const details: ApiErrorDetail[] = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', details);
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err, requestId }, err.message);
    else logger.warn({ requestId, code: err.code }, err.message);
    return fail(res, err.statusCode, err.message, err.code, err.details);
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
        return fail(res, 409, `A record with this ${target} already exists`, 'DUPLICATE_RECORD');
      }
      case 'P2025':
        return fail(res, 404, 'The requested record does not exist', 'NOT_FOUND');
      case 'P2003':
        return fail(res, 400, 'Related record does not exist', 'FOREIGN_KEY_VIOLATION');
      default:
        logger.error({ err, requestId }, 'prisma error');
        return fail(res, 500, 'Database request failed', 'DATABASE_ERROR');
    }
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    logger.error({ err, requestId }, 'prisma init error');
    return fail(res, 503, 'Database is unavailable', 'DATABASE_UNAVAILABLE');
  }

  const error = err as Error;
  logger.error({ err: error, requestId }, 'unhandled error');
  return fail(
    res,
    500,
    isProd ? 'Something went wrong' : error?.message || 'Something went wrong',
    'INTERNAL_ERROR',
  );
}
