/**
 * Parses a JSON training file into question → answer pairs.
 *
 * Accepted shapes (auto-detected, and may be wrapped as { "examples": [...] },
 * { "data": [...] }, { "conversations": [...] } or { "messages": [...] }):
 *
 *   1. Pairs:
 *      [{ "question": "…", "answer": "…" }]
 *      with the aliases message/reply, q/a, input/output, prompt/completion,
 *      customer/agent.
 *
 *   2. Transcripts:
 *      [{ "messages": [{ "role": "customer", "content": "…" },
 *                      { "role": "agent",    "content": "…" }] }]
 *      Roles customer|user|visitor|client|contact ask; agent|assistant|
 *      business|support|staff|bot answer. Consecutive turns from the same side
 *      are merged, then every customer → business exchange becomes a pair.
 *      A single bare transcript ({ "messages": [...] } or an array of turns) works too.
 */

export const MAX_QUESTION = 2000;
export const MAX_ANSWER = 4000;
export const MAX_PAIRS = 5000;

export interface TrainingPair {
  question: string;
  answer: string;
}

export interface ParseResult {
  pairs: TrainingPair[];
  errors: Array<{ index: number; message: string }>;
  skipped: number;
  format: 'pairs' | 'transcripts' | 'unknown';
}

const QUESTION_KEYS = ['question', 'message', 'q', 'input', 'prompt', 'customer', 'query'];
const ANSWER_KEYS = ['answer', 'reply', 'a', 'output', 'completion', 'agent', 'response'];
const ASKER_ROLES = new Set(['customer', 'user', 'visitor', 'client', 'contact', 'human', 'inbound']);
const ANSWER_ROLES = new Set(['agent', 'assistant', 'business', 'support', 'staff', 'bot', 'ai', 'outbound']);

type Json = unknown;

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(record: Record<string, Json>, keys: string[]): string | undefined {
  for (const key of Object.keys(record)) {
    if (keys.includes(key.toLowerCase()) && typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

function clean(text: string, max: number): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
}

function unwrap(data: Json): Json[] | null {
  if (Array.isArray(data)) return data;
  if (isObject(data)) {
    for (const key of ['examples', 'data', 'pairs', 'items', 'conversations', 'transcripts']) {
      if (Array.isArray(data[key])) return data[key] as Json[];
    }
    // A single transcript object.
    if (Array.isArray(data.messages)) return [data];
  }
  return null;
}

function isTurn(value: Json): boolean {
  return isObject(value) && typeof value.role === 'string' && (typeof value.content === 'string' || typeof value.text === 'string');
}

function turnsOf(value: Json): Json[] | null {
  if (isObject(value) && Array.isArray(value.messages)) return value.messages as Json[];
  if (Array.isArray(value) && value.every(isTurn)) return value;
  return null;
}

function pairsFromTranscript(turns: Json[]): TrainingPair[] {
  // Merge consecutive turns from the same side.
  const merged: Array<{ side: 'ask' | 'answer'; text: string }> = [];
  for (const turn of turns) {
    if (!isObject(turn) || typeof turn.role !== 'string') continue;
    const role = turn.role.toLowerCase();
    const side = ASKER_ROLES.has(role) ? 'ask' : ANSWER_ROLES.has(role) ? 'answer' : null;
    const text = typeof turn.content === 'string' ? turn.content : typeof turn.text === 'string' ? turn.text : '';
    if (!side || !text.trim()) continue;
    const last = merged[merged.length - 1];
    if (last && last.side === side) last.text += `\n${text.trim()}`;
    else merged.push({ side, text: text.trim() });
  }

  const pairs: TrainingPair[] = [];
  for (let i = 0; i < merged.length - 1; i += 1) {
    if (merged[i].side === 'ask' && merged[i + 1].side === 'answer') {
      pairs.push({ question: merged[i].text, answer: merged[i + 1].text });
      i += 1;
    }
  }
  return pairs;
}

export function parseTrainingImport(data: Json): ParseResult {
  const result: ParseResult = { pairs: [], errors: [], skipped: 0, format: 'unknown' };

  // A bare transcript: an array of role/content turns.
  const items = Array.isArray(data) && data.length > 0 && data.every(isTurn) ? [data] : unwrap(data);
  if (!items) {
    result.errors.push({ index: -1, message: 'Expected a JSON array of question/answer pairs or conversations' });
    return result;
  }

  const seen = new Set<string>();
  const add = (pair: TrainingPair, index: number) => {
    const question = clean(pair.question, MAX_QUESTION);
    const answer = clean(pair.answer, MAX_ANSWER);
    if (!question || !answer) {
      result.skipped += 1;
      return;
    }
    const key = question.toLowerCase();
    if (seen.has(key)) {
      // The last answer for a question wins, matching how re-imports behave.
      const existing = result.pairs.findIndex((p) => p.question.toLowerCase() === key);
      if (existing >= 0) result.pairs[existing] = { question, answer };
      result.skipped += 1;
      return;
    }
    if (result.pairs.length >= MAX_PAIRS) {
      if (result.errors.length < 50) result.errors.push({ index, message: `Only the first ${MAX_PAIRS} pairs are imported` });
      result.skipped += 1;
      return;
    }
    seen.add(key);
    result.pairs.push({ question, answer });
  };

  items.forEach((item, index) => {
    const turns = turnsOf(item);
    if (turns) {
      result.format = result.format === 'pairs' ? 'pairs' : 'transcripts';
      const pairs = pairsFromTranscript(turns);
      if (!pairs.length) {
        result.skipped += 1;
        if (result.errors.length < 50) result.errors.push({ index, message: 'No customer → agent exchange found in this conversation' });
      }
      pairs.forEach((pair) => add(pair, index));
      return;
    }

    if (isObject(item)) {
      const question = pick(item, QUESTION_KEYS);
      const answer = pick(item, ANSWER_KEYS);
      if (question !== undefined && answer !== undefined) {
        result.format = result.format === 'transcripts' ? 'transcripts' : 'pairs';
        add({ question, answer }, index);
        return;
      }
    }

    result.skipped += 1;
    if (result.errors.length < 50) {
      result.errors.push({ index, message: 'Missing a question/answer (or message/reply) pair' });
    }
  });

  return result;
}
