import { Platform } from '@prisma/client';
import { logger } from '../../lib/logger';
import { normalizeMetaWebhook, type MetaWebhookBody } from '../meta/normalize';
import type {
  MessagingProvider,
  NormalizedWebhook,
  ProviderContact,
  ProviderConversation,
  ProviderCredentials,
  SendMessagePayload,
  SendMessageResult,
} from '../types';

/**
 * Mock channel used when MOCK_MODE=true or no Meta app is configured
 * (spec section 40). It accepts sends and returns plausible ids so the whole
 * inbox, automation and AI pipeline is exercisable without Meta credentials.
 *
 * It never fabricates inbound traffic on its own — demo conversations come
 * from the seed, and the simulator endpoint is explicitly operator-triggered.
 */
export class MockProvider implements MessagingProvider {
  constructor(public readonly platform: Platform) {}

  async sendMessage(
    credentials: ProviderCredentials,
    payload: SendMessagePayload,
  ): Promise<SendMessageResult> {
    const externalMessageId = `mock_${this.platform.toLowerCase()}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    logger.info(
      {
        platform: this.platform,
        organizationId: credentials.organizationId,
        recipient: payload.recipientExternalId,
        hasAttachment: Boolean(payload.attachments?.length),
      },
      'mock provider accepted outbound message',
    );

    return { externalMessageId, raw: { mock: true } };
  }

  async getConversation(
    _credentials: ProviderCredentials,
    externalConversationId: string,
  ): Promise<ProviderConversation | null> {
    return { externalId: externalConversationId, participantExternalId: externalConversationId };
  }

  async getContact(
    _credentials: ProviderCredentials,
    externalContactId: string,
  ): Promise<ProviderContact | null> {
    return { externalId: externalContactId };
  }

  handleWebhook(payload: unknown): NormalizedWebhook {
    // Mock webhooks use the same Meta envelope so the simulator exercises the
    // real normalization path.
    return normalizeMetaWebhook(payload as MetaWebhookBody);
  }

  async markSeen(): Promise<void> {
    /* no-op */
  }
}

export const mockFacebookProvider = new MockProvider(Platform.FACEBOOK);
export const mockInstagramProvider = new MockProvider(Platform.INSTAGRAM);
export const mockWhatsAppProvider = new MockProvider(Platform.WHATSAPP);
