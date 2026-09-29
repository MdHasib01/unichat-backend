import {
  Prisma,
  TrainingImportStatus,
  TrainingSource,
  TrainingStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { aiQueue } from '../queues';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { getEmbeddingProvider } from '../ai/provider.factory';
import { embedMany } from '../ai/types';
import { lexicalEmbedding } from '../ai/rag/embedding';
import { bumpKnowledgeVersion } from '../ai/rag/vectorCache';
import { questionHash } from '../ai/training/normalize';
import type { TrainingPair } from '../ai/training/parseImport';

const exampleSelect = {
  id: true,
  question: true,
  answer: true,
  source: true,
  status: true,
  conversationId: true,
  messageId: true,
  createdById: true,
  useCount: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AITrainingExampleSelect;

async function embedQuestions(organizationId: string, questions: string[]) {
  const assistant = await prisma.aIAssistant.findUnique({ where: { organizationId }, select: { provider: true } });
  const provider = getEmbeddingProvider(assistant?.provider);
  try {
    const results = await embedMany(provider, questions);
    return results.map((r, i) =>
      r.embedding.length ? r : { embedding: lexicalEmbedding(questions[i]), model: 'mock-lexical-256' },
    );
  } catch (error) {
    logger.warn({ err: error, organizationId }, 'training embedding failed, using lexical fallback');
    return questions.map((q) => ({ embedding: lexicalEmbedding(q), model: 'mock-lexical-256' }));
  }
}

// --- CRUD ------------------------------------------------------------------

export async function listTrainingExamples(
  organizationId: string,
  params: { page: number; pageSize: number; search?: string; source?: TrainingSource; status?: TrainingStatus },
) {
  const where: Prisma.AITrainingExampleWhereInput = { organizationId };
  if (params.source) where.source = params.source;
  if (params.status) where.status = params.status;
  if (params.search) {
    where.OR = [
      { question: { contains: params.search, mode: 'insensitive' } },
      { answer: { contains: params.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.aITrainingExample.findMany({
      where,
      select: exampleSelect,
      orderBy: { updatedAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.aITrainingExample.count({ where }),
  ]);
  return { items, total };
}

export async function trainingStats(organizationId: string) {
  const grouped = await prisma.aITrainingExample.groupBy({
    by: ['source', 'status'],
    where: { organizationId },
    _count: { _all: true },
  });
  const stats = { total: 0, active: 0, disabled: 0, manual: 0, inbox: 0, imported: 0 };
  for (const row of grouped) {
    const n = row._count._all;
    stats.total += n;
    if (row.status === TrainingStatus.ACTIVE) stats.active += n;
    else stats.disabled += n;
    if (row.source === TrainingSource.MANUAL) stats.manual += n;
    if (row.source === TrainingSource.INBOX) stats.inbox += n;
    if (row.source === TrainingSource.IMPORT) stats.imported += n;
  }
  return stats;
}

export interface TrainingInput {
  question: string;
  answer: string;
  status?: TrainingStatus;
  source?: TrainingSource;
  conversationId?: string;
  messageId?: string;
}

/**
 * Saves an approved answer. Teaching the same question again (from the inbox
 * or by hand) corrects the existing answer rather than adding a duplicate.
 */
export async function upsertTrainingExample(organizationId: string, userId: string | null, input: TrainingInput) {
  if (input.conversationId) {
    const owned = await prisma.conversation.count({ where: { id: input.conversationId, organizationId } });
    if (!owned) throw new NotFoundError('Conversation');
  }

  const hash = questionHash(input.question);
  if (!hash) throw new BadRequestError('The question is empty');
  const [vector] = await embedQuestions(organizationId, [input.question]);

  const example = await prisma.aITrainingExample.upsert({
    where: { organizationId_questionHash: { organizationId, questionHash: hash } },
    create: {
      organizationId,
      question: input.question,
      answer: input.answer,
      questionHash: hash,
      source: input.source ?? TrainingSource.MANUAL,
      status: input.status ?? TrainingStatus.ACTIVE,
      conversationId: input.conversationId,
      messageId: input.messageId,
      createdById: userId,
      embedding: vector.embedding,
      embeddingModel: vector.model,
    },
    update: {
      question: input.question,
      answer: input.answer,
      status: input.status ?? TrainingStatus.ACTIVE,
      embedding: vector.embedding,
      embeddingModel: vector.model,
      ...(input.conversationId ? { conversationId: input.conversationId, messageId: input.messageId } : {}),
    },
    select: exampleSelect,
  });

  await bumpKnowledgeVersion(organizationId);
  return example;
}

export async function updateTrainingExample(
  organizationId: string,
  exampleId: string,
  input: { question?: string; answer?: string; status?: TrainingStatus },
) {
  const existing = await prisma.aITrainingExample.findFirst({
    where: { id: exampleId, organizationId },
    select: { id: true, question: true },
  });
  if (!existing) throw new NotFoundError('Training example');

  const data: Prisma.AITrainingExampleUpdateInput = { ...input };
  if (input.question && input.question !== existing.question) {
    const [vector] = await embedQuestions(organizationId, [input.question]);
    data.questionHash = questionHash(input.question);
    data.embedding = vector.embedding;
    data.embeddingModel = vector.model;
  }

  const example = await prisma.aITrainingExample.update({ where: { id: exampleId }, data, select: exampleSelect });
  await bumpKnowledgeVersion(organizationId);
  return example;
}

export async function deleteTrainingExample(organizationId: string, exampleId: string) {
  const result = await prisma.aITrainingExample.deleteMany({ where: { id: exampleId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Training example');
  await bumpKnowledgeVersion(organizationId);
}

export async function bulkUpdateTraining(
  organizationId: string,
  ids: string[],
  action: 'enable' | 'disable' | 'delete',
) {
  const where = { organizationId, id: { in: ids } };
  const result =
    action === 'delete'
      ? await prisma.aITrainingExample.deleteMany({ where })
      : await prisma.aITrainingExample.updateMany({
          where,
          data: { status: action === 'enable' ? TrainingStatus.ACTIVE : TrainingStatus.DISABLED },
        });
  await bumpKnowledgeVersion(organizationId);
  return { affected: result.count };
}

export async function exportTraining(organizationId: string) {
  return prisma.aITrainingExample.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'asc' },
    select: { question: true, answer: true, status: true, source: true },
  });
}

/** Fire-and-forget usage counters for the Train Messages list. */
export function recordTrainingUse(organizationId: string, ids: string[]) {
  if (!ids.length) return;
  prisma.aITrainingExample
    .updateMany({
      where: { organizationId, id: { in: ids } },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    .catch((error) => logger.debug({ err: error }, 'failed to record training use'));
}

// --- imports ---------------------------------------------------------------

export async function createTrainingImport(
  organizationId: string,
  userId: string,
  fileName: string | undefined,
  pairs: TrainingPair[],
  errors: unknown[],
) {
  const record = await prisma.aITrainingImport.create({
    data: {
      organizationId,
      createdById: userId,
      fileName,
      total: pairs.length,
      payload: pairs as unknown as Prisma.InputJsonValue,
      errors: errors as Prisma.InputJsonValue,
    },
  });

  await aiQueue().add(
    'import-training',
    { organizationId, importId: record.id },
    { jobId: `training-import:${record.id}`, attempts: 3 },
  );
  return getTrainingImport(organizationId, record.id);
}

export async function getTrainingImport(organizationId: string, importId: string) {
  const record = await prisma.aITrainingImport.findFirst({
    where: { id: importId, organizationId },
    select: {
      id: true,
      status: true,
      fileName: true,
      total: true,
      imported: true,
      updated: true,
      skipped: true,
      errors: true,
      createdAt: true,
      completedAt: true,
    },
  });
  if (!record) throw new NotFoundError('Training import');
  return record;
}

const IMPORT_BATCH = 100;

/**
 * Runs on the AI queue. Embeds in batches, inserts new questions and updates
 * the answers of ones that already exist, reporting progress as it goes.
 * Safe to retry: progress restarts from the pairs not yet counted.
 */
export async function processTrainingImport(organizationId: string, importId: string) {
  const record = await prisma.aITrainingImport.findFirst({ where: { id: importId, organizationId } });
  if (!record || record.status === TrainingImportStatus.COMPLETED) return;

  const pairs = (record.payload as unknown as TrainingPair[] | null) ?? [];
  let done = record.imported + record.updated + record.skipped;

  await prisma.aITrainingImport.update({
    where: { id: importId },
    data: { status: TrainingImportStatus.PROCESSING },
  });

  try {
    for (let i = done; i < pairs.length; i += IMPORT_BATCH) {
      const batch = pairs.slice(i, i + IMPORT_BATCH).map((p) => ({ ...p, hash: questionHash(p.question) }));
      const valid = batch.filter((p) => p.hash);
      const vectors = await embedQuestions(organizationId, valid.map((p) => p.question));

      const existing = await prisma.aITrainingExample.findMany({
        where: { organizationId, questionHash: { in: valid.map((p) => p.hash) } },
        select: { id: true, questionHash: true },
      });
      const existingByHash = new Map(existing.map((e) => [e.questionHash, e.id]));

      const creates: Prisma.AITrainingExampleCreateManyInput[] = [];
      const updates: Prisma.PrismaPromise<unknown>[] = [];
      valid.forEach((pair, index) => {
        const vector = vectors[index];
        const id = existingByHash.get(pair.hash);
        if (id) {
          updates.push(
            prisma.aITrainingExample.update({
              where: { id },
              data: {
                question: pair.question,
                answer: pair.answer,
                status: TrainingStatus.ACTIVE,
                embedding: vector.embedding,
                embeddingModel: vector.model,
              },
            }),
          );
        } else {
          creates.push({
            organizationId,
            question: pair.question,
            answer: pair.answer,
            questionHash: pair.hash,
            source: TrainingSource.IMPORT,
            createdById: record.createdById,
            embedding: vector.embedding,
            embeddingModel: vector.model,
          });
        }
      });

      await prisma.$transaction([
        ...(creates.length ? [prisma.aITrainingExample.createMany({ data: creates, skipDuplicates: true })] : []),
        ...updates,
        prisma.aITrainingImport.update({
          where: { id: importId },
          data: {
            imported: { increment: creates.length },
            updated: { increment: updates.length },
            skipped: { increment: batch.length - valid.length },
          },
        }),
      ]);
      done += batch.length;
    }

    await prisma.aITrainingImport.update({
      where: { id: importId },
      data: { status: TrainingImportStatus.COMPLETED, completedAt: new Date(), payload: Prisma.DbNull },
    });
  } catch (error) {
    await prisma.aITrainingImport.update({
      where: { id: importId },
      data: { status: TrainingImportStatus.FAILED },
    });
    throw error;
  } finally {
    await bumpKnowledgeVersion(organizationId);
  }
}

/**
 * Re-embeds every approved answer — needed after switching AI provider, since
 * vectors from different embedding models cannot be compared.
 */
export async function reembedTraining(organizationId: string) {
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.aITrainingExample.findMany({
      where: { organizationId },
      select: { id: true, question: true },
      orderBy: { id: 'asc' },
      take: IMPORT_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!batch.length) break;

    const vectors = await embedQuestions(organizationId, batch.map((e) => e.question));
    await prisma.$transaction(
      batch.map((example, index) =>
        prisma.aITrainingExample.update({
          where: { id: example.id },
          data: { embedding: vectors[index].embedding, embeddingModel: vectors[index].model },
        }),
      ),
    );
    cursor = batch[batch.length - 1].id;
  }
  await bumpKnowledgeVersion(organizationId);
}
