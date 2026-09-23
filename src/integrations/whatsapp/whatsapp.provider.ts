import { Platform } from '@prisma/client';
import { sendViaWhatsAppCloud } from '../meta/client';
import { normalizeMetaWebhook, type MetaWebhookBody } from '../meta/normalize';
import { IntegrationError } from '../../utils/errors';
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
 * WhatsApp Business adapter — Cloud API.
 *
 * Free-form messages are only deliverable inside the 24-hour customer service
 * window. Outside it WhatsApp requires an approved message template, so the
 * caller passes `template` and the UI explains the restriction.
 */
export class WhatsAppProvider implements MessagingProvider {
  readonly platform = Platform.WHATSAPP;

  async sendMessage(
    credentials: ProviderCredentials,
    payload: SendMessagePayload,
  ): Promise<SendMessageResult> {
    const attachment = payload.attachments?.[0];

    let body: Record<string, unknown>;

    if (payload.template) {
      body = {
        messaging_product: 'whatsapp',
        to: payload.recipientExternalId,
        type: 'template',
        template: {
          name: payload.template.name,
          language: { code: payload.template.language },
          ...(payload.template.components ? { components: payload.template.components } : {}),
        },
      };
    } else if (attachment) {
      const mediaType =
        attachment.type === 'image'
          ? 'image'
          : attachment.type === 'video'
            ? 'video'
            : attachment.type === 'audio'
              ? 'audio'
              : 'document';
      body = {
        messaging_product: 'whatsapp',
        to: payload.recipientExternalId,
        type: mediaType,
        [mediaType]: {
          link: attachment.url,
          ...(payload.text ? { caption: payload.text } : {}),
          ...(attachment.name && mediaType === 'document' ? { filename: attachment.name } : {}),
        },
      };
    } else {
      body = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: payload.recipientExternalId,
        type: 'text',
        text: { preview_url: true, body: payload.text ?? '' },
      };
    }

    const result = await sendViaWhatsAppCloud(
      credentials.externalId,
      credentials.accessToken,
      body,
    );

    const messageId = result.messages?.[0]?.id;
    if (!messageId) throw new IntegrationError('WhatsApp did not return a message id');

    return { externalMessageId: messageId, raw: result };
  }

  async getConversation(
    _credentials: ProviderCredentials,
    externalConversationId: string,
  ): Promise<ProviderConversation | null> {
    // WhatsApp conversations are keyed by the customer's wa_id.
    return { externalId: externalConversationId, participantExternalId: externalConversationId };
  }

  async getContact(
    _credentials: ProviderCredentials,
    externalContactId: string,
  ): Promise<ProviderContact | null> {
    // The Cloud API exposes no profile lookup endpoint; the display name
    // arrives on the webhook payload instead.
    return { externalId: externalContactId, phone: externalContactId };
  }

  handleWebhook(payload: unknown): NormalizedWebhook {
    return normalizeMetaWebhook(payload as MetaWebhookBody);
  }
}

export const whatsappProvider = new WhatsAppProvider();
