import OpenAI from 'openai';
import { env } from '../../config/env';
import { IntegrationError } from '../../utils/errors';
import { parseAssistantJson } from './anthropic.provider';
import type {
  AIMessage,
  AIProvider,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
} from '../types';

/** OpenAI adapter — the second concrete provider behind the AIProvider port. */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  readonly supportsEmbeddings = true;

  private client: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.OPENAI_API_KEY;
    if (!key) throw new IntegrationError('OPENAI_API_KEY is not configured');
    this.client = new OpenAI({ apiKey: key });
  }

  async generateResponse(messages: AIMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const payload: AIMessage[] = options.system
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages;

    const response = await this.client.chat.completions.create({
      model: options.model || 'gpt-4o-mini',
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 600,
      response_format: { type: 'json_object' },
      messages: payload.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = response.choices[0]?.message?.content ?? '';
    const parsed = parseAssistantJson(text);

    return {
      text: parsed.answer,
      confidence: parsed.confidence,
      unanswered: parsed.unanswered,
      tokensUsed: response.usage?.total_tokens ?? 0,
      model: response.model,
    };
  }

  async generateEmbedding(text: string, model?: string): Promise<EmbeddingResult> {
    const response = await this.client.embeddings.create({
      model: model || env.AI_EMBEDDING_MODEL,
      input: text,
    });

    return {
      embedding: response.data[0]?.embedding ?? [],
      model: response.model,
      tokensUsed: response.usage?.total_tokens ?? 0,
    };
  }
}
