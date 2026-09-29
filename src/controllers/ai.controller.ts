import type { Request, Response } from 'express';
import type { TrainingSource, TrainingStatus } from '@prisma/client';
import { created, noContent, ok, paginated, paginationMeta } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import { parseTrainingImport } from '../ai/training/parseImport';
import {
  bulkUpdateTraining,
  createTrainingImport,
  deleteTrainingExample,
  exportTraining,
  getTrainingImport,
  listTrainingExamples,
  trainingStats,
  updateTrainingExample,
  upsertTrainingExample,
} from '../services/aiTraining.service';
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
  // Approved answers are vectors too; refresh them with the current provider.
  await aiQueue().add('reembed-training', { organizationId }, { jobId: `reembed:${organizationId}:${Date.now()}` });

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
    exactMatch: answer.exactMatch,
    wouldHandoff: answer.shouldHandoff,
    handoffReason: answer.handoffReason,
    sources: answer.sources,
    model: answer.model,
    tokensUsed: answer.tokensUsed,
  });
}

// --- training: approved answers ----------------------------------------------

export async function listTrainingController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const query = req.query as unknown as {
    page: number;
    pageSize: number;
    search?: string;
    source?: TrainingSource;
    status?: TrainingStatus;
  };
  const [{ items, total }, stats] = await Promise.all([
    listTrainingExamples(organizationId, query),
    trainingStats(organizationId),
  ]);
  return res.status(200).json({
    success: true,
    data: items,
    message: 'Success',
    meta: { pagination: paginationMeta(query.page, query.pageSize, total), stats },
  });
}

/** Also used by "Teach AI" in the inbox — teaching a known question corrects its answer. */
export async function createTrainingController(req: Request, res: Response) {
  const example = await upsertTrainingExample(req.tenant!.organizationId, req.auth!.userId, req.body);
  await auditFromRequest(req, 'ai.training_saved', { entityType: 'AITrainingExample', entityId: example.id });
  return created(res, example, 'The assistant will use this answer from now on');
}

export async function updateTrainingController(req: Request, res: Response) {
  const example = await updateTrainingExample(req.tenant!.organizationId, req.params.id, req.body);
  return ok(res, example, 'Answer updated');
}

export async function deleteTrainingController(req: Request, res: Response) {
  await deleteTrainingExample(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'ai.training_deleted', { entityType: 'AITrainingExample', entityId: req.params.id });
  return noContent(res);
}

export async function bulkTrainingController(req: Request, res: Response) {
  const result = await bulkUpdateTraining(req.tenant!.organizationId, req.body.ids, req.body.action);
  await auditFromRequest(req, 'ai.training_bulk', { metadata: { action: req.body.action, count: result.affected } });
  return ok(res, result, `${result.affected} answer${result.affected === 1 ? '' : 's'} updated`);
}

/**
 * JSON import. `dryRun=true` only parses and returns a preview; otherwise the
 * pairs are queued and embedded in the background (poll the import for progress).
 */
export async function importTrainingController(req: Request, res: Response) {
  const organizationId = req.tenant!.organizationId;
  const { dryRun } = req.query as unknown as { dryRun: boolean };

  if (!req.file) throw new BadRequestError('Choose a .json file to import', [], 'UPLOAD_MISSING');

  let data: unknown;
  try {
    data = JSON.parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new BadRequestError('That file is not valid JSON', [], 'INVALID_JSON');
  }

  const parsed = parseTrainingImport(data);
  if (!parsed.pairs.length) {
    throw new BadRequestError(
      parsed.errors[0]?.message ?? 'No question/answer pairs were found in this file',
      parsed.errors.slice(0, 10).map((e) => ({ field: e.index >= 0 ? `item ${e.index + 1}` : undefined, message: e.message })),
      'NOTHING_TO_IMPORT',
    );
  }

  if (dryRun) {
    return ok(res, {
      format: parsed.format,
      count: parsed.pairs.length,
      skipped: parsed.skipped,
      preview: parsed.pairs.slice(0, 10),
      errors: parsed.errors.slice(0, 20),
    });
  }

  const record = await createTrainingImport(
    organizationId,
    req.auth!.userId,
    req.file.originalname?.slice(0, 200),
    parsed.pairs,
    parsed.errors.slice(0, 50),
  );
  await auditFromRequest(req, 'ai.training_imported', {
    entityType: 'AITrainingImport',
    entityId: record.id,
    metadata: { pairs: parsed.pairs.length },
  });
  return created(res, record, `Importing ${parsed.pairs.length} answers…`);
}

export async function getTrainingImportController(req: Request, res: Response) {
  return ok(res, await getTrainingImport(req.tenant!.organizationId, req.params.id));
}

export async function exportTrainingController(req: Request, res: Response) {
  const examples = await exportTraining(req.tenant!.organizationId);
  res.setHeader('Content-Disposition', `attachment; filename="unichat-training-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify({ examples }, null, 2));
}
