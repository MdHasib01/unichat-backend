import { env } from '../config/env';
import { logger } from '../lib/logger';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { mockAIProvider } from './providers/mock.provider';
import type { AIProvider } from './types';

const cache = new Map<string, AIProvider>();

/**
 * Resolves the AI provider for one organization's assistant configuration.
 *
 * If the configured provider has no key we fall back to the offline assistant
 * rather than failing the conversation — the product stays usable and the
 * operator sees the warning in the logs and the AI settings screen.
 */
export function getAIProvider(configured?: string | null): AIProvider {
  const name = (configured || env.AI_PROVIDER || 'mock').toLowerCase();

  const cached = cache.get(name);
  if (cached) return cached;

  let provider: AIProvider;

  try {
    switch (name) {
      case 'anthropic':
        provider = new AnthropicProvider();
        break;
      case 'openai':
        provider = new OpenAIProvider();
        break;
      default:
        provider = mockAIProvider;
    }
  } catch (error) {
    logger.warn({ err: error, provider: name }, 'AI provider unavailable, using offline assistant');
    provider = mockAIProvider;
  }

  cache.set(name, provider);
  return provider;
}

/** Embeddings can come from a different provider than generation. */
export function getEmbeddingProvider(configured?: string | null): AIProvider {
  const provider = getAIProvider(configured);
  if (provider.supportsEmbeddings) return provider;

  // Anthropic serves no embeddings endpoint; use OpenAI when available.
  if (env.OPENAI_API_KEY) {
    try {
      return new OpenAIProvider();
    } catch {
      /* fall through */
    }
  }
  return mockAIProvider;
}

export function availableAIProviders(): Array<{ id: string; label: string; configured: boolean }> {
  return [
    { id: 'mock', label: 'Built-in (no external API)', configured: true },
    { id: 'anthropic', label: 'Anthropic Claude', configured: Boolean(env.ANTHROPIC_API_KEY) },
    { id: 'openai', label: 'OpenAI', configured: Boolean(env.OPENAI_API_KEY) },
  ];
}

export function resetProviderCache(): void {
  cache.clear();
}
