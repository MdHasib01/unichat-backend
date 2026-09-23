import type { NextFunction, Request, Response } from 'express';
import { MemberStatus, type MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ACCESS_COOKIE, verifyAccessToken } from '../services/token.service';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { permissionsForRole, type Permission } from '../config/permissions';
import { cacheGet, cacheSet } from '../lib/redis';
import type { TenantContext } from '../types/express';

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  return cookie ?? null;
}

/**
 * Establishes "who is the user?" — step one of the request pipeline in spec
 * section 49. The session must still be live; revoking a session kills every
 * access token issued for it within the access-token TTL.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError();

    const payload = verifyAccessToken(token);

    const cacheKey = `session:${payload.sid}`;
    let session = await cacheGet<{ id: string; userId: string; revoked: boolean; expiresAt: string }>(cacheKey);

    if (!session) {
      const row = await prisma.session.findUnique({
        where: { id: payload.sid },
        select: { id: true, userId: true, revokedAt: true, expiresAt: true, user: { select: { isActive: true } } },
      });
      if (!row || row.revokedAt || row.expiresAt < new Date() || !row.user.isActive) {
        throw new UnauthorizedError('Session is no longer valid', 'SESSION_INVALID');
      }
      session = {
        id: row.id,
        userId: row.userId,
        revoked: false,
        expiresAt: row.expiresAt.toISOString(),
      };
      await cacheSet(cacheKey, session, 60);
    }

    if (session.userId !== payload.sub) throw new UnauthorizedError('Session mismatch', 'SESSION_INVALID');

    req.auth = { userId: payload.sub, sessionId: payload.sid, email: payload.email };
    next();
  } catch (error) {
    next(error);
  }
}

/** Optional auth — used by endpoints that behave differently when signed in. */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  if (!extractToken(req)) return next();
  return requireAuth(req, res, (err?: unknown) => (err ? next() : next()));
}

/**
 * Establishes "which organization, are they a member, and what may they do?".
 *
 * The organization id is read from the server-side session record — never from
 * a request header, query or body (spec section 4).
 */
export async function requireOrganization(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.auth) throw new UnauthorizedError();

    const session = await prisma.session.findUnique({
      where: { id: req.auth.sessionId },
      select: { activeOrganizationId: true },
    });

    let organizationId = session?.activeOrganizationId ?? null;

    // First request after signup/login: fall back to the user's first membership
    // and pin it to the session so subsequent requests are stable.
    if (!organizationId) {
      const membership = await prisma.organizationMember.findFirst({
        where: { userId: req.auth.userId, status: MemberStatus.ACTIVE },
        orderBy: { createdAt: 'asc' },
        select: { organizationId: true },
      });
      if (!membership) {
        throw new ForbiddenError('You do not belong to any organization yet', 'NO_ORGANIZATION');
      }
      organizationId = membership.organizationId;
      await prisma.session.update({
        where: { id: req.auth.sessionId },
        data: { activeOrganizationId: organizationId },
      });
    }

    const tenant = await loadTenantContext(req.auth.userId, organizationId);
    if (!tenant) throw new ForbiddenError('You are not a member of this organization', 'NOT_A_MEMBER');

    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
}

export async function loadTenantContext(
  userId: string,
  organizationId: string,
): Promise<TenantContext | null> {
  const cacheKey = `tenant:${userId}:${organizationId}`;
  const cached = await cacheGet<TenantContext>(cacheKey);
  if (cached) return cached;

  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: {
      id: true,
      role: true,
      status: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  });

  if (!membership || membership.status !== MemberStatus.ACTIVE) return null;

  const context: TenantContext = {
    organizationId: membership.organization.id,
    organizationName: membership.organization.name,
    organizationSlug: membership.organization.slug,
    memberId: membership.id,
    role: membership.role,
    permissions: permissionsForRole(membership.role),
  };

  await cacheSet(cacheKey, context, 30);
  return context;
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) return next(new ForbiddenError('Organization context missing'));
    const granted = permissions.every((p) => req.tenant!.permissions.includes(p));
    if (!granted) {
      return next(
        new ForbiddenError(
          `Your role (${req.tenant.role}) is missing the required permission: ${permissions.join(', ')}`,
          'MISSING_PERMISSION',
        ),
      );
    }
    return next();
  };
}

export function requireRole(...roles: MemberRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) return next(new ForbiddenError('Organization context missing'));
    if (!roles.includes(req.tenant.role)) {
      return next(new ForbiddenError('Your role cannot perform this action', 'ROLE_NOT_ALLOWED'));
    }
    return next();
  };
}

/** Membership/permission caches must be dropped whenever a role changes. */
export async function invalidateTenantCache(userId: string, organizationId: string) {
  const { cacheDel } = await import('../lib/redis');
  await cacheDel(`tenant:${userId}:${organizationId}`);
}
