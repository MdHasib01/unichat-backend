import {
  AutomationActionType,
  AutomationExecutionStatus,
  AutomationTriggerType,
  ConversationStatus,
  Platform,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { isWithinBusinessHours } from '../utils/businessHours';

export const automationInclude = {
  triggers: true,
  actions: { orderBy: { order: 'asc' } },
  _count: { select: { executions: true } },
} satisfies Prisma.AutomationInclude;

export interface TriggerConfig {
  keywords?: string[];
  matchType?: 'any' | 'all' | 'exact';
  caseSensitive?: boolean;
  idleMinutes?: number;
  inHours?: boolean;
  tagId?: string;
}

export interface ActionConfig {
  message?: string;
  templateId?: string;
  agentId?: string;
  tagId?: string;
  status?: ConversationStatus;
  note?: string;
  delaySeconds?: number;
  url?: string;
  method?: string;
}

export async function listAutomations(organizationId: string) {
  return prisma.automation.findMany({
    where: { organizationId },
    include: automationInclude,
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function getAutomation(organizationId: string, automationId: string) {
  const automation = await prisma.automation.findFirst({
    where: { id: automationId, organizationId },
    include: automationInclude,
  });
  if (!automation) throw new NotFoundError('Automation');
  return automation;
}

export interface AutomationInput {
  name: string;
  description?: string | null;
  isActive?: boolean;
  runOncePerContact?: boolean;
  priority?: number;
  platforms?: Platform[];
  triggers: Array<{ type: AutomationTriggerType; config?: TriggerConfig }>;
  actions: Array<{ type: AutomationActionType; order?: number; config?: ActionConfig }>;
}

export async function createAutomation(organizationId: string, input: AutomationInput) {
  const automation = await prisma.automation.create({
    data: {
      organizationId,
      name: input.name,
      description: input.description,
      isActive: input.isActive ?? true,
      runOncePerContact: input.runOncePerContact ?? false,
      priority: input.priority ?? 100,
      platforms: input.platforms ?? [],
      triggers: {
        create: input.triggers.map((t) => ({
          organizationId,
          type: t.type,
          config: (t.config ?? {}) as never,
        })),
      },
      actions: {
        create: input.actions.map((a, index) => ({
          organizationId,
          type: a.type,
          order: a.order ?? index,
          config: (a.config ?? {}) as never,
        })),
      },
    },
    include: automationInclude,
  });

  return automation;
}

export async function updateAutomation(
  organizationId: string,
  automationId: string,
  input: Partial<AutomationInput>,
) {
  await getAutomation(organizationId, automationId);

  await prisma.$transaction(async (tx) => {
    await tx.automation.update({
      where: { id: automationId },
      data: {
        name: input.name,
        description: input.description,
        isActive: input.isActive,
        runOncePerContact: input.runOncePerContact,
        priority: input.priority,
        platforms: input.platforms,
      },
    });

    // Triggers/actions are replaced wholesale — simpler and safe because the
    // whole definition is submitted by the builder UI.
    if (input.triggers) {
      await tx.automationTrigger.deleteMany({ where: { automationId, organizationId } });
      await tx.automationTrigger.createMany({
        data: input.triggers.map((t) => ({
          organizationId,
          automationId,
          type: t.type,
          config: (t.config ?? {}) as never,
        })),
      });
    }

    if (input.actions) {
      await tx.automationAction.deleteMany({ where: { automationId, organizationId } });
      await tx.automationAction.createMany({
        data: input.actions.map((a, index) => ({
          organizationId,
          automationId,
          type: a.type,
          order: a.order ?? index,
          config: (a.config ?? {}) as never,
        })),
      });
    }
  });

  return getAutomation(organizationId, automationId);
}

export async function deleteAutomation(organizationId: string, automationId: string) {
  const result = await prisma.automation.deleteMany({ where: { id: automationId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Automation');
}

export async function toggleAutomation(
  organizationId: string,
  automationId: string,
  isActive: boolean,
) {
  const result = await prisma.automation.updateMany({
    where: { id: automationId, organizationId },
    data: { isActive },
  });
  if (result.count === 0) throw new NotFoundError('Automation');
  return getAutomation(organizationId, automationId);
}

/**
 * Selects the automations that should run for an event.
 *
 * Matching is done in the service (not the worker) so it is unit-testable and
 * so the same logic backs the "test automation" screen.
 */
export async function findMatchingAutomations(params: {
  organizationId: string;
  triggerType: AutomationTriggerType;
  platform: Platform;
  messageText?: string;
  contactId: string;
  timezone: string;
  businessHours: unknown;
}) {
  const automations = await prisma.automation.findMany({
    where: {
      organizationId: params.organizationId,
      isActive: true,
      triggers: { some: { type: params.triggerType } },
    },
    include: { triggers: true, actions: { orderBy: { order: 'asc' } } },
    orderBy: { priority: 'asc' },
  });

  const matched: typeof automations = [];

  for (const automation of automations) {
    if (automation.platforms.length && !automation.platforms.includes(params.platform)) continue;

    const trigger = automation.triggers.find((t) => t.type === params.triggerType);
    if (!trigger) continue;

    const config = (trigger.config ?? {}) as TriggerConfig;

    if (params.triggerType === AutomationTriggerType.KEYWORD || params.triggerType === AutomationTriggerType.MESSAGE_CONTAINS) {
      if (!matchesKeywords(params.messageText ?? '', config)) continue;
    }

    if (params.triggerType === AutomationTriggerType.BUSINESS_HOURS) {
      const inHours = isWithinBusinessHours(params.businessHours, params.timezone);
      if (config.inHours !== undefined && config.inHours !== inHours) continue;
    }

    // Welcome messages must not repeat for a returning customer
    // (spec section 20).
    if (automation.runOncePerContact) {
      const previous = await prisma.automationExecution.count({
        where: {
          organizationId: params.organizationId,
          automationId: automation.id,
          contactId: params.contactId,
          status: { in: [AutomationExecutionStatus.COMPLETED, AutomationExecutionStatus.RUNNING] },
        },
      });
      if (previous > 0) continue;
    }

    matched.push(automation);
  }

  return matched;
}

export function matchesKeywords(text: string, config: TriggerConfig): boolean {
  const keywords = (config.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) return false;

  const haystack = config.caseSensitive ? text : text.toLowerCase();
  const needles = config.caseSensitive ? keywords : keywords.map((k) => k.toLowerCase());

  switch (config.matchType) {
    case 'all':
      return needles.every((k) => haystack.includes(k));
    case 'exact':
      return needles.some((k) => haystack.trim() === k);
    default:
      return needles.some((k) => haystack.includes(k));
  }
}

export async function listExecutions(
  organizationId: string,
  params: { page: number; pageSize: number; automationId?: string },
) {
  const where: Prisma.AutomationExecutionWhereInput = { organizationId };
  if (params.automationId) where.automationId = params.automationId;

  const [items, total] = await Promise.all([
    prisma.automationExecution.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: { automation: { select: { id: true, name: true } } },
    }),
    prisma.automationExecution.count({ where }),
  ]);

  return { items, total };
}

/** Replaces {{variables}} in an automation or template body. */
export function renderTemplate(body: string, variables: Record<string, string | undefined>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? '');
}
