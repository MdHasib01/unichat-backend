import type { NextFunction, Request, Response } from 'express';
import { INTERNAL_AUTH_CHALLENGE, NO_INDEX, hasInternalAccess, isInternalHost, isMetaHost } from '../utils/host';
import { notFoundHandler } from './error';

/**
 * Locks down the internal testing domain: every response carries
 * X-Robots-Tag, robots.txt disallows everything, and all other paths need
 * HTTP Basic Auth. Requests on production pass straight through.
 */
export function internalDomainGuard(req: Request, res: Response, next: NextFunction) {
  if (!isInternalHost(req)) return next();

  res.setHeader('X-Robots-Tag', NO_INDEX);

  if (req.path === '/robots.txt') {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
    return;
  }

  if (!hasInternalAccess(req)) {
    res.setHeader('WWW-Authenticate', INTERNAL_AUTH_CHALLENGE);
    res.status(401).type('text/plain').send('Authentication required');
    return;
  }

  return next();
}

/**
 * Meta OAuth, callbacks and webhooks exist only on production. Anywhere else
 * they answer 404, as if the routes did not exist.
 */
export function metaHostOnly(req: Request, res: Response, next: NextFunction) {
  if (isMetaHost(req)) return next();
  return notFoundHandler(req, res);
}
