import type { NextFunction, Request, Response } from 'express';
import type { AnyZodObject, ZodTypeAny } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and *replaces* the request parts with the parsed output, so
 * controllers only ever read sanitized, typed values.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const validateBody = (schema: AnyZodObject | ZodTypeAny) => validate({ body: schema });
export const validateQuery = (schema: AnyZodObject | ZodTypeAny) => validate({ query: schema });
export const validateParams = (schema: AnyZodObject | ZodTypeAny) => validate({ params: schema });
