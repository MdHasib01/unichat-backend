import { CallDirection, CallStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { assertAllBelongToOrg } from '../repositories/tenant.repository';

const callInclude = {
  contact: { select: { id: true, displayName: true, avatarUrl: true, phone: true } },
  conversation: { select: { id: true, platform: true } },
} satisfies Prisma.CallRecordInclude;

export interface ListCallsParams {
  page: number;
  pageSize: number;
  direction?: CallDirection;
  status?: CallStatus;
  search?: string;
  withRecordingOnly?: boolean;
}

export async function listCalls(organizationId: string, params: ListCallsParams) {
  const where: Prisma.CallRecordWhereInput = { organizationId };
  if (params.direction) where.direction = params.direction;
  if (params.status) where.status = params.status;
  if (params.withRecordingOnly) where.recordingUrl = { not: null };
  if (params.search) {
    where.OR = [
      { fromNumber: { contains: params.search, mode: 'insensitive' } },
      { toNumber: { contains: params.search, mode: 'insensitive' } },
      { contact: { displayName: { contains: params.search, mode: 'insensitive' } } },
      { summary: { contains: params.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.callRecord.findMany({
      where,
      include: callInclude,
      orderBy: { startedAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.callRecord.count({ where }),
  ]);

  return { items, total };
}

export async function getCall(organizationId: string, callId: string) {
  const call = await prisma.callRecord.findFirst({
    where: { id: callId, organizationId },
    include: callInclude,
  });
  if (!call) throw new NotFoundError('Call record');
  return call;
}

export interface CallInput {
  contactId?: string | null;
  conversationId?: string | null;
  direction?: CallDirection;
  status?: CallStatus;
  fromNumber?: string | null;
  toNumber?: string | null;
  durationSeconds?: number;
  provider?: string | null;
  externalId?: string | null;
  /**
   * Recording metadata is stored only when a supported telephony provider
   * supplies it — Unichat does not record calls itself.
   */
  recordingUrl?: string | null;
  recordingMime?: string | null;
  recordingSize?: number | null;
  transcript?: string | null;
  summary?: string | null;
  agentUserId?: string | null;
  startedAt?: Date;
  endedAt?: Date | null;
}

export async function createCall(organizationId: string, input: CallInput) {
  if (input.contactId) await assertAllBelongToOrg('contact', organizationId, [input.contactId], 'Contact');
  if (input.conversationId) {
    await assertAllBelongToOrg('conversation', organizationId, [input.conversationId], 'Conversation');
  }

  return prisma.callRecord.create({
    data: { organizationId, ...input },
    include: callInclude,
  });
}

export async function updateCall(organizationId: string, callId: string, input: Partial<CallInput>) {
  const result = await prisma.callRecord.updateMany({
    where: { id: callId, organizationId },
    data: input,
  });
  if (result.count === 0) throw new NotFoundError('Call record');
  return getCall(organizationId, callId);
}

export async function deleteCall(organizationId: string, callId: string) {
  const result = await prisma.callRecord.deleteMany({ where: { id: callId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Call record');
}

export async function callStats(organizationId: string) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);

  const [total, missed, recordings, duration] = await Promise.all([
    prisma.callRecord.count({ where: { organizationId, startedAt: { gte: since } } }),
    prisma.callRecord.count({
      where: { organizationId, startedAt: { gte: since }, status: CallStatus.MISSED },
    }),
    prisma.callRecord.count({ where: { organizationId, recordingUrl: { not: null } } }),
    prisma.callRecord.aggregate({
      where: { organizationId, startedAt: { gte: since } },
      _sum: { durationSeconds: true },
      _avg: { durationSeconds: true },
    }),
  ]);

  return {
    calls30d: total,
    missed30d: missed,
    recordings,
    totalSeconds: duration._sum.durationSeconds ?? 0,
    averageSeconds: Math.round(duration._avg.durationSeconds ?? 0),
  };
}
