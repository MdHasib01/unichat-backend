import argon2 from 'argon2';
import { MemberRole, MemberStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { cacheDel } from '../lib/redis';
import { logger } from '../lib/logger';
import { randomToken, sha256 } from '../utils/crypto';
import { BadRequestError, ConflictError, UnauthorizedError } from '../utils/errors';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './token.service';
import { seedOrganizationDefaults, slugifyOrganizationName } from './organization.service';

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationName: string;
  timezone?: string;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface AuthResult {
  user: PublicUser;
  organizationId: string | null;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  phone: string | null;
  timezone: string;
  emailVerified: boolean;
  createdAt: Date;
}

export function toPublicUser(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  phone: string | null;
  timezone: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    timezone: user.timezone,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt,
  };
}

/**
 * Registration creates: user → organization → OWNER membership → onboarding
 * defaults (spec section 5).
 */
export async function register(input: RegisterInput, meta: SessionMeta): Promise<AuthResult> {
  const email = input.email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.password);
  const slug = await slugifyOrganizationName(input.organizationName);

  const { user, organization } = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({
      data: {
        email,
        passwordHash,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        timezone: input.timezone ?? 'UTC',
      },
    });

    const createdOrg = await tx.organization.create({
      data: {
        name: input.organizationName.trim(),
        slug,
        timezone: input.timezone ?? 'UTC',
      },
    });

    await tx.organizationMember.create({
      data: {
        organizationId: createdOrg.id,
        userId: createdUser.id,
        role: MemberRole.OWNER,
        status: MemberStatus.ACTIVE,
      },
    });

    return { user: createdUser, organization: createdOrg };
  });

  await seedOrganizationDefaults(organization.id);

  // Email verification architecture: token is issued here; delivery is handled
  // by the notification worker / configured mail provider.
  await issueVerificationToken(user.id, 'EMAIL_VERIFICATION');

  const session = await createSession(user.id, organization.id, meta);

  return {
    user: toPublicUser(user),
    organizationId: organization.id,
    ...session,
  };
}

export async function login(
  email: string,
  password: string,
  meta: SessionMeta,
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  // Constant-ish work regardless of whether the user exists.
  if (!user) {
    await argon2.hash('invalid-placeholder-password', ARGON_OPTIONS).catch(() => undefined);
    throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) throw new UnauthorizedError('This account has been disabled', 'ACCOUNT_DISABLED');

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');

  const membership = await prisma.organizationMember.findFirst({
    where: { userId: user.id, status: MemberStatus.ACTIVE },
    orderBy: { createdAt: 'asc' },
    select: { organizationId: true },
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const session = await createSession(user.id, membership?.organizationId ?? null, meta);

  return {
    user: toPublicUser(user),
    organizationId: membership?.organizationId ?? null,
    ...session,
  };
}

export async function createSession(
  userId: string,
  organizationId: string | null,
  meta: SessionMeta,
): Promise<Omit<AuthResult, 'user' | 'organizationId'>> {
  const { token, hash, expiresAt } = generateRefreshToken();

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hash,
      activeOrganizationId: organizationId,
      userAgent: meta.userAgent?.slice(0, 500),
      ip: meta.ip,
      expiresAt,
    },
    select: { id: true, user: { select: { email: true } } },
  });

  const accessToken = signAccessToken({
    sub: userId,
    sid: session.id,
    email: session.user.email,
  });

  return { accessToken, refreshToken: token, refreshExpiresAt: expiresAt, sessionId: session.id };
}

/** Refresh tokens rotate on every use; a reused token is treated as theft. */
export async function refreshSession(refreshToken: string, meta: SessionMeta): Promise<AuthResult> {
  const hash = hashRefreshToken(refreshToken);

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new UnauthorizedError('Your session has expired, please sign in again', 'REFRESH_INVALID');
  }
  if (!session.user.isActive) throw new UnauthorizedError('This account has been disabled', 'ACCOUNT_DISABLED');

  const next = generateRefreshToken();

  const updated = await prisma.session.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: next.hash,
      expiresAt: next.expiresAt,
      lastUsedAt: new Date(),
      userAgent: meta.userAgent?.slice(0, 500) ?? session.userAgent,
      ip: meta.ip ?? session.ip,
    },
  });

  await cacheDel(`session:${session.id}`);

  const accessToken = signAccessToken({
    sub: session.userId,
    sid: session.id,
    email: session.user.email,
  });

  return {
    user: toPublicUser(session.user),
    organizationId: updated.activeOrganizationId,
    accessToken,
    refreshToken: next.token,
    refreshExpiresAt: next.expiresAt,
    sessionId: session.id,
  };
}

export async function logout(sessionId: string): Promise<void> {
  await prisma.session
    .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
  await cacheDel(`session:${sessionId}`);
}

export async function logoutAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) },
    select: { id: true },
  });
  if (!sessions.length) return 0;

  await prisma.session.updateMany({
    where: { id: { in: sessions.map((s) => s.id) } },
    data: { revokedAt: new Date() },
  });
  await Promise.all(sessions.map((s) => cacheDel(`session:${s.id}`)));
  return sessions.length;
}

export async function listSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: {
      id: true,
      userAgent: true,
      ip: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });
}

// --- verification / password reset ----------------------------------------

export type VerificationType = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export async function issueVerificationToken(
  userId: string,
  type: VerificationType,
  ttlMinutes = type === 'PASSWORD_RESET' ? 60 : 60 * 24,
): Promise<string> {
  const token = randomToken(32);
  await prisma.verificationToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      type,
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
    },
  });
  logger.info({ userId, type }, 'verification token issued');
  return token;
}

export async function consumeVerificationToken(
  token: string,
  type: VerificationType,
): Promise<string> {
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.type !== type || record.usedAt || record.expiresAt < new Date()) {
    throw new BadRequestError('This link is invalid or has expired', [], 'TOKEN_INVALID');
  }
  await prisma.verificationToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });
  return record.userId;
}

export async function requestPasswordReset(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true },
  });
  // Always behave identically so the endpoint cannot enumerate accounts.
  if (!user) return null;
  return issueVerificationToken(user.id, 'PASSWORD_RESET');
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const userId = await consumeVerificationToken(token, 'PASSWORD_RESET');
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await logoutAllSessions(userId);
}

export async function verifyEmail(token: string): Promise<void> {
  const userId = await consumeVerificationToken(token, 'EMAIL_VERIFICATION');
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError();

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) throw new BadRequestError('Your current password is incorrect', [], 'INVALID_PASSWORD');

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  await logoutAllSessions(userId, keepSessionId);
}
