import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/requestContext';
import { validate } from '../middleware/validate';
import { incrementWindow } from '../lib/redis';
import { fail, ok } from '../utils/response';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';
import { isOriginAllowed } from '../utils/domains';
import { issueVisitorToken, verifyVisitorToken } from '../services/widgetToken.service';
import {
  describeVisitor,
  identifyVisitor,
  listVisitorMessages,
  markVisitorRead,
  postVisitorMessage,
  resolvePublicWidget,
  toPublicConfig,
  touchWidgetSeen,
  visitorTyping,
} from '../services/webchat.service';
import { attachVisitorStream, isWidgetHubReady } from '../realtime/widgetHub';

/**
 * Public API for the embeddable website chat widget.
 *
 * Mounted before the dashboard's CORS, compression and rate limiting: it is
 * called from customers' websites (any origin, no cookies), streams SSE, and
 * has limits keyed per widget visitor rather than per dashboard user.
 */
const router = Router();

// --- CORS ------------------------------------------------------------------

router.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin) {
    // Per-widget domain rules are enforced in loadWidget; a refused origin
    // gets a 403 there. No credentials are ever allowed.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

router.use(express.json({ limit: '32kb' }));

// --- rate limiting -------------------------------------------------------------

/** Fixed-window limiter in Redis; fails open if Redis is unreachable. */
function limit(name: string, max: number, windowSeconds: number, by: 'ip' | 'visitor') {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const subject = by === 'visitor' && req.visitor ? req.visitor.vid : req.ip ?? 'unknown';
    const count = await incrementWindow(`rl:widget:${name}:${req.widget?.id ?? 'none'}:${subject}`, windowSeconds);
    if (count !== null && count > max) {
      res.setHeader('Retry-After', String(windowSeconds));
      fail(res, 429, 'Too many requests, please slow down', 'RATE_LIMITED');
      return;
    }
    next();
  });
}

// --- widget + visitor resolution -------------------------------------------

const loadWidget = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const widget = await resolvePublicWidget(req.params.key);
  if (!widget || !widget.isActive) throw new NotFoundError('Chat widget');

  const origin = req.headers.origin;
  if (!isOriginAllowed(origin, widget.allowedDomains)) {
    throw new ForbiddenError('This website is not allowed to use this chat widget', 'ORIGIN_NOT_ALLOWED');
  }

  req.widget = widget;
  void touchWidgetSeen(widget, origin);
  next();
});

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

const requireVisitor = (req: Request, _res: Response, next: NextFunction) => {
  // EventSource cannot send headers, so the stream passes the token in the query.
  const token = bearer(req) ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
  const claims = verifyVisitorToken(token, req.widget!.id);
  if (!claims) return next(new UnauthorizedError('Your chat session has expired', 'VISITOR_TOKEN_INVALID'));
  req.visitor = claims;
  return next();
};

// --- schemas ---------------------------------------------------------------------

const keyParam = z.object({ key: z.string().min(1).max(80) });

const identifySchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(40).regex(/^[+0-9 ()-]*$/, 'Enter a valid phone number').optional(),
});

const sendSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  clientMessageId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  pageUrl: z.string().url().max(1000).optional(),
});

const listSchema = z.object({ since: z.string().datetime().optional() });

// --- routes ------------------------------------------------------------------------

router.get(
  '/:key/config',
  validate({ params: keyParam }),
  loadWidget,
  limit('config', 120, 60, 'ip'),
  (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return ok(res, toPublicConfig(req.widget!));
  },
);

router.post(
  '/:key/session',
  validate({ params: keyParam }),
  loadWidget,
  limit('session', 20, 60, 'ip'),
  asyncHandler(async (req: Request, res: Response) => {
    const widget = req.widget!;
    const existing = verifyVisitorToken(bearer(req), widget.id);
    const { token, visitorId } = existing
      ? { token: bearer(req)!, visitorId: existing.vid }
      : issueVisitorToken(widget.id);

    const visitor = await describeVisitor(widget, visitorId);
    return ok(res, { visitorToken: token, visitorId, ...visitor });
  }),
);

router.post(
  '/:key/identify',
  validate({ params: keyParam, body: identifySchema }),
  loadWidget,
  requireVisitor,
  limit('identify', 10, 60, 'visitor'),
  asyncHandler(async (req: Request, res: Response) => {
    return ok(res, await identifyVisitor(req.widget!, req.visitor!.vid, req.body));
  }),
);

router.get(
  '/:key/messages',
  validate({ params: keyParam, query: listSchema }),
  loadWidget,
  requireVisitor,
  limit('history', 60, 60, 'visitor'),
  asyncHandler(async (req: Request, res: Response) => {
    const { since } = req.query as { since?: string };
    return ok(res, await listVisitorMessages(req.widget!, req.visitor!.vid, since));
  }),
);

router.post(
  '/:key/messages',
  validate({ params: keyParam, body: sendSchema }),
  loadWidget,
  requireVisitor,
  limit('send-ip', 40, 60, 'ip'),
  limit('send', 20, 60, 'visitor'),
  asyncHandler(async (req: Request, res: Response) => {
    const widget = req.widget!;
    const visitor = await describeVisitor(widget, req.visitor!.vid);
    if (visitor.needsPreChat) {
      return fail(res, 400, 'Please introduce yourself before chatting', 'PRE_CHAT_REQUIRED');
    }

    const message = await postVisitorMessage(widget, req.visitor!.vid, {
      ...req.body,
      userAgent: req.headers['user-agent'],
    });
    return ok(res, message);
  }),
);

router.post(
  '/:key/typing',
  validate({ params: keyParam }),
  loadWidget,
  requireVisitor,
  limit('typing', 30, 60, 'visitor'),
  asyncHandler(async (req: Request, res: Response) => {
    await visitorTyping(req.widget!, req.visitor!.vid);
    return res.status(204).end();
  }),
);

router.post(
  '/:key/read',
  validate({ params: keyParam }),
  loadWidget,
  requireVisitor,
  limit('read', 30, 60, 'visitor'),
  asyncHandler(async (req: Request, res: Response) => {
    await markVisitorRead(req.widget!, req.visitor!.vid);
    return res.status(204).end();
  }),
);

router.get(
  '/:key/stream',
  validate({ params: keyParam }),
  loadWidget,
  requireVisitor,
  limit('stream', 10, 60, 'visitor'),
  (req: Request, res: Response) => {
    // Without the Redis bridge a stream would look alive but never deliver
    // anything; refuse it so the widget falls back to polling instead.
    if (!isWidgetHubReady()) {
      return fail(res, 503, 'Live updates are unavailable; polling instead', 'STREAM_UNAVAILABLE');
    }
    attachVisitorStream(req.widget!.id, req.visitor!.vid, res);
    return undefined;
  },
);

export default router;
