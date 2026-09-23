import { Worker, type Job } from 'bullmq';
import {
  AutomationActionType,
  AutomationExecutionStatus,
  ConversationStatus,
  SenderType,
} from '@prisma/client';
import axios from 'axios';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createRedisConnection, withLock } from '../lib/redis';
import { QUEUE_NAMES, aiQueue, automationQueue } from '../queues';
import type { AIJob, AutomationJob } from '../queues/jobTypes';
import {
  findMatchingAutomations,
  renderTemplate,
  type ActionConfig,
} from '../services/automation.service';
import { queueOutboundMessage } from '../services/message.service';
import { addInternalNote, assignConversation, updateConversation } from '../services/conversation.service';

/**
 * Automation engine (spec sections 19 and 20).
 *
 * Executes a matched automation's actions in order, recording every run in
 * AutomationExecution so the welcome message cannot repeat and so the
 * "automation activity" report has real data.
 */
export function createAutomationWorker(): Worker<AutomationJob> {
  return new Worker<AutomationJob>(
    QUEUE_NAMES.AUTOMATION_PROCESSING,
    async (job: Job<AutomationJob>) => {
      const data = job.data;

      // Resuming after a DELAY action: continue the same execution.
      if (data.automationId && data.executionId) {
        await runActions(data, data.automationId, data.executionId, data.resumeFromActionOrder ?? 0);
        return;
      }

      const [conversation, organization] = await Promise.all([
        prisma.conversation.findFirst({
          where: { id: data.conversationId, organizationId: data.organizationId },
          select: { id: true, platform: true, contactId: true },
        }),
        prisma.organization.findUnique({
          where: { id: data.organizationId },
          select: { timezone: true, businessHours: true },
        }),
      ]);

      if (!conversation) return;

      const message = data.messageId
        ? await prisma.message.findFirst({
            where: { id: data.messageId, organizationId: data.organizationId },
            select: { body: true },
          })
        : null;

      const matches = await findMatchingAutomations({
        organizationId: data.organizationId,
        triggerType: data.triggerType,
        platform: conversation.platform,
        messageText: message?.body ?? '',
        contactId: data.contactId,
        timezone: organization?.timezone ?? 'UTC',
        businessHours: organization?.businessHours,
      });

      for (const automation of matches) {
        // A single execution per (automation, conversation, trigger) burst.
        const lockKey = `automation:${automation.id}:${data.conversationId}:${data.triggerType}`;
        await withLock(lockKey, 30_000, async () => {
          const execution = await prisma.automationExecution.create({
            data: {
              organizationId: data.organizationId,
              automationId: automation.id,
              conversationId: data.conversationId,
              contactId: data.contactId,
              triggerType: data.triggerType,
              status: AutomationExecutionStatus.RUNNING,
            },
          });

          await runActions(data, automation.id, execution.id, 0);
        });
      }
    },
    { connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY },
  );
}

async function runActions(
  data: AutomationJob,
  automationId: string,
  executionId: string,
  fromOrder: number,
) {
  const actions = await prisma.automationAction.findMany({
    where: { automationId, organizationId: data.organizationId, order: { gte: fromOrder } },
    orderBy: { order: 'asc' },
  });

  const contact = await prisma.contact.findFirst({
    where: { id: data.contactId, organizationId: data.organizationId },
    select: { displayName: true, firstName: true, email: true, phone: true },
  });

  const organization = await prisma.organization.findUnique({
    where: { id: data.organizationId },
    select: { name: true },
  });

  const variables: Record<string, string | undefined> = {
    customer_name: contact?.displayName,
    first_name: contact?.firstName ?? contact?.displayName?.split(' ')[0],
    business_name: organization?.name,
    email: contact?.email ?? undefined,
    phone: contact?.phone ?? undefined,
  };

  const performed: string[] = [];

  try {
    for (const action of actions) {
      const config = (action.config ?? {}) as ActionConfig;

      switch (action.type) {
        case AutomationActionType.SEND_MESSAGE: {
          if (!config.message) break;
          await queueOutboundMessage({
            organizationId: data.organizationId,
            conversationId: data.conversationId,
            body: renderTemplate(config.message, variables),
            senderType: SenderType.AUTOMATION,
          });
          break;
        }

        case AutomationActionType.SEND_TEMPLATE: {
          if (!config.templateId) break;
          const template = await prisma.messageTemplate.findFirst({
            where: { id: config.templateId, organizationId: data.organizationId },
          });
          if (!template) break;
          await queueOutboundMessage({
            organizationId: data.organizationId,
            conversationId: data.conversationId,
            body: renderTemplate(template.body, variables),
            senderType: SenderType.AUTOMATION,
          });
          await prisma.messageTemplate.update({
            where: { id: template.id },
            data: { usageCount: { increment: 1 } },
          });
          break;
        }

        case AutomationActionType.ASSIGN_AGENT: {
          if (!config.agentId) break;
          await assignConversation(
            data.organizationId,
            data.conversationId,
            config.agentId,
            config.agentId,
            'Assigned by automation',
          );
          break;
        }

        case AutomationActionType.ADD_TAG: {
          if (!config.tagId) break;
          await prisma.conversationTag
            .create({
              data: {
                organizationId: data.organizationId,
                conversationId: data.conversationId,
                tagId: config.tagId,
              },
            })
            .catch(() => undefined); // already tagged
          break;
        }

        case AutomationActionType.REMOVE_TAG: {
          if (!config.tagId) break;
          await prisma.conversationTag.deleteMany({
            where: {
              organizationId: data.organizationId,
              conversationId: data.conversationId,
              tagId: config.tagId,
            },
          });
          break;
        }

        case AutomationActionType.CHANGE_STATUS: {
          if (!config.status) break;
          await updateConversation(data.organizationId, data.conversationId, {
            status: config.status as ConversationStatus,
          });
          break;
        }

        case AutomationActionType.INTERNAL_NOTE: {
          if (!config.note) break;
          await prisma.message.create({
            data: {
              organizationId: data.organizationId,
              conversationId: data.conversationId,
              platform: 'INTERNAL',
              direction: 'OUTBOUND',
              type: 'NOTE',
              senderType: SenderType.AUTOMATION,
              isInternal: true,
              body: renderTemplate(config.note, variables),
            },
          });
          break;
        }

        case AutomationActionType.DELAY: {
          const delayMs = Math.max(1, config.delaySeconds ?? 60) * 1000;
          const resume: AutomationJob = {
            ...data,
            automationId,
            executionId,
            resumeFromActionOrder: action.order + 1,
          };
          // Park the rest of the sequence; the job resumes itself later.
          await automationQueue().add('resume-automation', resume, { delay: delayMs });
          performed.push(`delay:${config.delaySeconds ?? 60}s`);
          await prisma.automationExecution.update({
            where: { id: executionId },
            data: { result: { performed, paused: true } as never },
          });
          return;
        }

        case AutomationActionType.TRIGGER_AI: {
          const aiJob: AIJob = {
            organizationId: data.organizationId,
            conversationId: data.conversationId,
            messageId: data.messageId ?? '',
            contactId: data.contactId,
            mode: 'auto_reply',
          };
          await aiQueue().add('ai-respond', aiJob);
          break;
        }

        case AutomationActionType.WEBHOOK: {
          if (!config.url) break;
          // Outbound webhooks are best-effort; a failing endpoint must not
          // block the customer-facing actions after it.
          await axios
            .request({
              url: config.url,
              method: (config.method ?? 'POST') as 'POST',
              timeout: 8_000,
              data: {
                organizationId: data.organizationId,
                conversationId: data.conversationId,
                contactId: data.contactId,
                trigger: data.triggerType,
              },
            })
            .catch((error) => logger.warn({ err: error, url: config.url }, 'automation webhook failed'));
          break;
        }

        default:
          break;
      }

      performed.push(action.type);
    }

    await prisma.$transaction([
      prisma.automationExecution.update({
        where: { id: executionId },
        data: {
          status: AutomationExecutionStatus.COMPLETED,
          completedAt: new Date(),
          result: { performed } as never,
        },
      }),
      prisma.automation.update({
        where: { id: automationId },
        data: { executionCount: { increment: 1 }, lastExecutedAt: new Date() },
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation failed';
    await prisma.automationExecution.update({
      where: { id: executionId },
      data: {
        status: AutomationExecutionStatus.FAILED,
        completedAt: new Date(),
        error: message.slice(0, 500),
        result: { performed } as never,
      },
    });
    throw error;
  }
}
