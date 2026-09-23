import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { corsOrigins, env } from './config/env';
import { httpLogger, requestId } from './middleware/requestContext';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiLimiter } from './middleware/rateLimit';
import routes from './routes';

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

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin/server-to-server requests send no Origin header.
        if (!origin || corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  app.use(compression());
  app.use(requestId);
  app.use(httpLogger);

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
