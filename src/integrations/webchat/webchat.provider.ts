import { Platform } from '@prisma/client';
import { randomToken } from '../../utils/crypto';
import { IntegrationError } from '../../utils/errors';
import { emitToVisitor } from '../../realtime/widgetHub';
import { loadVisitorMessage, widgetIdForSocialAccount } from '../../services/webchat.service';
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
 * Website chat adapter.
 *
 * There is no third-party API to call: the message row is already in the
 * database (the visitor's history reads from it), so "sending" means pushing
 * it to the visitor's open widget. A visitor who has left the site simply sees
 * the reply the next time the widget loads.
 */
export class WebchatProvider implements MessagingProvider {
  readonly platform = Platform.WEBCHAT;

  async sendMessage(credentials: ProviderCredentials, payload: SendMessagePayload): Promise<SendMessageResult> {
    const widgetId = await widgetIdForSocialAccount(credentials.socialAccountId);
    if (!widgetId) throw new IntegrationError('This website chat widget no longer exists');

    const message = payload.messageId
      ? await loadVisitorMessage(credentials.organizationId, payload.messageId)
      : null;

    await emitToVisitor(
      widgetId,
      payload.recipientExternalId,
      'message',
      message ? { ...message, status: 'SENT' } : { body: payload.text ?? null, from: 'agent', createdAt: new Date() },
    );

    return { externalMessageId: `wc_out_${randomToken(12)}` };
  }

  async getConversation(
    _credentials: ProviderCredentials,
    externalConversationId: string,
  ): Promise<ProviderConversation | null> {
    return { externalId: externalConversationId, participantExternalId: externalConversationId };
  }

  async getContact(_credentials: ProviderCredentials, externalContactId: string): Promise<ProviderContact | null> {
    return { externalId: externalContactId };
  }

  handleWebhook(): NormalizedWebhook {
    // Widget messages arrive through the public widget API, not webhooks.
    return { messages: [], statuses: [] };
  }
}

export const webchatProvider = new WebchatProvider();
