import { Platform } from '@prisma/client';
import { getInstagramProfile, sendViaSendApi } from '../meta/client';
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
 * Instagram Direct adapter.
 *
 * Instagram messaging runs through the connected Facebook Page: sends are
 * posted to the *page* id with the page token, while the recipient is the
 * customer's IGSID. `parentExternalId` on the social account holds that page
 * id. Requires an Instagram professional account and the
 * instagram_manage_messages permission (Meta app review).
 */
export class InstagramMessagingProvider implements MessagingProvider {
  readonly platform = Platform.INSTAGRAM;

  async sendMessage(
    credentials: ProviderCredentials,
    payload: SendMessagePayload,
  ): Promise<SendMessageResult> {
    const attachment = payload.attachments?.[0];

    const body: Record<string, unknown> = {
      recipient: { id: payload.recipientExternalId },
      message: attachment
        ? {
            attachment: {
              type: ['image', 'video', 'audio'].includes(attachment.type) ? attachment.type : 'file',
              payload: { url: attachment.url, is_reusable: true },
            },
          }
        : { text: payload.text ?? '' },
    };

    // Sends go through the linked page, not the IG account id.
    const sendingId = credentials.parentExternalId || credentials.externalId;
    const result = await sendViaSendApi(sendingId, credentials.accessToken, body);

    if (!result.message_id) throw new IntegrationError('Instagram did not return a message id');

    return { externalMessageId: result.message_id, raw: result };
  }

  async getConversation(
    _credentials: ProviderCredentials,
    externalConversationId: string,
  ): Promise<ProviderConversation | null> {
    return { externalId: externalConversationId, participantExternalId: externalConversationId };
  }

  async getContact(
    credentials: ProviderCredentials,
    externalContactId: string,
  ): Promise<ProviderContact | null> {
    const profile = await getInstagramProfile(externalContactId, credentials.accessToken);
    if (!profile) return null;
    return {
      externalId: profile.id,
      name: profile.name ?? profile.username,
      avatarUrl: profile.profile_pic,
    };
  }

  handleWebhook(payload: unknown): NormalizedWebhook {
    return normalizeMetaWebhook(payload as MetaWebhookBody);
  }
}

export const instagramProvider = new InstagramMessagingProvider();
