export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Stable instructions: persona, rules, business profile. Identical across
   * turns, so providers can cache it.
   */
  system?: string;
  /**
   * Per-question context (retrieved knowledge, approved answers). Providers
   * place it after the cached prefix — in the final user turn — so it never
   * invalidates the cache for the conversation history.
   */
  context?: string;
}

export interface GenerateResult {
  text: string;
  /**
   * 0–1 self-reported answer confidence. Auto-reply is gated on it
   * (spec section 24); below the organization's threshold we hand off.
   */
  confidence: number;
  tokensUsed: number;
  model: string;
  /** True when the assistant explicitly signalled it could not answer. */
  unanswered: boolean;
  raw?: unknown;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokensUsed: number;
}

/**
 * Provider contract (spec section 23). The rest of the system talks only to
 * this interface, so swapping or adding a provider is a one-file change.
 */
export interface AIProvider {
  readonly name: string;

  generateResponse(messages: AIMessage[], options: GenerateOptions): Promise<GenerateResult>;

  generateEmbedding(text: string, model?: string): Promise<EmbeddingResult>;

  /** Optional batch form; callers fall back to one call per text. */
  generateEmbeddings?(texts: string[], model?: string): Promise<EmbeddingResult[]>;

  readonly supportsEmbeddings: boolean;
}

/** Rough token estimate — good enough for budgeting and usage metering. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Embeds many texts with the provider's batch endpoint when it has one. */
export async function embedMany(provider: AIProvider, texts: string[]): Promise<EmbeddingResult[]> {
  if (provider.generateEmbeddings) return provider.generateEmbeddings(texts);
  const results: EmbeddingResult[] = [];
  for (const text of texts) results.push(await provider.generateEmbedding(text));
  return results;
}

/** Folds per-question context into the last user turn. */
export function withContext(messages: AIMessage[], context?: string): AIMessage[] {
  if (!context) return messages;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role === 'user') {
      out[i] = { role: 'user', content: `${context}\n\nCUSTOMER MESSAGE\n${out[i].content}` };
      return out;
    }
  }
  return [...out, { role: 'user', content: context }];
}
