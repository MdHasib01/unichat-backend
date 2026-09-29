import { KnowledgeDocumentStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { getEmbeddingProvider } from '../provider.factory';
import { chunkText, lexicalEmbedding } from './embedding';
import { embedMany, estimateTokens } from '../types';
import { bumpKnowledgeVersion } from './vectorCache';

/**
 * Ingestion step of the RAG pipeline: document → chunking → embedding →
 * vector storage (spec section 22). Runs in the AI worker, never inline.
 */
export async function ingestDocument(organizationId: string, documentId: string): Promise<void> {
  const document = await prisma.aIKnowledgeDocument.findFirst({
    where: { id: documentId, organizationId },
  });

  if (!document) {
    logger.warn({ documentId, organizationId }, 'knowledge document not found for ingestion');
    return;
  }

  await prisma.aIKnowledgeDocument.update({
    where: { id: documentId },
    data: { status: KnowledgeDocumentStatus.PROCESSING, error: null },
  });

  try {
    const assistant = await prisma.aIAssistant.findUnique({
      where: { organizationId },
      select: { provider: true },
    });

    const chunks = chunkText(document.content);
    const provider = getEmbeddingProvider(assistant?.provider);

    // One batched call instead of one request per chunk.
    let vectors: Array<{ embedding: number[]; model: string }>;
    try {
      vectors = (await embedMany(provider, chunks)).map((r, i) =>
        r.embedding.length ? r : { embedding: lexicalEmbedding(chunks[i]), model: 'mock-lexical-256' },
      );
    } catch (error) {
      logger.warn({ err: error, documentId }, 'embedding failed, using lexical fallback');
      vectors = chunks.map((content) => ({ embedding: lexicalEmbedding(content), model: 'mock-lexical-256' }));
    }

    let totalTokens = 0;
    const rows = chunks.map((content, index) => {
      const tokenCount = estimateTokens(content);
      totalTokens += tokenCount;
      return {
        organizationId,
        documentId,
        chunkIndex: index,
        content,
        tokenCount,
        embedding: vectors[index].embedding,
        embeddingModel: vectors[index].model,
      };
    });

    // Swap old chunks for new in one step so re-ingestion is idempotent and a
    // failed embedding never leaves the document empty.
    await prisma.$transaction([
      prisma.aIKnowledgeChunk.deleteMany({ where: { documentId, organizationId } }),
      prisma.aIKnowledgeChunk.createMany({ data: rows }),
    ]);

    await prisma.aIKnowledgeDocument.update({
      where: { id: documentId },
      data: {
        status: KnowledgeDocumentStatus.READY,
        chunkCount: rows.length,
        tokenCount: totalTokens,
        error: null,
      },
    });

    await bumpKnowledgeVersion(organizationId);
    logger.info({ documentId, organizationId, chunks: rows.length }, 'knowledge document ingested');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingestion failed';
    await prisma.aIKnowledgeDocument.update({
      where: { id: documentId },
      data: { status: KnowledgeDocumentStatus.FAILED, error: message.slice(0, 500) },
    });
    throw error;
  }
}

/** Builds a knowledge document out of the organization's product catalogue. */
export async function buildProductKnowledge(organizationId: string): Promise<string> {
  const products = await prisma.product.findMany({
    where: { organizationId, isActive: true },
    orderBy: { name: 'asc' },
    take: 500,
  });

  if (!products.length) return '';

  return products
    .map((p) =>
      [
        `Product: ${p.name}`,
        p.sku ? `SKU: ${p.sku}` : null,
        `Price: ${p.price.toString()} ${p.currency}`,
        p.category ? `Category: ${p.category}` : null,
        p.trackInventory ? `In stock: ${p.stock}` : null,
        p.description ? `Details: ${p.description}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}
