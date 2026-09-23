import { MemberRole, MemberStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { cacheDel } from '../lib/redis';
import { randomToken, sha256 } from '../utils/crypto';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { canManageRole, permissionsForRole } from '../config/permissions';
import { hashPassword } from './auth.service';

export async function listMembers(organizationId: string) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, lastLoginAt: true },
      },
    },
  });

  // Conversation counts give the team screen its activity column.
  const counts = await prisma.conversationAssignment.groupBy({
    by: ['assigneeId'],
    where: { organizationId, isActive: true },
    _count: { _all: true },
  });

  return members.map((m) => ({
    id: m.id,
    role: m.role,
    status: m.status,
    title: m.title,
    createdAt: m.createdAt,
    lastActiveAt: m.lastActiveAt,
    user: m.user,
    permissions: permissionsForRole(m.role),
    activeConversations: counts.find((c) => c.assigneeId === m.user.id)?._count._all ?? 0,
  }));
}

export async function getMember(organizationId: string, memberId: string) {
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          avatarUrl: true,
          phone: true,
          timezone: true,
          lastLoginAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!member) throw new NotFoundError('Team member');

  const [activeConversations, resolved, messagesSent] = await Promise.all([
    prisma.conversationAssignment.count({
      where: { organizationId, assigneeId: member.userId, isActive: true },
    }),
    prisma.conversation.count({
      where: {
        organizationId,
        status: 'RESOLVED',
        assignments: { some: { assigneeId: member.userId } },
      },
    }),
    prisma.message.count({ where: { organizationId, userId: member.userId } }),
  ]);

  return {
    ...member,
    permissions: permissionsForRole(member.role),
    stats: { activeConversations, resolved, messagesSent },
  };
}

export async function inviteMember(
  organizationId: string,
  actorRole: MemberRole,
  actorUserId: string,
  email: string,
  role: MemberRole,
) {
  if (!canManageRole(actorRole, role)) {
    throw new ForbiddenError('You cannot grant a role above your own');
  }

  const normalized = email.toLowerCase().trim();

  const existingUser = await prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true },
  });

  if (existingUser) {
    const alreadyMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: existingUser.id } },
      select: { id: true },
    });
    if (alreadyMember) throw new ConflictError('That person is already on this team', 'ALREADY_MEMBER');
  }

  const token = randomToken(32);

  const invitation = await prisma.invitation.upsert({
    where: { organizationId_email: { organizationId, email: normalized } },
    create: {
      organizationId,
      email: normalized,
      role,
      tokenHash: sha256(token),
      invitedById: actorUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    update: {
      role,
      tokenHash: sha256(token),
      invitedById: actorUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      acceptedAt: null,
      revokedAt: null,
    },
  });

  // The raw token is returned once so the caller can deliver the invite link.
  return { invitation, token };
}

export async function listInvitations(organizationId: string) {
  return prisma.invitation.findMany({
    where: { organizationId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      createdAt: true,
      invitedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

export async function revokeInvitation(organizationId: string, invitationId: string) {
  const result = await prisma.invitation.updateMany({
    where: { id: invitationId, organizationId, acceptedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw new NotFoundError('Invitation');
}

export interface AcceptInvitationInput {
  token: string;
  firstName?: string;
  lastName?: string;
  password?: string;
}

/**
 * Accepting an invitation either links an existing account to the
 * organization or creates the account first.
 */
export async function acceptInvitation(input: AcceptInvitationInput) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(input.token) },
  });

  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
    throw new BadRequestError('This invitation is no longer valid', [], 'INVITATION_INVALID');
  }

  let user = await prisma.user.findUnique({ where: { email: invitation.email } });

  if (!user) {
    if (!input.password || !input.firstName) {
      throw new BadRequestError('Please provide your name and a password to finish signing up', [], 'SIGNUP_REQUIRED');
    }
    user = await prisma.user.create({
      data: {
        email: invitation.email,
        passwordHash: await hashPassword(input.password),
        firstName: input.firstName,
        lastName: input.lastName ?? '',
        emailVerifiedAt: new Date(), // proven by the invitation link
      },
    });
  }

  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } },
    create: {
      organizationId: invitation.organizationId,
      userId: user.id,
      role: invitation.role,
      status: MemberStatus.ACTIVE,
    },
    update: { status: MemberStatus.ACTIVE, role: invitation.role },
  });

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { acceptedAt: new Date() },
  });

  return { userId: user.id, organizationId: invitation.organizationId };
}

export async function updateMemberRole(
  organizationId: string,
  actorRole: MemberRole,
  memberId: string,
  role: MemberRole,
) {
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId },
  });
  if (!member) throw new NotFoundError('Team member');

  if (!canManageRole(actorRole, member.role) || !canManageRole(actorRole, role)) {
    throw new ForbiddenError('You cannot change a role at or above your own');
  }

  // An organization always needs at least one owner.
  if (member.role === MemberRole.OWNER && role !== MemberRole.OWNER) {
    const owners = await prisma.organizationMember.count({
      where: { organizationId, role: MemberRole.OWNER },
    });
    if (owners <= 1) throw new ConflictError('The organization must keep at least one owner', 'LAST_OWNER');
  }

  const updated = await prisma.organizationMember.update({
    where: { id: memberId },
    data: { role },
  });

  await cacheDel(`tenant:${member.userId}:${organizationId}`);
  return updated;
}

export async function updateMemberStatus(
  organizationId: string,
  actorRole: MemberRole,
  memberId: string,
  status: MemberStatus,
) {
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId },
  });
  if (!member) throw new NotFoundError('Team member');
  if (!canManageRole(actorRole, member.role)) {
    throw new ForbiddenError('You cannot change this member');
  }

  const updated = await prisma.organizationMember.update({
    where: { id: memberId },
    data: { status },
  });
  await cacheDel(`tenant:${member.userId}:${organizationId}`);
  return updated;
}

export async function removeMember(
  organizationId: string,
  actorRole: MemberRole,
  actorUserId: string,
  memberId: string,
) {
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId },
  });
  if (!member) throw new NotFoundError('Team member');

  if (member.userId === actorUserId) {
    throw new BadRequestError('You cannot remove yourself from the organization');
  }
  if (!canManageRole(actorRole, member.role)) {
    throw new ForbiddenError('You cannot remove a member at or above your own role');
  }
  if (member.role === MemberRole.OWNER) {
    const owners = await prisma.organizationMember.count({
      where: { organizationId, role: MemberRole.OWNER },
    });
    if (owners <= 1) throw new ConflictError('The organization must keep at least one owner', 'LAST_OWNER');
  }

  // Free up their conversations so nothing is left orphaned.
  await prisma.$transaction([
    prisma.conversationAssignment.updateMany({
      where: { organizationId, assigneeId: member.userId, isActive: true },
      data: { isActive: false, unassignedAt: new Date() },
    }),
    prisma.organizationMember.delete({ where: { id: memberId } }),
    prisma.session.updateMany({
      where: { userId: member.userId, activeOrganizationId: organizationId },
      data: { activeOrganizationId: null },
    }),
  ]);

  await cacheDel(`tenant:${member.userId}:${organizationId}`);
}

/** Assignable agents for the inbox dropdown. */
export async function listAssignableAgents(organizationId: string) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, status: MemberStatus.ACTIVE },
    select: {
      role: true,
      user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return members.map((m) => ({ ...m.user, role: m.role }));
}
