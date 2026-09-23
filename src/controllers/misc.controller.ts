import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../utils/response';
import { checkDatabase } from '../lib/prisma';
import { checkRedis } from '../lib/redis';
import { queueHealth } from '../queues';
import { env, mockMode } from '../config/env';
import {
  callStats,
  createCall,
  deleteCall,
  getCall,
  listCalls,
  updateCall,
} from '../services/call.service';
import {
  createCustomField,
  createTag,
  createTemplate,
  deleteCustomField,
  deleteTag,
  deleteTemplate,
  getTemplate,
  listCustomFields,
  listTags,
  listTemplates,
  updateTag,
  updateTemplate,
} from '../services/template.service';
import {
  getAgentPerformance,
  getAutomationPerformance,
  getDashboard,
  getOverview,
  getPlatformBreakdown,
  getTimeSeries,
  resolveRange,
} from '../services/analytics.service';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notification.service';
import { listAuditLogs } from '../services/audit.service';
import { listWebhookEvents } from '../services/webhook.service';
import { auditFromRequest } from '../services/audit.service';

// --- health ----------------------------------------------------------------

export async function healthController(_req: Request, res: Response) {
  const [database, redis, queues] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    queueHealth().catch(() => ({ healthy: false, queues: {} })),
  ]);

  const status = database && redis && queues.healthy ? 'ok' : 'degraded';

  return res.status(status === 'ok' ? 200 : 503).json({
    status,
    database: database ? 'connected' : 'unavailable',
    redis: redis ? 'connected' : 'unavailable',
    queues: queues.healthy ? 'healthy' : 'degraded',
    details: queues.queues,
    mockMode,
    version: process.env.npm_package_version ?? '1.0.0',
    uptimeSeconds: Math.round(process.uptime()),
    environment: env.NODE_ENV,
  });
}

// --- calls -----------------------------------------------------------------

export async function listCallsController(req: Request, res: Response) {
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    direction?: never;
    status?: never;
    withRecordingOnly?: boolean;
  };
  const { items, total } = await listCalls(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}

export async function getCallController(req: Request, res: Response) {
  return ok(res, await getCall(req.tenant!.organizationId, req.params.id));
}

export async function createCallController(req: Request, res: Response) {
  const call = await createCall(req.tenant!.organizationId, req.body);
  return created(res, call, 'Call logged');
}

export async function updateCallController(req: Request, res: Response) {
  return ok(res, await updateCall(req.tenant!.organizationId, req.params.id, req.body), 'Call updated');
}

export async function deleteCallController(req: Request, res: Response) {
  await deleteCall(req.tenant!.organizationId, req.params.id);
  return noContent(res);
}

export async function callStatsController(req: Request, res: Response) {
  return ok(res, await callStats(req.tenant!.organizationId));
}

// --- templates, tags, custom fields ---------------------------------------

export async function listTemplatesController(req: Request, res: Response) {
  const query = req.query as unknown as { search?: string; category?: never };
  return ok(res, await listTemplates(req.tenant!.organizationId, query));
}

export async function getTemplateController(req: Request, res: Response) {
  return ok(res, await getTemplate(req.tenant!.organizationId, req.params.id));
}

export async function createTemplateController(req: Request, res: Response) {
  const template = await createTemplate(req.tenant!.organizationId, req.body);
  return created(res, template, 'Template created');
}

export async function updateTemplateController(req: Request, res: Response) {
  return ok(
    res,
    await updateTemplate(req.tenant!.organizationId, req.params.id, req.body),
    'Template updated',
  );
}

export async function deleteTemplateController(req: Request, res: Response) {
  await deleteTemplate(req.tenant!.organizationId, req.params.id);
  return noContent(res);
}

export async function listTagsController(req: Request, res: Response) {
  return ok(res, await listTags(req.tenant!.organizationId));
}

export async function createTagController(req: Request, res: Response) {
  return created(res, await createTag(req.tenant!.organizationId, req.body), 'Tag created');
}

export async function updateTagController(req: Request, res: Response) {
  return ok(res, await updateTag(req.tenant!.organizationId, req.params.id, req.body), 'Tag updated');
}

export async function deleteTagController(req: Request, res: Response) {
  await deleteTag(req.tenant!.organizationId, req.params.id);
  return noContent(res);
}

export async function listCustomFieldsController(req: Request, res: Response) {
  return ok(res, await listCustomFields(req.tenant!.organizationId));
}

export async function createCustomFieldController(req: Request, res: Response) {
  return created(
    res,
    await createCustomField(req.tenant!.organizationId, req.body),
    'Custom field created',
  );
}

export async function deleteCustomFieldController(req: Request, res: Response) {
  await deleteCustomField(req.tenant!.organizationId, req.params.id);
  return noContent(res);
}

// --- analytics -------------------------------------------------------------

export async function dashboardController(req: Request, res: Response) {
  return ok(res, await getDashboard(req.tenant!.organizationId));
}

export async function insightsController(req: Request, res: Response) {
  const { days } = req.query as unknown as { days: number };
  const organizationId = req.tenant!.organizationId;
  const range = resolveRange(days);

  const [overview, platforms, series, agents, automations] = await Promise.all([
    getOverview(organizationId, range),
    getPlatformBreakdown(organizationId, range),
    getTimeSeries(organizationId, range),
    getAgentPerformance(organizationId, range),
    getAutomationPerformance(organizationId, range),
  ]);

  return ok(res, { range: { from: range.from, to: range.to, days }, overview, platforms, series, agents, automations });
}

// --- notifications ---------------------------------------------------------

export async function listNotificationsController(req: Request, res: Response) {
  const query = req.query as unknown as { page: number; pageSize: number; unreadOnly?: boolean };
  const { items, total, unread } = await listNotifications(
    req.tenant!.organizationId,
    req.auth!.userId,
    query,
  );
  return res.status(200).json({
    success: true,
    data: items,
    message: 'Success',
    meta: {
      unread,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
        hasMore: query.page * query.pageSize < total,
      },
    },
  });
}

export async function markNotificationReadController(req: Request, res: Response) {
  await markNotificationRead(req.tenant!.organizationId, req.auth!.userId, req.params.id);
  return ok(res, { read: true }, 'Marked as read');
}

export async function markAllNotificationsReadController(req: Request, res: Response) {
  const count = await markAllNotificationsRead(req.tenant!.organizationId, req.auth!.userId);
  return ok(res, { read: count }, 'All caught up');
}

// --- audit & webhook log ---------------------------------------------------

export async function listAuditLogsController(req: Request, res: Response) {
  const query = req.query as unknown as { page: number; pageSize: number };
  const { items, total } = await listAuditLogs(
    req.tenant!.organizationId,
    query.page,
    query.pageSize,
  );
  return paginated(res, items, query.page, query.pageSize, total);
}

export async function listWebhookEventsController(req: Request, res: Response) {
  const query = req.query as unknown as { page: number; pageSize: number; status?: never };
  const { items, total } = await listWebhookEvents(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}

export { auditFromRequest };
