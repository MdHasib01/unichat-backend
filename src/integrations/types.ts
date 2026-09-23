import type { MessageType, Platform } from '@prisma/client';

export interface NormalizedAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location';
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
  latitude?: number;
  longitude?: number;
}

/**
 * The single internal shape every channel is normalized into (spec section 9).
 * Adding Telegram/SMS/Email later means writing one adapter, not touching the
 * inbox, automation or AI code.
 */
export interface NormalizedMessage {
  platform: Platform;
  /** Provider message id — used for idempotency. */
  externalMessageId: string;
  /** Sender identity on the platform (PSID / IGSID / wa id). */
  senderExternalId: string;
  /** The business account the message arrived on (page id / phone_number_id). */
  recipientExternalId: string;
  /** Provider thread id when it differs from the sender id. */
  threadExternalId?: string;
  type: MessageType;
  text?: string;
  attachments: NormalizedAttachment[];
  timestamp: Date;
  isEcho: boolean;
  raw: unknown;
}

export interface NormalizedStatusUpdate {
  platform: Platform;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  error?: string;
}

export interface NormalizedWebhook {
  messages: NormalizedMessage[];
  statuses: NormalizedStatusUpdate[];
}

export interface SendMessagePayload {
  recipientExternalId: string;
  text?: string;
  attachments?: NormalizedAttachment[];
  /** WhatsApp template sends outside the 24-hour window. */
  template?: { name: string; language: string; components?: unknown[] };
}

export interface SendMessageResult {
  externalMessageId: string;
  externalThreadId?: string;
  raw?: unknown;
}

export interface ProviderContact {
  externalId: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  phone?: string;
  locale?: string;
}

export interface ProviderConversation {
  externalId: string;
  participantExternalId: string;
  updatedAt?: Date;
}

/**
 * Channel adapter contract (spec section 10).
 *
 * `credentials` is resolved per organization by the provider registry, so a
 * provider instance can never act on another tenant's account.
 */
export interface MessagingProvider {
  readonly platform: Platform;

  sendMessage(
    credentials: ProviderCredentials,
    payload: SendMessagePayload,
  ): Promise<SendMessageResult>;

  getConversation(
    credentials: ProviderCredentials,
    externalConversationId: string,
  ): Promise<ProviderConversation | null>;

  getContact(
    credentials: ProviderCredentials,
    externalContactId: string,
  ): Promise<ProviderContact | null>;

  /** Parses a raw provider payload into the internal message model. */
  handleWebhook(payload: unknown): NormalizedWebhook;

  /** Marks the thread as seen where the provider supports it. */
  markSeen?(credentials: ProviderCredentials, externalContactId: string): Promise<void>;
}

export interface ProviderCredentials {
  organizationId: string;
  socialAccountId: string;
  /** Decrypted page/account token — never leaves the backend. */
  accessToken: string;
  /** Page id, IG business id or WhatsApp phone_number_id. */
  externalId: string;
  parentExternalId?: string | null;
}
