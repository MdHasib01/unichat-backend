import { KnowledgeDocumentStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { getEmbeddingProvider } from '../provider.factory';
import { cosineSimilarity, lexicalEmbedding } from './embedding';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
}

/**
 * Retrieval step of the RAG pipeline (spec section 22).
 *
 * Every query is filtered by organizationId first, so one tenant's assistant
 * can never surface another tenant's knowledge (spec section 21).
 *
 * Similarity is computed in the application because chunks are stored as float
 * arrays; moving to pgvector later changes only this function.
 */
export async function retrieveRelevantChunks(
  organizationId: string,
  query: string,
  options: { topK?: number; minScore?: number; provider?: string | null } = {},
): Promise<RetrievedChunk[]> {
  const topK = options.topK ?? 6;
  const minScore = options.minScore ?? 0.05;

  const chunks = await prisma.aIKnowledgeChunk.findMany({
    where: {
      organizationId,
      document: { status: KnowledgeDocumentStatus.READY },
    },
    select: {
      id: true,
      documentId: true,
      content: true,
      embedding: true,
      document: { select: { title: true } },
    },
    // Guardrail for very large knowledge bases before pgvector is introduced.
    take: 2_000,
  });

  if (!chunks.length) return [];

  const queryEmbedding = await embedQuery(organizationId, query, options.provider);

  const scored = chunks
    .map((chunk) => ({
      id: chunk.id,
      documentId: chunk.documentId,
      documentTitle: chunk.document.title,
      content: chunk.content,
      score:
        chunk.embedding.length === queryEmbedding.length
          ? cosineSimilarity(queryEmbedding, chunk.embedding)
          : 0,
    }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

export async function embedQuery(
  organizationId: string,
  text: string,
  configuredProvider?: string | null,
): Promise<number[]> {
  try {
    const provider = getEmbeddingProvider(configuredProvider);
    const result = await provider.generateEmbedding(text);
    if (result.embedding.length) return result.embedding;
  } catch (error) {
    logger.warn({ err: error, organizationId }, 'embedding provider failed, using lexical fallback');
  }
  return lexicalEmbedding(text);
}

/** Renders retrieved passages into the prompt block the assistant reads. */
export function formatKnowledgeContext(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return 'BUSINESS KNOWLEDGE\n(No matching business knowledge was found.)';

  const passages = chunks
    .map((c, i) => `[${i + 1}] ${c.documentTitle}\n${c.content}`)
    .join('\n\n');

  return `BUSINESS KNOWLEDGE\n${passages}`;
}
