import { Platform } from '@prisma/client';
import {
  getMessengerProfile,
  markSeenViaSendApi,
  sendViaSendApi,
} from '../meta/client';
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
 * Facebook Messenger adapter — Meta Send API.
 *
 * Messenger only allows free-form replies inside the 24-hour standard
 * messaging window; outside it a message tag or the human-agent tag is
 * required, which needs Meta approval. That constraint is surfaced to the user
 * in the UI rather than silently worked around.
 */
export class FacebookMessengerProvider implements MessagingProvider {
  readonly platform = Platform.FACEBOOK;

  async sendMessage(
    credentials: ProviderCredentials,
    payload: SendMessagePayload,
  ): Promise<SendMessageResult> {
    const attachment = payload.attachments?.[0];

    const body: Record<string, unknown> = {
      recipient: { id: payload.recipientExternalId },
      messaging_type: 'RESPONSE',
      message: attachment
        ? {
            attachment: {
              type: attachment.type === 'file' ? 'file' : attachment.type,
              payload: { url: attachment.url, is_reusable: true },
            },
          }
        : { text: payload.text ?? '' },
    };

    const result = await sendViaSendApi(credentials.externalId, credentials.accessToken, body);

    if (!result.message_id) throw new IntegrationError('Messenger did not return a message id');

    return { externalMessageId: result.message_id, raw: result };
  }

  async getConversation(
    _credentials: ProviderCredentials,
    externalConversationId: string,
  ): Promise<ProviderConversation | null> {
    // Messenger threads are addressed by PSID; there is no separate thread
    // resource to fetch for messaging-only apps.
    return { externalId: externalConversationId, participantExternalId: externalConversationId };
  }

  async getContact(
    credentials: ProviderCredentials,
    externalContactId: string,
  ): Promise<ProviderContact | null> {
    const profile = await getMessengerProfile(externalContactId, credentials.accessToken);
    if (!profile) return null;
    return {
      externalId: profile.id,
      firstName: profile.first_name,
      lastName: profile.last_name,
      name: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || undefined,
      avatarUrl: profile.profile_pic,
      locale: profile.locale,
    };
  }

  handleWebhook(payload: unknown): NormalizedWebhook {
    return normalizeMetaWebhook(payload as MetaWebhookBody);
  }

  async markSeen(credentials: ProviderCredentials, externalContactId: string): Promise<void> {
    await markSeenViaSendApi(credentials.externalId, credentials.accessToken, externalContactId);
  }
}

export const facebookProvider = new FacebookMessengerProvider();
