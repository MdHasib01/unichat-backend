import { KnowledgeDocumentStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { getEmbeddingProvider } from '../provider.factory';
import { chunkText, lexicalEmbedding } from './embedding';
import { estimateTokens } from '../types';

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

    // Replace previous chunks so re-ingestion is idempotent.
    await prisma.aIKnowledgeChunk.deleteMany({ where: { documentId, organizationId } });

    let totalTokens = 0;
    const rows: Array<{
      organizationId: string;
      documentId: string;
      chunkIndex: number;
      content: string;
      tokenCount: number;
      embedding: number[];
      embeddingModel: string;
    }> = [];

    for (const [index, content] of chunks.entries()) {
      let embedding: number[];
      let model = 'mock-lexical-256';

      try {
        const result = await provider.generateEmbedding(content);
        embedding = result.embedding.length ? result.embedding : lexicalEmbedding(content);
        model = result.embedding.length ? result.model : model;
      } catch (error) {
        logger.warn({ err: error, documentId }, 'embedding failed for chunk, using lexical fallback');
        embedding = lexicalEmbedding(content);
      }

      const tokenCount = estimateTokens(content);
      totalTokens += tokenCount;

      rows.push({
        organizationId,
        documentId,
        chunkIndex: index,
        content,
        tokenCount,
        embedding,
        embeddingModel: model,
      });
    }

    if (rows.length) await prisma.aIKnowledgeChunk.createMany({ data: rows });

    await prisma.aIKnowledgeDocument.update({
      where: { id: documentId },
      data: {
        status: KnowledgeDocumentStatus.READY,
        chunkCount: rows.length,
        tokenCount: totalTokens,
        error: null,
      },
    });

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
