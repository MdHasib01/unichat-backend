import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { env, isProd } from '../config/env';
import { created, ok } from '../utils/response';
import { UnauthorizedError } from '../utils/errors';
import {
  changePassword,
  listSessions,
  login,
  logout,
  logoutAllSessions,
  refreshSession,
  register,
  requestPasswordReset,
  resetPassword,
  toPublicUser,
  verifyEmail,
} from '../services/auth.service';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from '../services/token.service';
import { listUserOrganizations } from '../services/organization.service';
import { auditFromRequest } from '../services/audit.service';
import { permissionsForRole } from '../config/permissions';

function sessionMeta(req: Request) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

export async function registerController(req: Request, res: Response) {
  const result = await register(req.body, sessionMeta(req));

  setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);

  await auditFromRequest(req, 'auth.register', {
    organizationId: result.organizationId,
    userId: result.user.id,
    entityType: 'User',
    entityId: result.user.id,
  });

  return created(
    res,
    {
      user: result.user,
      organizationId: result.organizationId,
      accessToken: result.accessToken,
    },
    'Your workspace is ready',
  );
}

export async function loginController(req: Request, res: Response) {
  const result = await login(req.body.email, req.body.password, sessionMeta(req));

  setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);

  await auditFromRequest(req, 'auth.login', {
    organizationId: result.organizationId,
    userId: result.user.id,
  });

  return ok(
    res,
    { user: result.user, organizationId: result.organizationId, accessToken: result.accessToken },
    'Signed in',
  );
}

export async function refreshController(req: Request, res: Response) {
  const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
  if (!token) throw new UnauthorizedError('No refresh token supplied', 'REFRESH_MISSING');

  const result = await refreshSession(token, sessionMeta(req));
  setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);

  return ok(
    res,
    { user: result.user, organizationId: result.organizationId, accessToken: result.accessToken },
    'Session refreshed',
  );
}

export async function logoutController(req: Request, res: Response) {
  if (req.auth) {
    await logout(req.auth.sessionId);
    await auditFromRequest(req, 'auth.logout');
  }
  clearAuthCookies(res);
  return ok(res, { loggedOut: true }, 'Signed out');
}

export async function logoutAllController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  const count = await logoutAllSessions(req.auth.userId);
  clearAuthCookies(res);
  await auditFromRequest(req, 'auth.logout_all', { metadata: { count } });
  return ok(res, { revoked: count }, 'All sessions signed out');
}

/**
 * The single endpoint the frontend calls on boot: identity, the active
 * organization, the membership role and the resolved permission list.
 */
export async function meController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();

  const [user, organizations, session] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: req.auth.userId } }),
    listUserOrganizations(req.auth.userId),
    prisma.session.findUnique({
      where: { id: req.auth.sessionId },
      select: { activeOrganizationId: true },
    }),
  ]);

  const activeId = session?.activeOrganizationId ?? organizations[0]?.id ?? null;
  const active = organizations.find((o) => o.id === activeId) ?? organizations[0] ?? null;

  const organization = active
    ? await prisma.organization.findUnique({
        where: { id: active.id },
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          industry: true,
          website: true,
          description: true,
          timezone: true,
          currency: true,
          businessHours: true,
          onboardingStep: true,
          onboardingComplete: true,
        },
      })
    : null;

  return ok(res, {
    user: toPublicUser(user),
    organizations,
    organization,
    role: active?.role ?? null,
    permissions: active ? permissionsForRole(active.role) : [],
    mockMode: env.MOCK_MODE,
  });
}

export async function forgotPasswordController(req: Request, res: Response) {
  const token = await requestPasswordReset(req.body.email);

  // Outside production the token is returned so the flow is testable without
  // an SMTP server wired up.
  return ok(
    res,
    isProd ? {} : { resetToken: token, resetUrl: token ? `${env.FRONTEND_URL}/reset-password?token=${token}` : null },
    'If that email is registered, a reset link is on its way',
  );
}

export async function resetPasswordController(req: Request, res: Response) {
  await resetPassword(req.body.token, req.body.password);
  clearAuthCookies(res);
  return ok(res, { reset: true }, 'Password updated — please sign in');
}

export async function verifyEmailController(req: Request, res: Response) {
  await verifyEmail(req.body.token);
  return ok(res, { verified: true }, 'Email verified');
}

export async function changePasswordController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  await changePassword(
    req.auth.userId,
    req.body.currentPassword,
    req.body.newPassword,
    req.auth.sessionId,
  );
  await auditFromRequest(req, 'auth.password_changed');
  return ok(res, { changed: true }, 'Password updated');
}

export async function updateProfileController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  const user = await prisma.user.update({ where: { id: req.auth.userId }, data: req.body });
  await auditFromRequest(req, 'user.profile_updated');
  return ok(res, toPublicUser(user), 'Profile updated');
}

export async function listSessionsController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  const sessions = await listSessions(req.auth.userId);
  return ok(
    res,
    sessions.map((s) => ({ ...s, current: s.id === req.auth!.sessionId })),
  );
}

export async function revokeSessionController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  const { id } = req.params;

  // Only your own sessions can be revoked.
  const session = await prisma.session.findFirst({
    where: { id, userId: req.auth.userId },
    select: { id: true },
  });
  if (!session) throw new UnauthorizedError('Session not found', 'SESSION_NOT_FOUND');

  await logout(session.id);
  if (session.id === req.auth.sessionId) clearAuthCookies(res);

  return ok(res, { revoked: true }, 'Session signed out');
}
