import { MessageType, Platform } from '@prisma/client';
import type {
  NormalizedAttachment,
  NormalizedMessage,
  NormalizedStatusUpdate,
  NormalizedWebhook,
} from '../types';

/** Raw Meta webhook shapes (only the fields we consume). */
export interface MetaWebhookBody {
  object?: string;
  entry?: MetaEntry[];
}

interface MetaEntry {
  id: string;
  time?: number;
  messaging?: MessagingEvent[];
  changes?: Array<{ field: string; value: WhatsAppChangeValue }>;
}

interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Array<{
      type: string;
      payload?: { url?: string; sticker_id?: number; coordinates?: { lat: number; long: number } };
    }>;
  };
  postback?: { mid?: string; title?: string; payload?: string };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number };
}

interface WhatsAppChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: Array<{
    id: string;
    from: string;
    timestamp: string;
    type: string;
    text?: { body?: string };
    image?: WhatsAppMedia;
    video?: WhatsAppMedia;
    audio?: WhatsAppMedia;
    document?: WhatsAppMedia;
    sticker?: WhatsAppMedia;
    location?: { latitude: number; longitude: number; name?: string };
    button?: { text?: string };
    interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  }>;
  statuses?: Array<{
    id: string;
    status: string;
    timestamp: string;
    errors?: Array<{ title?: string; message?: string }>;
  }>;
}

interface WhatsAppMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  link?: string;
}

const ATTACHMENT_TYPE_MAP: Record<string, NormalizedAttachment['type']> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
  document: 'file',
  sticker: 'sticker',
  location: 'location',
};

function messageTypeFor(attachments: NormalizedAttachment[], hasText: boolean): MessageType {
  if (attachments.length) {
    switch (attachments[0].type) {
      case 'image':
        return MessageType.IMAGE;
      case 'video':
        return MessageType.VIDEO;
      case 'audio':
        return MessageType.AUDIO;
      case 'sticker':
        return MessageType.STICKER;
      case 'location':
        return MessageType.LOCATION;
      default:
        return MessageType.FILE;
    }
  }
  return hasText ? MessageType.TEXT : MessageType.TEXT;
}

/** Messenger and Instagram Direct share the `messaging` event envelope. */
export function normalizeMessengerEntry(entry: MetaEntry, platform: Platform): NormalizedWebhook {
  const messages: NormalizedMessage[] = [];
  const statuses: NormalizedStatusUpdate[] = [];

  for (const event of entry.messaging ?? []) {
    const timestamp = new Date(event.timestamp ?? Date.now());

    if (event.delivery?.mids?.length) {
      for (const mid of event.delivery.mids) {
        statuses.push({ platform, externalMessageId: mid, status: 'delivered', timestamp });
      }
      continue;
    }

    if (event.read) {
      // Messenger reports reads with a watermark, not per-message ids.
      statuses.push({
        platform,
        externalMessageId: `watermark:${event.sender?.id}:${event.read.watermark}`,
        status: 'read',
        timestamp,
      });
      continue;
    }

    const postbackText = event.postback?.title ?? event.postback?.payload;
    if (event.postback && postbackText) {
      messages.push({
        platform,
        externalMessageId: event.postback.mid ?? `postback:${entry.id}:${event.timestamp}`,
        senderExternalId: event.sender?.id ?? '',
        recipientExternalId: event.recipient?.id ?? entry.id,
        type: MessageType.TEXT,
        text: postbackText,
        attachments: [],
        timestamp,
        isEcho: false,
        raw: event,
      });
      continue;
    }

    if (!event.message?.mid) continue;

    const attachments: NormalizedAttachment[] = (event.message.attachments ?? [])
      .map((a): NormalizedAttachment | null => {
        const type = ATTACHMENT_TYPE_MAP[a.type] ?? 'file';
        if (type === 'location') {
          const coords = a.payload?.coordinates;
          return {
            type,
            url: coords ? `https://maps.google.com/?q=${coords.lat},${coords.long}` : '',
            latitude: coords?.lat,
            longitude: coords?.long,
          };
        }
        if (!a.payload?.url) return null;
        return { type, url: a.payload.url };
      })
      .filter((a): a is NormalizedAttachment => a !== null);

    messages.push({
      platform,
      externalMessageId: event.message.mid,
      senderExternalId: event.sender?.id ?? '',
      recipientExternalId: event.recipient?.id ?? entry.id,
      type: messageTypeFor(attachments, Boolean(event.message.text)),
      text: event.message.text,
      attachments,
      timestamp,
      // Echoes are our own outbound messages coming back; we already stored them.
      isEcho: Boolean(event.message.is_echo),
      raw: event,
    });
  }

  return { messages, statuses };
}

export function normalizeWhatsAppChange(value: WhatsAppChangeValue): NormalizedWebhook {
  const messages: NormalizedMessage[] = [];
  const statuses: NormalizedStatusUpdate[] = [];
  const phoneNumberId = value.metadata?.phone_number_id ?? '';

  for (const status of value.statuses ?? []) {
    const mapped =
      status.status === 'delivered'
        ? 'delivered'
        : status.status === 'read'
          ? 'read'
          : status.status === 'failed'
            ? 'failed'
            : 'sent';
    statuses.push({
      platform: Platform.WHATSAPP,
      externalMessageId: status.id,
      status: mapped,
      timestamp: new Date(Number(status.timestamp) * 1000),
      error: status.errors?.[0]?.message ?? status.errors?.[0]?.title,
    });
  }

  for (const msg of value.messages ?? []) {
    const attachments: NormalizedAttachment[] = [];
    let text = msg.text?.body;

    const media = msg.image ?? msg.video ?? msg.audio ?? msg.document ?? msg.sticker;
    if (media) {
      const type: NormalizedAttachment['type'] = msg.image
        ? 'image'
        : msg.video
          ? 'video'
          : msg.audio
            ? 'audio'
            : msg.sticker
              ? 'sticker'
              : 'file';
      attachments.push({
        type,
        // Cloud API returns a media id; the download URL is fetched on demand.
        url: media.link ?? `whatsapp-media://${media.id}`,
        name: media.filename,
        mimeType: media.mime_type,
      });
      if (media.caption) text = media.caption;
    }

    if (msg.location) {
      attachments.push({
        type: 'location',
        url: `https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}`,
        name: msg.location.name,
        latitude: msg.location.latitude,
        longitude: msg.location.longitude,
      });
    }

    if (!text) {
      text =
        msg.button?.text ??
        msg.interactive?.button_reply?.title ??
        msg.interactive?.list_reply?.title ??
        undefined;
    }

    messages.push({
      platform: Platform.WHATSAPP,
      externalMessageId: msg.id,
      senderExternalId: msg.from,
      recipientExternalId: phoneNumberId,
      type: messageTypeFor(attachments, Boolean(text)),
      text,
      attachments,
      timestamp: new Date(Number(msg.timestamp) * 1000),
      isEcho: false,
      raw: { ...msg, profileName: value.contacts?.[0]?.profile?.name },
    });
  }

  return { messages, statuses };
}

/** Routes a full Meta webhook body to the right per-platform normalizer. */
export function normalizeMetaWebhook(body: MetaWebhookBody): NormalizedWebhook {
  const messages: NormalizedMessage[] = [];
  const statuses: NormalizedStatusUpdate[] = [];

  const platform =
    body.object === 'instagram'
      ? Platform.INSTAGRAM
      : body.object === 'whatsapp_business_account'
        ? Platform.WHATSAPP
        : Platform.FACEBOOK;

  for (const entry of body.entry ?? []) {
    if (entry.messaging?.length) {
      const result = normalizeMessengerEntry(entry, platform);
      messages.push(...result.messages);
      statuses.push(...result.statuses);
    }
    for (const change of entry.changes ?? []) {
      if (change.field === 'messages') {
        const result = normalizeWhatsAppChange(change.value);
        messages.push(...result.messages);
        statuses.push(...result.statuses);
      }
    }
  }

  return { messages, statuses };
}

export function profileNameFromRaw(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && 'profileName' in raw) {
    const name = (raw as { profileName?: unknown }).profileName;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}
