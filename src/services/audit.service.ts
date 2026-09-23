import type { Request } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface AuditInput {
  organizationId?: string | null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Audit writes must never break the request they describe, so failures are
 * logged and swallowed.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId ?? null,
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 500),
        requestId: input.requestId,
        metadata: (input.metadata ?? undefined) as never,
      },
    });
  } catch (error) {
    logger.warn({ err: error, action: input.action }, 'failed to write audit log');
  }
}

export function auditFromRequest(
  req: Request,
  action: string,
  extra: Partial<AuditInput> = {},
): Promise<void> {
  return recordAudit({
    organizationId: extra.organizationId ?? req.tenant?.organizationId ?? null,
    userId: extra.userId ?? req.auth?.userId ?? null,
    action,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    // pino-http widens Request['id'] to string | number; audit stores text.
    requestId: String(req.id),
    ...extra,
  });
}

export async function listAuditLogs(organizationId: string, page = 1, pageSize = 50) {
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    }),
    prisma.auditLog.count({ where: { organizationId } }),
  ]);
  return { items, total };
}
