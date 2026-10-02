import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { env } from './config/env';
import { httpLogger, requestId } from './middleware/requestContext';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiLimiter } from './middleware/rateLimit';
import routes from './routes';
import widgetRoutes from './routes/widget.routes';
import { internalDomainGuard } from './middleware/internalDomain';
import { isAllowedOrigin } from './utils/host';
import { ForbiddenError } from './utils/errors';

export function createApp(): Express {
  const app = express();

  // Behind Nginx on the VPS the real client IP arrives in X-Forwarded-For;
  // rate limiting and audit logs depend on it.
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.disable('x-powered-by');

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false, // the API serves JSON, not HTML
    }),
  );

  app.use(requestId);
  app.use(httpLogger);

  // The internal testing domain sits behind Basic Auth and is never indexed.
  app.use(internalDomainGuard);

  // The website chat widget is called from customers' sites, streams SSE and
  // has its own CORS and limits, so it sits in front of the dashboard stack.
  app.use('/api/widget', widgetRoutes);

  app.use(
    // Only the request's own site may call the API: a page on one domain can
    // never make credentialed calls to the other.
    cors((req, callback) => {
      const origin = req.headers.origin;
      if (!isAllowedOrigin(req, origin)) return callback(new ForbiddenError('Origin not allowed'));
      return callback(null, {
        origin: Boolean(origin),
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
        exposedHeaders: ['X-Request-Id'],
      });
    }),
  );

  app.use(compression());

  app.use(
    express.json({
      limit: '2mb',
      // Meta signs the exact bytes, so the raw body must survive parsing.
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  app.use('/uploads', express.static(path.resolve(process.cwd(), env.UPLOAD_DIR), { maxAge: '7d' }));

  // Liveness probe outside the API prefix for Docker/Nginx.
  app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

  app.use('/api', apiLimiter, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
