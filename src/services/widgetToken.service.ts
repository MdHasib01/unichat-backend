import crypto from 'crypto';
import { env } from '../config/env';
import { randomToken, timingSafeEqual } from '../utils/crypto';

/**
 * Website-chat visitor tokens.
 *
 * A visitor has no account, so the token *is* their identity: an HMAC-signed
 * `{ wid, vid, iat }`. It is bound to the widget id rather than its public key,
 * so rotating the key does not log existing visitors out. Nothing is stored
 * server-side until the visitor actually writes a message.
 */

export interface VisitorClaims {
  /** ChatWidget id */
  wid: string;
  /** Visitor id — the WEBCHAT ContactIdentifier externalId */
  vid: string;
  /** Issued at, seconds */
  iat: number;
}

/** Visitor tokens live in localStorage; after a year a fresh one is issued. */
const MAX_AGE_SECONDS = 365 * 24 * 3600;

const secret: Buffer = env.WIDGET_TOKEN_SECRET
  ? Buffer.from(env.WIDGET_TOKEN_SECRET)
  : Buffer.from(
      crypto.hkdfSync('sha256', env.JWT_ACCESS_SECRET, 'unichat', 'widget-visitor-token', 32),
    );

function sign(body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

export function newVisitorId(): string {
  return `v_${randomToken(12)}`;
}

export function issueVisitorToken(widgetId: string, visitorId = newVisitorId()): {
  token: string;
  visitorId: string;
} {
  const claims: VisitorClaims = { wid: widgetId, vid: visitorId, iat: Math.floor(Date.now() / 1000) };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `${body}.${sign(body)}`, visitorId };
}

/** Returns the claims when the token is authentic, unexpired and for this widget. */
export function verifyVisitorToken(token: string | undefined | null, widgetId: string): VisitorClaims | null {
  if (!token || token.length > 512) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  if (!timingSafeEqual(signature, sign(body))) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as VisitorClaims;
    if (claims.wid !== widgetId || typeof claims.vid !== 'string' || !claims.vid.startsWith('v_')) return null;
    if (typeof claims.iat !== 'number' || Date.now() / 1000 - claims.iat > MAX_AGE_SECONDS) return null;
    return claims;
  } catch {
    return null;
  }
}
