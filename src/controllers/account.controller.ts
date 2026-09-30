import type { Request, Response } from 'express';
import { created, ok } from '../utils/response';
import { UnauthorizedError } from '../utils/errors';
import { auditFromRequest } from '../services/audit.service';
import {
  cancelDeletionRequest,
  createDeletionRequest,
  listDeletionRequests,
} from '../services/dataDeletion.service';

export async function listDeletionRequestsController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();
  return ok(res, await listDeletionRequests(req.auth.userId));
}

export async function createDeletionRequestController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();

  const request = await createDeletionRequest(req.auth, req.body, {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  await auditFromRequest(req, 'account.deletion_requested', {
    organizationId: request.organization?.id ?? null,
    entityType: 'DataDeletionRequest',
    entityId: request.id,
    metadata: { reference: request.reference, scope: request.scope },
  });

  return created(res, request, `Deletion request ${request.reference} received`);
}

export async function cancelDeletionRequestController(req: Request, res: Response) {
  if (!req.auth) throw new UnauthorizedError();

  const request = await cancelDeletionRequest(req.auth.userId, req.params.id);

  await auditFromRequest(req, 'account.deletion_cancelled', {
    organizationId: request.organization?.id ?? null,
    entityType: 'DataDeletionRequest',
    entityId: request.id,
    metadata: { reference: request.reference },
  });

  return ok(res, request, 'Deletion request cancelled');
}
