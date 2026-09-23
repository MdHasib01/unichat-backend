export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
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

  readonly supportsEmbeddings: boolean;
}

/** Rough token estimate — good enough for budgeting and usage metering. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
