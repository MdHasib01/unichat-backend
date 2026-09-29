import type { Request, Response } from 'express';
import { created, ok, paginated } from '../utils/response';
import { NotFoundError } from '../utils/errors';
import { prisma } from '../lib/prisma';
import {
  addInternalNote,
  assignConversation,
  countConversationsByStatus,
  getConversation,
  listConversations,
  listMessages,
  markConversationRead,
  setConversationTags,
  updateConversation,
} from '../services/conversation.service';
import { queueOutboundMessage, retryOutboundMessage } from '../services/message.service';
import { generateAnswer, pendingInboundBatch } from '../services/ai.service';
import { renderTemplate } from '../services/automation.service';
import { auditFromRequest } from '../services/audit.service';

export async function listConversationsController(req: Request, res: Response) {
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    status?: never;
    platform?: never;
    assignment?: 'me' | 'unassigned' | 'all';
    assigneeId?: string;
    tagId?: string;
    unreadOnly?: boolean;
  };

  const { items, total } = await listConversations(req.tenant!.organizationId, {
    ...query,
    currentUserId: req.auth!.userId,
  });

  return paginated(res, items, query.page, query.pageSize, total);
}

export async function conversationCountsController(req: Request, res: Response) {
  return ok(res, await countConversationsByStatus(req.tenant!.organizationId));
}

export async function getConversationController(req: Request, res: Response) {
  return ok(res, await getConversation(req.tenant!.organizationId, req.params.id));
}

export async function listMessagesController(req: Request, res: Response) {
  const query = req.query as unknown as { limit: number; before?: string };
  const result = await listMessages(req.tenant!.organizationId, req.params.id, query);
  return ok(res, result.items, 'Success', { hasMore: result.hasMore });
}

export async function sendMessageController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  let body: string | undefined = req.body.body;

  // A template send resolves the body server-side so variables are filled
  // from the real contact, not whatever the client passes.
  if (req.body.templateId) {
    const template = await prisma.messageTemplate.findFirst({
      where: { id: req.body.templateId, organizationId },
    });
    if (!template) throw new NotFoundError('Template');

    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId },
      select: {
        contact: { select: { displayName: true, firstName: true, email: true, phone: true } },
        organization: { select: { name: true } },
      },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    body = renderTemplate(template.body, {
      customer_name: conversation.contact.displayName,
      first_name: conversation.contact.firstName ?? conversation.contact.displayName.split(' ')[0],
      business_name: conversation.organization.name,
      email: conversation.contact.email ?? undefined,
      phone: conversation.contact.phone ?? undefined,
    });

    await prisma.messageTemplate.update({
      where: { id: template.id },
      data: { usageCount: { increment: 1 } },
    });
  }

  const message = await queueOutboundMessage({
    organizationId,
    conversationId: req.params.id,
    userId: req.auth!.userId,
    body,
    attachments: req.body.attachments,
  });

  return created(res, message, deliveryMessage(message.status, message.errorMessage));
}

/** Sends a failed message again. The same row moves from FAILED to SENT. */
export async function retryMessageController(req: Request, res: Response) {
  const message = await retryOutboundMessage(req.tenant!.organizationId, req.params.id, req.params.messageId);
  return ok(res, message, deliveryMessage(message.status, message.errorMessage));
}

/** Tells the agent exactly what the customer will (or will not) see. */
function deliveryMessage(status: string, error: string | null): string {
  switch (status) {
    case 'FAILED':
      return `Not delivered — the customer has not received this message${error ? `: ${error}` : ''}`;
    case 'QUEUED':
      return 'Message queued';
    default:
      return 'Message sent';
  }
}

export async function updateConversationController(req: Request, res: Response) {
  const conversation = await updateConversation(
    req.tenant!.organizationId,
    req.params.id,
    req.body,
  );
  await auditFromRequest(req, 'conversation.updated', {
    entityType: 'Conversation',
    entityId: req.params.id,
    metadata: req.body,
  });
  return ok(res, conversation, 'Conversation updated');
}

export async function assignConversationController(req: Request, res: Response) {
  const conversation = await assignConversation(
    req.tenant!.organizationId,
    req.params.id,
    req.body.assigneeId,
    req.auth!.userId,
    req.body.note,
  );
  await auditFromRequest(req, 'conversation.assigned', {
    entityType: 'Conversation',
    entityId: req.params.id,
    metadata: { assigneeId: req.body.assigneeId },
  });
  return ok(res, conversation, req.body.assigneeId ? 'Conversation assigned' : 'Conversation unassigned');
}

export async function setConversationTagsController(req: Request, res: Response) {
  const conversation = await setConversationTags(
    req.tenant!.organizationId,
    req.params.id,
    req.body.tagIds,
  );
  return ok(res, conversation, 'Tags updated');
}

export async function markReadController(req: Request, res: Response) {
  await markConversationRead(req.tenant!.organizationId, req.params.id);
  return ok(res, { read: true }, 'Marked as read');
}

export async function addNoteController(req: Request, res: Response) {
  const note = await addInternalNote(
    req.tenant!.organizationId,
    req.params.id,
    req.auth!.userId,
    req.body.body,
  );
  return created(res, note, 'Note added');
}

/**
 * Draft a reply for the agent. Nothing is sent — the agent edits and decides
 * (spec section 18, "AI suggestion").
 */
export async function suggestReplyController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;

  // Answer everything the customer sent since the last reply, falling back to
  // their most recent message when the thread is already answered.
  const batch = await pendingInboundBatch(organizationId, req.params.id);
  let question = batch.question;
  let historyBefore = batch.startedAt;

  if (!question) {
    const lastInbound = await prisma.message.findFirst({
      where: { organizationId, conversationId: req.params.id, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { body: true, createdAt: true },
    });
    if (!lastInbound?.body) {
      return ok(res, { suggestion: null }, 'There is no customer message to reply to yet');
    }
    question = lastInbound.body;
    historyBefore = lastInbound.createdAt;
  }

  const answer = await generateAnswer(organizationId, question, {
    conversationId: req.params.id,
    historyBefore,
  });

  return ok(
    res,
    {
      suggestion: answer.answer || null,
      confidence: answer.confidence,
      sources: answer.sources,
      recommendHandoff: answer.shouldHandoff,
    },
    answer.answer ? 'Suggestion ready' : 'The assistant could not answer from your knowledge base',
  );
}
