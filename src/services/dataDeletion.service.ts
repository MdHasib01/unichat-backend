import crypto from 'node:crypto';
import { DataDeletionScope, DataDeletionStatus, MemberRole, MemberStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';

/**
 * Self-service deletion *requests*. Nothing is deleted here — the request is
 * recorded, shown back to the user with a reference code, and processed by
 * staff (docs/meta-app-review.md, "Processing deletion requests").
 */

const OPEN_STATUSES = [DataDeletionStatus.PENDING, DataDeletionStatus.IN_PROGRESS];

/** Roles allowed to request each scope in the active workspace. */
const SCOPE_ROLES: Record<DataDeletionScope, MemberRole[] | null> = {
  // Any user may ask for their own account to be deleted.
  [DataDeletionScope.ACCOUNT]: null,
  [DataDeletionScope.WORKSPACE]: [MemberRole.OWNER],
  [DataDeletionScope.CONNECTED_DATA]: [MemberRole.OWNER, MemberRole.ADMIN],
};

// No 0/O/1/I so the code survives being read out over the phone or retyped.
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newReference(): string {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  return `DEL-${code}`;
}

const publicSelect = {
  id: true,
  reference: true,
  scope: true,
  status: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  organization: { select: { id: true, name: true } },
} as const;

export async function listDeletionRequests(userId: string) {
  return prisma.dataDeletionRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: publicSelect,
  });
}

export async function createDeletionRequest(
  auth: { userId: string; sessionId: string; email: string },
  input: { scope: DataDeletionScope; reason?: string | null },
  meta: { ip?: string; userAgent?: string },
) {
  const open = await prisma.dataDeletionRequest.findFirst({
    where: { userId: auth.userId, status: { in: OPEN_STATUSES } },
    select: { reference: true },
  });
  if (open) {
    throw new ConflictError(
      `You already have an open deletion request (${open.reference}). Cancel it first to submit a different one.`,
      'DELETION_REQUEST_OPEN',
    );
  }

  // The workspace comes from the server-side session, never from the body.
  const session = await prisma.session.findUnique({
    where: { id: auth.sessionId },
    select: { activeOrganizationId: true },
  });
  const organizationId = session?.activeOrganizationId ?? null;

  const allowedRoles = SCOPE_ROLES[input.scope];
  if (allowedRoles) {
    const membership = organizationId
      ? await prisma.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId, userId: auth.userId } },
          select: { role: true, status: true },
        })
      : null;
    if (!membership || membership.status !== MemberStatus.ACTIVE || !allowedRoles.includes(membership.role)) {
      throw new ForbiddenError(
        input.scope === DataDeletionScope.WORKSPACE
          ? 'Only the workspace owner can request deletion of the whole workspace'
          : 'Only a workspace owner or admin can request deletion of synchronized messaging data',
      );
    }
  }

  return prisma.dataDeletionRequest.create({
    data: {
      reference: newReference(),
      userId: auth.userId,
      email: auth.email,
      organizationId,
      scope: input.scope,
      reason: input.reason?.trim() || null,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
    select: publicSelect,
  });
}

export async function cancelDeletionRequest(userId: string, requestId: string) {
  const request = await prisma.dataDeletionRequest.findFirst({
    where: { id: requestId, userId },
    select: { id: true, status: true },
  });
  if (!request) throw new NotFoundError('Deletion request');

  // Once staff have started, stopping half-way would leave data in an
  // inconsistent state — the user has to contact support instead.
  if (request.status !== DataDeletionStatus.PENDING) {
    throw new ConflictError('This request is already being processed and can no longer be cancelled', 'DELETION_REQUEST_LOCKED');
  }

  return prisma.dataDeletionRequest.update({
    where: { id: request.id },
    data: { status: DataDeletionStatus.CANCELLED },
    select: publicSelect,
  });
}
