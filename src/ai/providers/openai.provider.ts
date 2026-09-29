import OpenAI from 'openai';
import { env } from '../../config/env';
import { IntegrationError } from '../../utils/errors';
import { parseAssistantJson } from './anthropic.provider';
import {
  withContext,
  type AIMessage,
  type AIProvider,
  type EmbeddingResult,
  type GenerateOptions,
  type GenerateResult,
} from '../types';

/** The embeddings endpoint accepts batches; keep each request modest. */
const EMBEDDING_BATCH = 96;

/** OpenAI adapter — the second concrete provider behind the AIProvider port. */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  readonly supportsEmbeddings = true;

  private client: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.OPENAI_API_KEY;
    if (!key) throw new IntegrationError('OPENAI_API_KEY is not configured');
    this.client = new OpenAI({ apiKey: key, timeout: 45_000, maxRetries: 2 });
  }

  async generateResponse(messages: AIMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const turns = withContext(messages, options.context);
    const payload: AIMessage[] = options.system ? [{ role: 'system', content: options.system }, ...turns] : turns;

    const response = await this.client.chat.completions.create({
      model: options.model?.startsWith('claude-') ? 'gpt-4o-mini' : options.model || 'gpt-4o-mini',
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
    const [result] = await this.generateEmbeddings([text], model);
    return result;
  }

  async generateEmbeddings(texts: string[], model?: string): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH);
      const response = await this.client.embeddings.create({
        model: model || env.AI_EMBEDDING_MODEL,
        input: batch,
      });
      const tokensEach = Math.ceil((response.usage?.total_tokens ?? 0) / batch.length);
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      for (const item of ordered) {
        results.push({ embedding: item.embedding, model: response.model, tokensUsed: tokensEach });
      }
    }

    return results;
  }
}
