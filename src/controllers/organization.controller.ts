import type { Request, Response } from 'express';
import { created, ok } from '../utils/response';
import { UnauthorizedError } from '../utils/errors';
import {
  createOrganization,
  getOrganization,
  listUserOrganizations,
  saveOnboarding,
  switchOrganization,
  updateOrganization,
} from '../services/organization.service';
import { auditFromRequest } from '../services/audit.service';

export async function listOrganizationsController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  return ok(res, await listUserOrganizations(req.auth.userId));
}

export async function createOrganizationController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  const organization = await createOrganization(req.auth.userId, req.body.name, req.body.timezone);
  await auditFromRequest(req, 'organization.created', {
    organizationId: organization.id,
    entityType: 'Organization',
    entityId: organization.id,
  });
  return created(res, organization, 'Workspace created');
}

/**
 * Switching writes to the session, so every later request — REST and socket —
 * resolves the new organization server-side (spec section 7).
 */
export async function switchOrganizationController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  const organization = await switchOrganization(
    req.auth.userId,
    req.auth.sessionId,
    req.body.organizationId,
  );
  await auditFromRequest(req, 'organization.switched', { organizationId: organization.id });
  return ok(res, organization, `Switched to ${organization.name}`);
}

export async function getCurrentOrganizationController(req: Request, res: Response) {
  return ok(res, await getOrganization(req.tenant!.organizationId));
}

export async function updateOrganizationController(req: Request, res: Response) {
  const organization = await updateOrganization(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'organization.updated', {
    entityType: 'Organization',
    entityId: organization.id,
  });
  return ok(res, organization, 'Settings saved');
}

export async function saveOnboardingController(req: Request, res: Response) {
  const organization = await saveOnboarding(req.tenant!.organizationId, req.body);
  if (req.body.complete) await auditFromRequest(req, 'organization.onboarding_completed');
  return ok(res, organization, req.body.complete ? 'Setup complete' : 'Progress saved');
}
