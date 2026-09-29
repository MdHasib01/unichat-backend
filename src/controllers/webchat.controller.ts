import type { Request, Response } from 'express';
import { env } from '../config/env';
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

/** Where customers load the widget script from. */
function scriptUrl(): string {
  return `${env.FRONTEND_URL.replace(/\/$/, '')}/widget/v1.js`;
}

function withSnippet<T extends { publicKey: string }>(widget: T) {
  return {
    ...widget,
    scriptUrl: scriptUrl(),
    snippet: `<script async src="${scriptUrl()}" data-unichat-key="${widget.publicKey}"></script>`,
  };
}

export async function listWidgetsController(req: Request, res: Response) {
  const widgets = await listWidgets(req.tenant!.organizationId);
  return ok(res, widgets.map(withSnippet));
}

export async function getWidgetController(req: Request, res: Response) {
  return ok(res, withSnippet(await getWidget(req.tenant!.organizationId, req.params.id)));
}

export async function createWidgetController(req: Request, res: Response) {
  const widget = await createWidget(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'webchat.widget_created', { entityType: 'ChatWidget', entityId: widget.id });
  return created(res, withSnippet(widget), 'Website chat created — add the snippet to your site');
}

export async function updateWidgetController(req: Request, res: Response) {
  const widget = await updateWidget(req.tenant!.organizationId, req.params.id, req.body);
  await auditFromRequest(req, 'webchat.widget_updated', {
    entityType: 'ChatWidget',
    entityId: widget.id,
    metadata: req.body,
  });
  return ok(res, withSnippet(widget), 'Website chat saved');
}

export async function rotateWidgetKeyController(req: Request, res: Response) {
  const widget = await rotateWidgetKey(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'webchat.widget_key_rotated', { entityType: 'ChatWidget', entityId: widget.id });
  return ok(res, withSnippet(widget), 'New key issued — update the snippet on your website');
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
  // Absolute: the widget renders on the customer's site, not ours.
  const logoUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}${relative}`;
  const widget = await updateWidget(organizationId, req.params.id, { logoUrl });
  return ok(res, withSnippet(widget), 'Logo uploaded');
}
