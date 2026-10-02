import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { env, isProd } from '../config/env';

/**
 * The two domains this backend serves, kept fully isolated from each other:
 *
 * - repliva.site — production, public, the only domain used with Meta.
 * - the internal testing domain — behind HTTP Basic Auth, never indexed, and
 *   never used with Meta.
 *
 * Every absolute URL the API produces (redirects, links, widget script and
 * logo URLs) comes from getBaseUrl(), so a request on one domain never
 * points at the other.
 */
export const PRODUCTION_HOST = 'repliva.site';
export const INTERNAL_HOST = 'unichat.nuktatechnologies.com';
export const PRODUCTION_ORIGIN = `https://${PRODUCTION_HOST}`;

/** The one Meta OAuth redirect URI registered with the Meta app. */
export const META_CALLBACK_URL = `${PRODUCTION_ORIGIN}/api/integrations/meta/callback`;

const ALLOWED_HOSTS = new Set([PRODUCTION_HOST, INTERNAL_HOST]);
const DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

type HasHeaders = { headers: IncomingHttpHeaders };

function header(req: HasHeaders, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The request's host name, lower-cased, without port. */
export function requestHostname(req: HasHeaders): string {
  // Nginx sets both headers to the visitor's host; the Next.js dev proxy only
  // keeps it in X-Forwarded-Host. Either way the value is checked against the
  // allowlist before it is used.
  const raw = header(req, 'x-forwarded-host') ?? header(req, 'host') ?? '';
  return raw.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

function isDevHost(hostname: string): boolean {
  return !isProd && DEV_HOSTS.has(hostname);
}

/**
 * The public base URL for this request, e.g. "https://repliva.site".
 * Unknown hosts fall back to production. In development, localhost requests
 * use FRONTEND_URL so links point at the Next.js dev server.
 */
export function getBaseUrl(req: HasHeaders): string {
  const hostname = requestHostname(req);
  if (ALLOWED_HOSTS.has(hostname)) return `https://${hostname}`;
  if (isDevHost(hostname)) return env.FRONTEND_URL.replace(/\/$/, '');
  return PRODUCTION_ORIGIN;
}

export function isInternalHost(req: HasHeaders): boolean {
  return requestHostname(req) === INTERNAL_HOST;
}

/** Meta OAuth, callbacks and webhooks only run on production (and locally in development). */
export function isMetaHost(req: HasHeaders): boolean {
  const hostname = requestHostname(req);
  return hostname === PRODUCTION_HOST || isDevHost(hostname);
}

/** Browser origins allowed to call the API with credentials: only the request's own site. */
export function isAllowedOrigin(req: HasHeaders, origin: string | undefined): boolean {
  if (!origin) return true; // same-origin GETs and server-to-server calls send none
  if (origin === getBaseUrl(req)) return true;
  if (!isProd) {
    try {
      return DEV_HOSTS.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/** Product name shown to the request's visitors (e.g. "Powered by …" in the widget). */
export function brandNameFor(req: HasHeaders): string {
  return isInternalHost(req) ? 'Unichat' : 'Repliva';
}

function safeEqual(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * HTTP Basic Auth for the internal domain. Fails closed: without
 * INTERNAL_AUTH_USER and INTERNAL_AUTH_PASS nobody gets in.
 */
export function hasInternalAccess(req: HasHeaders): boolean {
  const user = env.INTERNAL_AUTH_USER;
  const pass = env.INTERNAL_AUTH_PASS;
  if (!user || !pass) return false;

  const auth = header(req, 'authorization') ?? '';
  if (!auth.startsWith('Basic ')) return false;
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  // Evaluate both so the comparison time does not reveal which part failed.
  const userOk = safeEqual(decoded.slice(0, sep), user);
  const passOk = safeEqual(decoded.slice(sep + 1), pass);
  return userOk && passOk;
}

export const INTERNAL_AUTH_CHALLENGE = 'Basic realm="Internal", charset="UTF-8"';
export const NO_INDEX = 'noindex, nofollow';

/**
 * Strips our own origin from a stored URL, leaving a site-relative path such
 * as "/uploads/widgets/x.png". Older rows hold absolute URLs on whichever
 * domain was configured at upload time; relative paths resolve against the
 * domain actually serving the page. Third-party URLs are returned unchanged.
 */
export function toSitePath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const ours = ALLOWED_HOSTS.has(parsed.hostname) || DEV_HOSTS.has(parsed.hostname);
    return ours ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url; // already relative
  }
}
