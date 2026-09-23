import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../utils/response';
import { aiQueue } from '../queues';
import { availableAIProviders } from '../ai/provider.factory';
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  generateAnswer,
  getAssistant,
  knowledgeStats,
  listKnowledgeDocuments,
  updateAssistant,
  updateKnowledgeDocument,
} from '../services/ai.service';
import { buildProductKnowledge, ingestDocument } from '../ai/rag/ingest';
import { auditFromRequest } from '../services/audit.service';
import { env } from '../config/env';

export async function getAssistantController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const [assistant, stats] = await Promise.all([
    getAssistant(organizationId),
    knowledgeStats(organizationId),
  ]);

  return ok(res, {
    assistant,
    stats,
    providers: availableAIProviders(),
    defaultModel: env.AI_MODEL,
  });
}

export async function updateAssistantController(req: Request, res: Response) {
  const assistant = await updateAssistant(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'ai.assistant_updated', { metadata: req.body });
  return ok(res, assistant, 'AI settings saved');
}

export async function listKnowledgeController(req: Request, res: Response) {
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    sourceType?: never;
  };
  const { items, total } = await listKnowledgeDocuments(req.tenant!.organizationId, query);
  return paginated(res, items, query.page, query.pageSize, total);
}

/**
 * Creating a document returns immediately; chunking + embedding run on the AI
 * queue so a large paste never blocks the request (spec section 22).
 */
export async function createKnowledgeController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const document = await createKnowledgeDocument(organizationId, req.body);

  await aiQueue().add(
    'ingest-document',
    { organizationId, documentId: document.id },
    { jobId: `ingest:${document.id}` },
  );

  await auditFromRequest(req, 'ai.knowledge_created', {
    entityType: 'AIKnowledgeDocument',
    entityId: document.id,
  });

  return created(res, document, 'Added — Unichat is indexing it now');
}

export async function updateKnowledgeController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const document = await updateKnowledgeDocument(organizationId, req.params.id, req.body);

  if (req.body.content) {
    // Content changed, so the stored chunks are stale.
    await aiQueue().add('ingest-document', { organizationId, documentId: document.id });
  }

  return ok(res, document, 'Knowledge updated');
}

export async function deleteKnowledgeController(req: Request, res: Response) {
  await deleteKnowledgeDocument(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'ai.knowledge_deleted', {
    entityType: 'AIKnowledgeDocument',
    entityId: req.params.id,
  });
  return noContent(res);
}

export async function reindexKnowledgeController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const { items } = await listKnowledgeDocuments(organizationId, { page: 1, pageSize: 100 });

  await Promise.all(
    items.map((doc) => aiQueue().add('ingest-document', { organizationId, documentId: doc.id })),
  );

  return ok(res, { queued: items.length }, 'Re-indexing your knowledge base');
}

/** Turns the product catalogue into a knowledge document in one click. */
export async function importProductKnowledgeController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const content = await buildProductKnowledge(organizationId);

  if (!content) {
    return ok(res, { imported: 0 }, 'Add some products first, then import them here');
  }

  const document = await createKnowledgeDocument(organizationId, {
    title: 'Product catalogue',
    content,
    sourceType: 'PRODUCT',
  });

  await ingestDocument(organizationId, document.id);

  return created(res, document, 'Products imported into your AI knowledge');
}

/** AI playground (spec section 29.1, "AI test/playground"). */
export async function testAIController(req: Request, res: Response) {
  const answer = await generateAnswer(req.tenant!.organizationId, req.body.message, {
    conversationId: req.body.conversationId,
  });

  const assistant = await getAssistant(req.tenant!.organizationId);

  return ok(res, {
    answer: answer.answer || (answer.shouldHandoff ? assistant.fallbackMessage : ''),
    confidence: answer.confidence,
    threshold: assistant.confidenceThreshold,
    wouldAutoReply: assistant.autoReplyEnabled && !answer.shouldHandoff,
    wouldHandoff: answer.shouldHandoff,
    handoffReason: answer.handoffReason,
    sources: answer.sources,
    model: answer.model,
    tokensUsed: answer.tokensUsed,
  });
}
