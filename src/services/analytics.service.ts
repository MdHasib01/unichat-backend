import {
  ConversationStatus,
  MessageDirection,
  Platform,
  SenderType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { cacheGet, cacheSet } from '../lib/redis';

export interface DateRange {
  from: Date;
  to: Date;
}

export function resolveRange(days = 30): DateRange {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to };
}

/**
 * All analytics are scoped to a single organization. Nothing here aggregates
 * across tenants (spec section 31).
 */
export async function getOverview(organizationId: string, range: DateRange) {
  const cacheKey = `analytics:overview:${organizationId}:${range.from.toISOString().slice(0, 10)}`;
  const cached = await cacheGet<Awaited<ReturnType<typeof computeOverview>>>(cacheKey);
  if (cached) return cached;

  const result = await computeOverview(organizationId, range);
  await cacheSet(cacheKey, result, 120);
  return result;
}

async function computeOverview(organizationId: string, range: DateRange) {
  const window = { gte: range.from, lte: range.to };

  const [
    totalConversations,
    newConversations,
    openConversations,
    resolvedConversations,
    messagesReceived,
    messagesSent,
    aiMessages,
    automationRuns,
    responseAgg,
    contacts,
    aiHandoffs,
  ] = await Promise.all([
    prisma.conversation.count({ where: { organizationId } }),
    prisma.conversation.count({ where: { organizationId, createdAt: window } }),
    prisma.conversation.count({ where: { organizationId, status: ConversationStatus.OPEN } }),
    prisma.conversation.count({
      where: { organizationId, status: ConversationStatus.RESOLVED, resolvedAt: window },
    }),
    prisma.message.count({
      where: { organizationId, direction: MessageDirection.INBOUND, createdAt: window },
    }),
    prisma.message.count({
      where: { organizationId, direction: MessageDirection.OUTBOUND, isInternal: false, createdAt: window },
    }),
    prisma.message.count({
      where: { organizationId, senderType: SenderType.AI, createdAt: window },
    }),
    prisma.automationExecution.count({ where: { organizationId, startedAt: window } }),
    prisma.conversation.aggregate({
      where: { organizationId, createdAt: window, firstResponseSeconds: { not: null } },
      _avg: { firstResponseSeconds: true },
    }),
    prisma.contact.count({ where: { organizationId, createdAt: window } }),
    prisma.aIConversationSession.count({ where: { organizationId, handedOff: true } }),
  ]);

  const aiSessions = await prisma.aIConversationSession.count({ where: { organizationId } });

  return {
    totalConversations,
    newConversations,
    openConversations,
    resolvedConversations,
    messagesReceived,
    messagesSent,
    aiMessages,
    automationRuns,
    newContacts: contacts,
    averageResponseSeconds: Math.round(responseAgg._avg.firstResponseSeconds ?? 0),
    // Share of AI-handled conversations that never needed a person.
    aiResolutionRate: aiSessions > 0 ? Number((((aiSessions - aiHandoffs) / aiSessions) * 100).toFixed(1)) : 0,
    aiHandoffs,
  };
}

export async function getPlatformBreakdown(organizationId: string, range: DateRange) {
  const [conversations, messages] = await Promise.all([
    prisma.conversation.groupBy({
      by: ['platform'],
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    }),
    prisma.message.groupBy({
      by: ['platform'],
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    }),
  ]);

  const platforms: Platform[] = [Platform.FACEBOOK, Platform.INSTAGRAM, Platform.WHATSAPP];

  return platforms.map((platform) => ({
    platform,
    conversations: conversations.find((c) => c.platform === platform)?._count._all ?? 0,
    messages: messages.find((m) => m.platform === platform)?._count._all ?? 0,
  }));
}

export async function getTimeSeries(organizationId: string, range: DateRange) {
  const rows = await prisma.analyticsDaily.findMany({
    where: { organizationId, date: { gte: range.from, lte: range.to } },
    orderBy: { date: 'asc' },
  });

  // AnalyticsDaily is filled by the rollup worker; gaps are rendered as zeros
  // so the chart keeps a continuous x-axis.
  const byDate = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));
  const series: Array<{
    date: string;
    conversations: number;
    resolved: number;
    inbound: number;
    outbound: number;
    ai: number;
  }> = [];

  const cursor = new Date(range.from);
  while (cursor <= range.to) {
    const key = cursor.toISOString().slice(0, 10);
    const row = byDate.get(key);
    series.push({
      date: key,
      conversations: row?.conversationsNew ?? 0,
      resolved: row?.conversationsResolved ?? 0,
      inbound: row?.messagesInbound ?? 0,
      outbound: row?.messagesOutbound ?? 0,
      ai: row?.aiMessages ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return series;
}

export async function getAgentPerformance(organizationId: string, range: DateRange) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: {
      role: true,
      user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
    },
  });

  const window = { gte: range.from, lte: range.to };

  return Promise.all(
    members.map(async (member) => {
      const [assigned, resolved, sent] = await Promise.all([
        prisma.conversationAssignment.count({
          where: { organizationId, assigneeId: member.user.id, createdAt: window },
        }),
        prisma.conversation.count({
          where: {
            organizationId,
            status: ConversationStatus.RESOLVED,
            resolvedAt: window,
            assignments: { some: { assigneeId: member.user.id } },
          },
        }),
        prisma.message.count({
          where: { organizationId, userId: member.user.id, createdAt: window },
        }),
      ]);

      return {
        user: member.user,
        role: member.role,
        assigned,
        resolved,
        messagesSent: sent,
        resolutionRate: assigned > 0 ? Number(((resolved / assigned) * 100).toFixed(1)) : 0,
      };
    }),
  );
}

export async function getAutomationPerformance(organizationId: string, range: DateRange) {
  const automations = await prisma.automation.findMany({
    where: { organizationId },
    select: { id: true, name: true, isActive: true, executionCount: true, lastExecutedAt: true },
    orderBy: { executionCount: 'desc' },
    take: 20,
  });

  const window = { gte: range.from, lte: range.to };

  return Promise.all(
    automations.map(async (automation) => {
      const [runs, failed] = await Promise.all([
        prisma.automationExecution.count({
          where: { organizationId, automationId: automation.id, startedAt: window },
        }),
        prisma.automationExecution.count({
          where: { organizationId, automationId: automation.id, status: 'FAILED', startedAt: window },
        }),
      ]);
      return { ...automation, runs, failed, successRate: runs > 0 ? Number((((runs - failed) / runs) * 100).toFixed(1)) : 100 };
    }),
  );
}

/** Dashboard summary (spec section 29.1). */
export async function getDashboard(organizationId: string) {
  const range = resolveRange(30);
  const previous: DateRange = {
    from: new Date(range.from.getTime() - 30 * 24 * 60 * 60 * 1000),
    to: range.from,
  };

  const [overview, previousOverview, platforms, series, recentConversations, channels, salesSummaryData] =
    await Promise.all([
      getOverview(organizationId, range),
      computeOverview(organizationId, previous),
      getPlatformBreakdown(organizationId, range),
      getTimeSeries(organizationId, resolveRange(14)),
      prisma.conversation.findMany({
        where: { organizationId },
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        take: 6,
        select: {
          id: true,
          platform: true,
          status: true,
          unreadCount: true,
          lastMessageAt: true,
          lastMessagePreview: true,
          contact: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      }),
      prisma.socialAccount.findMany({
        where: { organizationId },
        select: { id: true, platform: true, name: true, status: true, isActive: true, avatarUrl: true },
      }),
      import('./sales.service').then((m) => m.salesSummary(organizationId)),
    ]);

  return {
    overview,
    trends: {
      conversations: percentChange(overview.newConversations, previousOverview.newConversations),
      messages: percentChange(
        overview.messagesReceived + overview.messagesSent,
        previousOverview.messagesReceived + previousOverview.messagesSent,
      ),
      resolved: percentChange(overview.resolvedConversations, previousOverview.resolvedConversations),
      responseTime: percentChange(
        previousOverview.averageResponseSeconds,
        overview.averageResponseSeconds,
      ),
    },
    platforms,
    series,
    recentConversations,
    channels,
    sales: salesSummaryData,
  };
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}
