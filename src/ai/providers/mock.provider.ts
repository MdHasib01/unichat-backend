import { estimateTokens, type AIMessage, type AIProvider, type EmbeddingResult, type GenerateOptions, type GenerateResult } from '../types';
import { lexicalEmbedding } from '../rag/embedding';

/**
 * Offline assistant used when no AI key is configured (MOCK_MODE).
 *
 * It answers strictly from the retrieved knowledge already placed in the
 * prompt — it does not invent business facts. When the knowledge does not
 * cover the question it reports low confidence so the handoff path runs,
 * which is exactly the behaviour a real provider should produce.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  readonly supportsEmbeddings = true;

  async generateResponse(messages: AIMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const question = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const context = options.system ?? messages.find((m) => m.role === 'system')?.content ?? '';

    const knowledge = extractKnowledgeSection(context);
    const best = knowledge.length ? bestMatchingPassage(question, knowledge) : null;

    if (!best || best.score < 0.12) {
      return {
        text: '',
        confidence: 0.2,
        unanswered: true,
        tokensUsed: estimateTokens(question) + estimateTokens(context),
        model: 'mock-assistant',
      };
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
}

function extractKnowledgeSection(context: string): string[] {
  const marker = context.indexOf('BUSINESS KNOWLEDGE');
  const body = marker >= 0 ? context.slice(marker) : context;
  return body
    .split(/\n{2,}|\n-{3,}\n/)
    .map((p) => p.replace(/^\s*[-*]\s*/, '').trim())
    .filter((p) => p.length > 24 && !p.startsWith('BUSINESS KNOWLEDGE'));
}

function bestMatchingPassage(
  question: string,
  passages: string[],
): { passage: string; score: number } | null {
  const qTokens = tokenize(question);
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
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

export const mockAIProvider = new MockAIProvider();
