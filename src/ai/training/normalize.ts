import crypto from 'crypto';

/**
 * Normalizes a customer question so trivially different phrasings of the same
 * text ("Do you deliver?" / "do you deliver") hash identically.
 */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    // Keep combining marks (\p{M}): Bengali, Hindi, Arabic vowel signs are marks.
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function questionHash(text: string): string {
  return crypto.createHash('sha1').update(normalizeQuestion(text)).digest('hex');
}
