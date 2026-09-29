import { estimateTokens, type AIMessage, type AIProvider, type EmbeddingResult, type GenerateOptions, type GenerateResult } from '../types';
import { lexicalEmbedding } from '../rag/embedding';
import { APPROVED_ANSWERS_HEADING, KNOWLEDGE_HEADING } from '../promptSections';

/**
 * Offline assistant used when no AI key is configured (MOCK_MODE).
 *
 * It answers strictly from what was placed in the prompt — approved answers
 * first, then retrieved knowledge — and never invents business facts. When
 * neither covers the question it reports low confidence so the handoff path
 * runs, which is exactly the behaviour a real provider should produce.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  readonly supportsEmbeddings = true;

  async generateResponse(messages: AIMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const question = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const context = options.context ?? options.system ?? messages.find((m) => m.role === 'system')?.content ?? '';
    const tokensUsed = estimateTokens(question) + estimateTokens(context);

    // Approved answers are the business's own words — prefer them.
    const approved = bestApprovedAnswer(question, extractApprovedAnswers(context));
    if (approved && approved.score >= 0.5) {
      return {
        text: approved.answer,
        confidence: Math.min(0.97, 0.6 + approved.score * 0.4),
        unanswered: false,
        tokensUsed,
        model: 'mock-assistant',
      };
    }

    const knowledge = extractKnowledgeSection(context);
    const best = knowledge.length ? bestMatchingPassage(question, knowledge) : null;

    if (!best || best.score < 0.12) {
      return { text: '', confidence: 0.2, unanswered: true, tokensUsed, model: 'mock-assistant' };
    }

    return {
      text: best.passage.trim(),
      // Retrieval overlap doubles as the confidence signal in mock mode.
      confidence: Math.min(0.95, 0.45 + best.score),
      unanswered: false,
      tokensUsed: estimateTokens(question) + estimateTokens(best.passage),
      model: 'mock-assistant',
    };
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    return {
      embedding: lexicalEmbedding(text),
      model: 'mock-lexical-256',
      tokensUsed: estimateTokens(text),
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((text) => this.generateEmbedding(text)));
  }
}

function extractApprovedAnswers(context: string): Array<{ question: string; answer: string }> {
  const start = context.indexOf(APPROVED_ANSWERS_HEADING);
  if (start < 0) return [];
  const end = context.indexOf(KNOWLEDGE_HEADING, start);
  const section = context.slice(start, end > start ? end : undefined);

  const pairs: Array<{ question: string; answer: string }> = [];
  for (const match of section.matchAll(/Q: ([\s\S]*?)\nA: ([\s\S]*?)(?=\n\nQ: |\n*$)/g)) {
    pairs.push({ question: match[1].trim(), answer: match[2].trim() });
  }
  return pairs;
}

function bestApprovedAnswer(question: string, pairs: Array<{ question: string; answer: string }>) {
  const asked = tokenize(stripCustomerPrefix(question));
  if (!asked.size) return null;

  let best: { answer: string; score: number } | null = null;
  for (const pair of pairs) {
    const known = tokenize(pair.question);
    if (!known.size) continue;
    let overlap = 0;
    for (const token of asked) if (known.has(token)) overlap += 1;
    // Symmetric overlap: short and long phrasings of the same question both match.
    const score = overlap / Math.max(asked.size, known.size);
    if (!best || score > best.score) best = { answer: pair.answer, score };
  }
  return best;
}

/** The last user turn carries context ahead of the customer's own words. */
function stripCustomerPrefix(content: string): string {
  const marker = content.lastIndexOf('CUSTOMER MESSAGE\n');
  return marker >= 0 ? content.slice(marker + 'CUSTOMER MESSAGE\n'.length) : content;
}

function extractKnowledgeSection(context: string): string[] {
  const marker = context.indexOf(KNOWLEDGE_HEADING);
  if (marker < 0) return [];
  // Skip the heading line itself so the first passage is not glued to it.
  const start = context.indexOf('\n', marker);
  if (start < 0) return [];
  const end = context.indexOf('CUSTOMER MESSAGE', start);
  const body = context.slice(start + 1, end > start ? end : undefined);
  return body
    .split(/\n{2,}|\n-{3,}\n/)
    .map((p) => p.replace(/^\s*[-*]\s*/, '').replace(/^\[\d+\][^\n]*\n/, '').trim())
    .filter((p) => p.length > 24);
}

function bestMatchingPassage(
  question: string,
  passages: string[],
): { passage: string; score: number } | null {
  const qTokens = tokenize(stripCustomerPrefix(question));
  if (!qTokens.size) return null;

  let best: { passage: string; score: number } | null = null;

  for (const passage of passages) {
    const pTokens = tokenize(passage);
    let overlap = 0;
    for (const token of qTokens) if (pTokens.has(token)) overlap += 1;
    const score = overlap / qTokens.size;
    if (!best || score > best.score) best = { passage, score };
  }

  return best;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'you', 'your', 'i', 'we', 'to', 'of', 'and', 'or',
  'for', 'in', 'on', 'at', 'it', 'this', 'that', 'what', 'how', 'can', 'me', 'my', 'have', 'has',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

export const mockAIProvider = new MockAIProvider();
