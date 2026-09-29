import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { IntegrationError } from '../../utils/errors';
import {
  estimateTokens,
  withContext,
  type AIMessage,
  type AIProvider,
  type EmbeddingResult,
  type GenerateOptions,
  type GenerateResult,
} from '../types';

/** Current default; organizations can pick another model in AI Setup. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Shape every reply must take — enforced by structured outputs. */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The reply to send to the customer. Empty when you cannot answer.' },
    confidence: { type: 'number', description: 'How sure you are the answer is correct and grounded, 0 to 1.' },
    can_answer: { type: 'boolean', description: 'False when the business knowledge does not cover the question.' },
  },
  required: ['answer', 'confidence', 'can_answer'],
  additionalProperties: false,
} as const;

/** Models that take `output_config.effort` (Haiku 4.5 and older models reject it). */
function supportsEffort(model: string): boolean {
  return /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[5-9]|sonnet-4-[6-9])/.test(model);
}

/** Models with structured outputs; older ones fall back to prompt-only JSON. */
function supportsStructuredOutput(model: string): boolean {
  return /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[1-9]|sonnet-4-[5-9]|haiku-4-5)/.test(model);
}

/**
 * Server-side refusal fallback: if a safety classifier declines, the API
 * re-runs the same request on a suitable model inside the same call.
 */
function supportsFallbacks(model: string): boolean {
  return /^claude-(fable-5|opus-5|sonnet-5-5)/.test(model);
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Anthropic adapter (spec section 23).
 *
 * Request layout is built for prompt caching — the cache is a prefix match:
 *   system (persona + rules, stable)          ← breakpoint
 *   conversation history (grows append-only)  ← breakpoint on the last turn
 *   final user turn: retrieved knowledge + the customer's message (volatile)
 * so each new message re-reads the cached prefix instead of paying for it again.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly supportsEmbeddings = false;

  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.ANTHROPIC_API_KEY;
    if (!key) throw new IntegrationError('ANTHROPIC_API_KEY is not configured');
    // A customer is waiting: fail fast and let the job's retry/handoff take over.
    this.client = new Anthropic({ apiKey: key, timeout: 45_000, maxRetries: 2 });
  }

  async generateResponse(messages: AIMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const model = options.model?.startsWith('claude-') ? options.model : DEFAULT_ANTHROPIC_MODEL;

    const system = [options.system, ...messages.filter((m) => m.role === 'system').map((m) => m.content)]
      .filter(Boolean)
      .join('\n\n');

    const turns = withContext(
      dropLeadingAssistant(messages.filter((m) => m.role !== 'system' && m.content.trim())),
      options.context,
    );

    const conversation: Anthropic.Beta.BetaMessageParam[] = turns.map((m, index) => ({
      role: m.role as 'user' | 'assistant',
      content: [
        {
          type: 'text',
          text: m.content,
          // Cache everything up to the last history turn.
          ...(index === turns.length - 2 ? { cache_control: { type: 'ephemeral' as const } } : {}),
        },
      ],
    }));

    const structured = supportsStructuredOutput(model);
    const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
    if (structured) outputConfig.format = { type: 'json_schema', schema: ANSWER_SCHEMA as unknown as Record<string, unknown> };
    if (supportsEffort(model)) outputConfig.effort = env.AI_EFFORT;

    const response = await this.client.beta.messages.create({
      model,
      // Thinking can't be switched off on current models and counts toward
      // max_tokens, so leave headroom; reply length is set by the prompt.
      max_tokens: 16_000,
      system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages: conversation,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(supportsFallbacks(model) ? { fallbacks: 'default' as const, betas: [FALLBACK_BETA] } : {}),
    });

    const usage = response.usage;
    logger.debug(
      {
        model: response.model,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        stopReason: response.stop_reason,
      },
      'anthropic reply',
    );

    const tokensUsed =
      usage.input_tokens +
      usage.output_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);

    // A declined or truncated reply is never sent — the conversation goes to a human.
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      return {
        text: '',
        confidence: 0,
        unanswered: true,
        tokensUsed,
        model: response.model,
        raw: { stopReason: response.stop_reason },
      };
    }

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
      tokensUsed,
      model: response.model,
      raw: { stopReason: response.stop_reason },
    };
  }

  async generateEmbedding(): Promise<EmbeddingResult> {
    // Anthropic does not serve an embeddings endpoint; retrieval falls back to
    // OpenAI embeddings when configured, else the lexical embedder.
    throw new IntegrationError('The Anthropic provider does not support embeddings');
  }
}

/** The API requires the first turn to come from the user. */
function dropLeadingAssistant(messages: AIMessage[]): AIMessage[] {
  const first = messages.findIndex((m) => m.role === 'user');
  return first <= 0 ? messages : messages.slice(first);
}

/**
 * The reply shape is {"answer": ..., "confidence": 0-1, "can_answer": bool}.
 * Structured outputs guarantee it on current Claude models; plain prose is
 * still accepted for other providers so a hiccup never blocks a reply.
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
          unanswered: parsed.can_answer === false || !parsed.answer.trim(),
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
