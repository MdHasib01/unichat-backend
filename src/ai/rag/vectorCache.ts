import { KnowledgeDocumentStatus, TrainingStatus } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { getRedis } from '../../lib/redis';

/**
 * In-process cache of each organization's knowledge and training vectors.
 *
 * Retrieval used to read every chunk embedding from Postgres on every reply.
 * Now each worker loads an organization's vectors once and keeps them until
 * the organization's knowledge version (a Redis counter bumped on any
 * knowledge or training change) moves on. Memory is bounded by an LRU over
 * all tenants (AI_VECTOR_CACHE_MB).
 */

export interface IndexedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  vector: Float32Array;
}

export interface IndexedExample {
  id: string;
  question: string;
  answer: string;
  questionHash: string;
  vector: Float32Array;
}

export interface OrgIndex {
  version: string;
  chunks: IndexedChunk[];
  examples: IndexedExample[];
  byHash: Map<string, IndexedExample>;
  /** True when vectors come from the offline lexical embedder. */
  lexical: boolean;
  bytes: number;
}

const MAX_ROWS = 10_000;
const maxBytes = env.AI_VECTOR_CACHE_MB * 1024 * 1024;

const cache = new Map<string, OrgIndex>();
let totalBytes = 0;
const loading = new Map<string, Promise<OrgIndex>>();

const versionKey = (organizationId: string) => `ai:kbv:${organizationId}`;

/** Current knowledge version, or null when Redis is unavailable (no caching then). */
async function currentVersion(organizationId: string): Promise<string | null> {
  try {
    const redis = getRedis();
    if (redis.status !== 'ready') return null;
    return (await redis.get(versionKey(organizationId))) ?? '0';
  } catch {
    return null;
  }
}

/** Call after any change to an organization's knowledge or training. */
export async function bumpKnowledgeVersion(organizationId: string): Promise<void> {
  cache.delete(organizationId);
  try {
    const redis = getRedis();
    if (redis.status === 'ready') await redis.incr(versionKey(organizationId));
  } catch {
    /* other processes fall back to their TTL-free check on next read */
  }
}

function sizeOf(index: Omit<OrgIndex, 'bytes'>): number {
  let bytes = 0;
  for (const c of index.chunks) bytes += c.vector.byteLength + c.content.length * 2 + 200;
  for (const e of index.examples) bytes += e.vector.byteLength + (e.question.length + e.answer.length) * 2 + 200;
  return bytes;
}

function remember(organizationId: string, index: OrgIndex) {
  const previous = cache.get(organizationId);
  if (previous) totalBytes -= previous.bytes;
  cache.delete(organizationId);
  cache.set(organizationId, index);
  totalBytes += index.bytes;

  // Evict least recently used tenants until we fit.
  for (const [key, value] of cache) {
    if (totalBytes <= maxBytes || key === organizationId) break;
    cache.delete(key);
    totalBytes -= value.bytes;
  }
}

async function build(organizationId: string, version: string): Promise<OrgIndex> {
  const [chunks, examples] = await Promise.all([
    prisma.aIKnowledgeChunk.findMany({
      where: { organizationId, document: { status: KnowledgeDocumentStatus.READY } },
      select: {
        id: true,
        documentId: true,
        content: true,
        embedding: true,
        embeddingModel: true,
        document: { select: { title: true } },
      },
      take: MAX_ROWS,
    }),
    prisma.aITrainingExample.findMany({
      where: { organizationId, status: TrainingStatus.ACTIVE },
      select: { id: true, question: true, answer: true, questionHash: true, embedding: true, embeddingModel: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_ROWS,
    }),
  ]);

  const indexedExamples = examples.map((e) => ({
    id: e.id,
    question: e.question,
    answer: e.answer,
    questionHash: e.questionHash,
    vector: Float32Array.from(e.embedding),
  }));

  const models = [...chunks.map((c) => c.embeddingModel), ...examples.map((e) => e.embeddingModel)].filter(Boolean);
  const base = {
    version,
    chunks: chunks.map((c) => ({
      id: c.id,
      documentId: c.documentId,
      documentTitle: c.document.title,
      content: c.content,
      vector: Float32Array.from(c.embedding),
    })),
    examples: indexedExamples,
    byHash: new Map(indexedExamples.map((e) => [e.questionHash, e])),
    lexical: models.length === 0 || models.every((m) => m?.startsWith('mock-lexical')),
  };

  return { ...base, bytes: sizeOf(base) };
}

/** Returns the organization's vectors, loading them at most once per version. */
export async function getOrgIndex(organizationId: string): Promise<OrgIndex> {
  const version = await currentVersion(organizationId);

  if (version !== null) {
    const hit = cache.get(organizationId);
    if (hit && hit.version === version) {
      // Refresh LRU position.
      cache.delete(organizationId);
      cache.set(organizationId, hit);
      return hit;
    }
  }

  const loadKey = `${organizationId}:${version ?? 'nocache'}`;
  const inFlight = loading.get(loadKey);
  if (inFlight) return inFlight;

  const promise = build(organizationId, version ?? 'nocache')
    .then((index) => {
      if (version !== null) remember(organizationId, index);
      return index;
    })
    .finally(() => loading.delete(loadKey));

  loading.set(loadKey, promise);
  return promise;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
