import type { Request, Response } from 'express';
import { env, isProd } from '../config/env';
import { created, noContent, ok } from '../utils/response';
import {
  acceptInvitation,
  getMember,
  inviteMember,
  listAssignableAgents,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
  updateMemberStatus,
} from '../services/team.service';
import { auditFromRequest } from '../services/audit.service';
import { notificationQueue } from '../queues';

export async function listMembersController(req: Request, res: Response) {
  return ok(res, await listMembers(req.tenant!.organizationId));
}

export async function listAgentsController(req: Request, res: Response) {
  return ok(res, await listAssignableAgents(req.tenant!.organizationId));
}

export async function getMemberController(req: Request, res: Response) {
  return ok(res, await getMember(req.tenant!.organizationId, req.params.id));
}

export async function inviteMemberController(req: Request, res: Response) {
  const { organizationId, role } = req.tenant!;
  const { invitation, token } = await inviteMember(
    organizationId,
    role,
    req.auth!.userId,
    req.body.email,
    req.body.role,
  );

  const inviteUrl = `${env.FRONTEND_URL}/accept-invitation?token=${token}`;

  await notificationQueue().add('notify', {
    organizationId,
    type: 'SYSTEM',
    title: `${req.body.email} was invited as ${req.body.role}`,
    link: '/team/invitations',
  });

  await auditFromRequest(req, 'team.invited', {
    entityType: 'Invitation',
    entityId: invitation.id,
    metadata: { email: req.body.email, role: req.body.role },
  });

  // The link is returned outside production so the flow works before email
  // delivery is configured.
  return created(
    res,
    { invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt }, ...(isProd ? {} : { inviteUrl }) },
    'Invitation sent',
  );
}

export async function listInvitationsController(req: Request, res: Response) {
  return ok(res, await listInvitations(req.tenant!.organizationId));
}

export async function revokeInvitationController(req: Request, res: Response) {
  await revokeInvitation(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'team.invitation_revoked', {
    entityType: 'Invitation',
    entityId: req.params.id,
  });
  return noContent(res);
}

export async function acceptInvitationController(req: Request, res: Response) {
  const result = await acceptInvitation(req.body);
  return ok(res, result, 'Welcome to the team — please sign in');
}

export async function updateMemberController(req: Request, res: Response) {
  const { organizationId, role } = req.tenant!;

  if (req.body.role) {
    await updateMemberRole(organizationId, role, req.params.id, req.body.role);
  }
  if (req.body.status) {
    await updateMemberStatus(organizationId, role, req.params.id, req.body.status);
  }

  await auditFromRequest(req, 'team.member_updated', {
    entityType: 'OrganizationMember',
    entityId: req.params.id,
    metadata: req.body,
  });

  return ok(res, await getMember(organizationId, req.params.id), 'Team member updated');
}

export async function removeMemberController(req: Request, res: Response) {
  const { organizationId, role } = req.tenant!;
  await removeMember(organizationId, role, req.auth!.userId, req.params.id);
  await auditFromRequest(req, 'team.member_removed', {
    entityType: 'OrganizationMember',
    entityId: req.params.id,
  });
  return noContent(res);
}
