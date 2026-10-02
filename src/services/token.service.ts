import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Response } from 'express';
import { env, isProd } from '../config/env';
import { randomToken, sha256 } from '../utils/crypto';
import { UnauthorizedError } from '../utils/errors';

/**
 * Session cookies are host-only: no Domain attribute, so a sign-in on one
 * domain never carries over to another. In production the __Host- prefix
 * makes the browser enforce that (it rejects such a cookie if it has a
 * Domain, lacks Secure or is not scoped to "/"). Plain HTTP in development
 * cannot use the prefix.
 */
export const ACCESS_COOKIE = isProd ? '__Host-at' : 'at';
export const REFRESH_COOKIE = isProd ? '__Host-rt' : 'rt';

const TOKEN_ISSUER = 'auth';
const TOKEN_AUDIENCE = 'api';

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
  email: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    }) as AccessTokenPayload;
  } catch {
    throw new UnauthorizedError('Session expired, please sign in again', 'TOKEN_INVALID');
  }
}

/**
 * The refresh token is an opaque random string; only its hash is stored, so a
 * database leak cannot be replayed.
 */
export function generateRefreshToken(): { token: string; hash: string; expiresAt: Date } {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, hash: sha256(token), expiresAt };
}

export function hashRefreshToken(token: string): string {
  return sha256(token);
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ('strict' as const) : ('lax' as const),
    path: '/',
  };
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpiresAt: Date) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseCookieOptions(),
    maxAge: 60 * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookieOptions(),
    expires: refreshExpiresAt,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, baseCookieOptions());
  res.clearCookie(REFRESH_COOKIE, baseCookieOptions());
}
