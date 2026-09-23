import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../utils/response';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listExecutions,
  toggleAutomation,
  updateAutomation,
} from '../services/automation.service';
import { auditFromRequest } from '../services/audit.service';

export async function listAutomationsController(req: Request, res: Response) {
  return ok(res, await listAutomations(req.tenant!.organizationId));
}

export async function getAutomationController(req: Request, res: Response) {
  return ok(res, await getAutomation(req.tenant!.organizationId, req.params.id));
}

export async function createAutomationController(req: Request, res: Response) {
  const automation = await createAutomation(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'automation.created', {
    entityType: 'Automation',
    entityId: automation.id,
  });
  return created(res, automation, 'Automation created');
}

export async function updateAutomationController(req: Request, res: Response) {
  const automation = await updateAutomation(req.tenant!.organizationId, req.params.id, req.body);
  await auditFromRequest(req, 'automation.updated', {
    entityType: 'Automation',
    entityId: req.params.id,
  });
  return ok(res, automation, 'Automation updated');
}

export async function toggleAutomationController(req: Request, res: Response) {
  const automation = await toggleAutomation(
    req.tenant!.organizationId,
    req.params.id,
    req.body.isActive,
  );
  return ok(res, automation, req.body.isActive ? 'Automation switched on' : 'Automation paused');
}

export async function deleteAutomationController(req: Request, res: Response) {
  await deleteAutomation(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'automation.deleted', {
    entityType: 'Automation',
    entityId: req.params.id,
  });
  return noContent(res);
}

export async function listExecutionsController(req: Request, res: Response) {
  const query = req.query as unknown as { page: number; pageSize: number; automationId?: string };
  const { items, total } = await listExecutions(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}
