import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { IntegrationError } from '../../utils/errors';
import { estimateTokens, type AIMessage, type AIProvider, type EmbeddingResult, type GenerateOptions, type GenerateResult } from '../types';

/**
 * Anthropic adapter (spec section 23).
 *
 * The assistant is asked to answer as JSON so we get a usable confidence
 * signal for the auto-reply threshold; malformed output degrades to the raw
 * text with a low confidence rather than failing the reply.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly supportsEmbeddings = false;

  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.ANTHROPIC_API_KEY;
    if (!key) throw new IntegrationError('ANTHROPIC_API_KEY is not configured');
    this.client = new Anthropic({ apiKey: key });
  }

  async generateResponse(messages: AIMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const system = [options.system, messages.find((m) => m.role === 'system')?.content]
      .filter(Boolean)
      .join('\n\n');

    const conversation = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const response = await this.client.messages.create({
      model: options.model || 'claude-opus-5',
      max_tokens: options.maxTokens ?? 1024,
      system,
      messages: conversation,
    });

    let text = '';
    // content is a discriminated union — narrow before reading .text.
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }

    const parsed = parseAssistantJson(text);

    return {
      text: parsed.answer,
      confidence: parsed.confidence,
      unanswered: parsed.unanswered,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      model: response.model,
      raw: { stopReason: response.stop_reason },
    };
  }

  async generateEmbedding(): Promise<EmbeddingResult> {
    // Anthropic does not serve an embeddings endpoint; retrieval falls back to
    // the lexical embedder in ai/rag/embedding.ts.
    throw new IntegrationError('The Anthropic provider does not support embeddings');
  }
}

/**
 * The prompt asks for {"answer": ..., "confidence": 0-1, "can_answer": bool}.
 * Plain prose is still accepted so a provider hiccup never blocks a reply.
 */
export function parseAssistantJson(text: string): {
  answer: string;
  confidence: number;
  unanswered: boolean;
} {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        answer?: string;
        confidence?: number;
        can_answer?: boolean;
      };
      if (typeof parsed.answer === 'string') {
        const confidence = clamp(parsed.confidence ?? 0.5);
        return {
          answer: parsed.answer.trim(),
          confidence,
          unanswered: parsed.can_answer === false,
        };
      }
    } catch {
      // fall through to prose handling
    }
  }

  return { answer: trimmed, confidence: 0.4, unanswered: !trimmed };
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0.4;
  return Math.min(1, Math.max(0, value));
}

export function estimatePromptTokens(messages: AIMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
