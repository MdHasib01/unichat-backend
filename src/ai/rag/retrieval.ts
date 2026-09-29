import crypto from 'crypto';
import { logger } from '../../lib/logger';
import { cacheGet, cacheSet } from '../../lib/redis';
import { getEmbeddingProvider } from '../provider.factory';
import { APPROVED_ANSWERS_HEADING, KNOWLEDGE_HEADING } from '../promptSections';
import { questionHash } from '../training/normalize';
import { lexicalEmbedding } from './embedding';
import { cosine, getOrgIndex } from './vectorCache';

export { APPROVED_ANSWERS_HEADING, KNOWLEDGE_HEADING };

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
}

export interface RetrievedExample {
  id: string;
  question: string;
  answer: string;
  score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  examples: RetrievedExample[];
  /** An approved answer whose normalized question is identical to this one. */
  exact: RetrievedExample | null;
}

/**
 * Retrieval step of the RAG pipeline (spec section 22).
 *
 * The organization's vectors come from the in-process cache (vectorCache.ts),
 * which is scoped by organizationId, so one tenant's assistant can never
 * surface another tenant's knowledge (spec section 21).
 */
export async function retrieve(
  organizationId: string,
  query: string,
  options: { topK?: number; examplesK?: number; provider?: string | null } = {},
): Promise<RetrievalResult> {
  const index = await getOrgIndex(organizationId);

  const exactHit = index.byHash.get(questionHash(query));
  const exact = exactHit
    ? { id: exactHit.id, question: exactHit.question, answer: exactHit.answer, score: 1 }
    : null;

  if (!index.chunks.length && !index.examples.length) return { chunks: [], examples: [], exact };

  const queryEmbedding = await embedQuery(organizationId, query, options.provider);

  // Lexical vectors score paraphrases lower than learned embeddings.
  const minChunkScore = 0.05;
  const minExampleScore = index.lexical ? 0.5 : 0.75;

  const chunks = index.chunks
    .map((c) => ({
      id: c.id,
      documentId: c.documentId,
      documentTitle: c.documentTitle,
      content: c.content,
      score: cosine(queryEmbedding, c.vector),
    }))
    .filter((c) => c.score >= minChunkScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.topK ?? 6);

  const examples = index.examples
    .map((e) => ({ id: e.id, question: e.question, answer: e.answer, score: cosine(queryEmbedding, e.vector) }))
    .filter((e) => e.score >= minExampleScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.examplesK ?? 3);

  return { chunks, examples, exact };
}

/** Kept for callers that only need document passages. */
export async function retrieveRelevantChunks(
  organizationId: string,
  query: string,
  options: { topK?: number; provider?: string | null } = {},
): Promise<RetrievedChunk[]> {
  return (await retrieve(organizationId, query, options)).chunks;
}

/**
 * Embeds a query, caching the vector for a day: customers ask the same
 * questions over and over, and an embedding call costs time and money.
 */
export async function embedQuery(
  organizationId: string,
  text: string,
  configuredProvider?: string | null,
): Promise<number[]> {
  const provider = getEmbeddingProvider(configuredProvider);
  const key = `ai:qemb:${provider.name}:${crypto.createHash('sha1').update(text).digest('hex')}`;

  const cached = await cacheGet<number[]>(key);
  if (cached?.length) return cached;

  try {
    const result = await provider.generateEmbedding(text);
    if (result.embedding.length) {
      await cacheSet(key, result.embedding, 24 * 3600);
      return result.embedding;
    }
  } catch (error) {
    logger.warn({ err: error, organizationId }, 'embedding provider failed, using lexical fallback');
  }
  return lexicalEmbedding(text);
}

/** Renders approved answers and passages into the per-question prompt context. */
export function formatKnowledgeContext(chunks: RetrievedChunk[], examples: RetrievedExample[] = []): string {
  const sections: string[] = [];

  if (examples.length) {
    const pairs = examples.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n');
    sections.push(
      `${APPROVED_ANSWERS_HEADING} (written by the business — when the customer asks the same thing, reuse the answer, adapting only wording)\n${pairs}`,
    );
  }

  if (chunks.length) {
    const passages = chunks.map((c, i) => `[${i + 1}] ${c.documentTitle}\n${c.content}`).join('\n\n');
    sections.push(`${KNOWLEDGE_HEADING}\n${passages}`);
  } else if (!examples.length) {
    sections.push(`${KNOWLEDGE_HEADING}\n(No matching business knowledge was found.)`);
  }

  return sections.join('\n\n');
}
