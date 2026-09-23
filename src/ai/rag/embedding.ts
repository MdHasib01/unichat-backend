import crypto from 'crypto';

export const LEXICAL_DIMENSIONS = 256;

/**
 * Deterministic hashed bag-of-words embedding.
 *
 * It keeps retrieval working with zero external dependencies (MOCK_MODE, or an
 * organization that has not supplied an AI key yet). When a real embedding
 * provider is configured the pipeline uses that instead — the storage format
 * and the cosine search are identical either way.
 */
export function lexicalEmbedding(text: string, dimensions = LEXICAL_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

  for (const token of tokens) {
    const hash = crypto.createHash('md5').update(token).digest();
    const index = hash.readUInt32BE(0) % dimensions;
    // Sign spreads tokens across the space instead of piling up on +1.
    const sign = hash[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  return normalize(vector);
}

export function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

export function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * Splits a document into overlapping chunks on sentence boundaries so a
 * retrieved passage keeps its surrounding context.
 */
export function chunkText(text: string, chunkSize = 900, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= chunkSize) return clean ? [clean] : [];

  const sentences = clean.split(/(?<=[.!?])\s+|\n{2,}/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > chunkSize && current) {
      chunks.push(current.trim());
      current = overlap > 0 ? `${current.slice(-overlap)} ${sentence}` : sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  // A single sentence longer than chunkSize still has to be split.
  return chunks.flatMap((chunk) =>
    chunk.length <= chunkSize * 1.5 ? [chunk] : hardSplit(chunk, chunkSize),
  );
}

function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
