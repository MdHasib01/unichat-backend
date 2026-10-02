import type { Request, Response } from 'express';
import { getBaseUrl, toSitePath } from '../utils/host';
import { created, noContent, ok } from '../utils/response';
import { saveImage } from '../middleware/upload';
import { auditFromRequest } from '../services/audit.service';
import {
  createWidget,
  deleteWidget,
  getWidget,
  listWidgets,
  rotateWidgetKey,
  updateWidget,
} from '../services/webchat.service';

/**
 * Adds the embed snippet. The script is served by the domain the business is
 * using right now, so the snippet never points at another domain.
 */
function snippetFor(req: Request) {
  const scriptUrl = `${getBaseUrl(req)}/widget/v1.js`;
  return <T extends { publicKey: string; logoUrl?: string | null }>(widget: T) => ({
    ...widget,
    logoUrl: toSitePath(widget.logoUrl),
    scriptUrl,
    snippet: `<script async src="${scriptUrl}" data-widget-key="${widget.publicKey}"></script>`,
  });
}

export async function listWidgetsController(req: Request, res: Response) {
  const widgets = await listWidgets(req.tenant!.organizationId);
  return ok(res, widgets.map(snippetFor(req)));
}

export async function getWidgetController(req: Request, res: Response) {
  return ok(res, snippetFor(req)(await getWidget(req.tenant!.organizationId, req.params.id)));
}

export async function createWidgetController(req: Request, res: Response) {
  const widget = await createWidget(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'webchat.widget_created', { entityType: 'ChatWidget', entityId: widget.id });
  return created(res, snippetFor(req)(widget), 'Website chat created — add the snippet to your site');
}

export async function updateWidgetController(req: Request, res: Response) {
  const widget = await updateWidget(req.tenant!.organizationId, req.params.id, req.body);
  await auditFromRequest(req, 'webchat.widget_updated', {
    entityType: 'ChatWidget',
    entityId: widget.id,
    metadata: req.body,
  });
  return ok(res, snippetFor(req)(widget), 'Website chat saved');
}

export async function rotateWidgetKeyController(req: Request, res: Response) {
  const widget = await rotateWidgetKey(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'webchat.widget_key_rotated', { entityType: 'ChatWidget', entityId: widget.id });
  return ok(res, snippetFor(req)(widget), 'New key issued — update the snippet on your website');
}

export async function deleteWidgetController(req: Request, res: Response) {
  await deleteWidget(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'webchat.widget_deleted', { entityType: 'ChatWidget', entityId: req.params.id });
  return noContent(res);
}

export async function uploadWidgetLogoController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  await getWidget(organizationId, req.params.id);

  const relative = await saveImage(req.file, 'widgets');
  // Stored site-relative; the widget resolves it against the domain it was
  // loaded from, so a logo never points at another domain.
  const widget = await updateWidget(organizationId, req.params.id, { logoUrl: relative });
  return ok(res, snippetFor(req)(widget), 'Logo uploaded');
}
