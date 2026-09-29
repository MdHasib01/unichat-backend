import {
  IntegrationProvider,
  IntegrationStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  Platform,
  PreChatMode,
  Prisma,
  SocialAccountType,
  WidgetPosition,
  type SenderType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { cacheDel, cacheGet, cacheSet, setOnce } from '../lib/redis';
import { randomToken } from '../utils/crypto';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { isWithinBusinessHours } from '../utils/businessHours';
import { normalizeDomain } from '../utils/domains';
import { emitRealtime } from '../realtime/publisher';
import { RealtimeEvent } from '../realtime/events';
import { emitToVisitor } from '../realtime/widgetHub';
import { ingestInboundMessage } from './inbound.service';
import { findOrCreateContactByIdentifier } from './contact.service';

// ---------------------------------------------------------------------------
// Dashboard: widget management
// ---------------------------------------------------------------------------

export const PRE_CHAT_FIELDS = ['name', 'email', 'phone'] as const;
export type PreChatField = (typeof PRE_CHAT_FIELDS)[number];

export interface WidgetInput {
  name?: string;
  isActive?: boolean;
  allowedDomains?: string[];
  position?: WidgetPosition;
  offsetX?: number;
  offsetY?: number;
  primaryColor?: string;
  logoUrl?: string | null;
  launcherIcon?: string;
  title?: string;
  subtitle?: string | null;
  welcomeMessage?: string | null;
  inputPlaceholder?: string;
  offlineMessage?: string | null;
  showBranding?: boolean;
  preChatMode?: PreChatMode;
  preChatFields?: PreChatField[];
}

const widgetSelect = {
  id: true,
  organizationId: true,
  socialAccountId: true,
  publicKey: true,
  name: true,
  isActive: true,
  allowedDomains: true,
  position: true,
  offsetX: true,
  offsetY: true,
  primaryColor: true,
  logoUrl: true,
  launcherIcon: true,
  title: true,
  subtitle: true,
  welcomeMessage: true,
  inputPlaceholder: true,
  offlineMessage: true,
  showBranding: true,
  preChatMode: true,
  preChatFields: true,
  lastSeenAt: true,
  lastSeenOrigin: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChatWidgetSelect;

export function newPublicKey(): string {
  return `wk_${randomToken(18)}`;
}

function cleanDomains(domains?: string[]): string[] | undefined {
  if (!domains) return undefined;
  const cleaned = new Set<string>();
  for (const entry of domains) {
    const domain = normalizeDomain(entry);
    if (!domain) throw new BadRequestError(`"${entry}" is not a valid domain`, [], 'INVALID_DOMAIN');
    cleaned.add(domain);
  }
  return Array.from(cleaned);
}

export async function listWidgets(organizationId: string) {
  const widgets = await prisma.chatWidget.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'asc' },
    select: { ...widgetSelect, socialAccount: { select: { _count: { select: { conversations: true } } } } },
  });
  return widgets.map(({ socialAccount, ...widget }) => ({
    ...widget,
    conversationCount: socialAccount._count.conversations,
  }));
}

export async function getWidget(organizationId: string, widgetId: string) {
  const widget = await prisma.chatWidget.findFirst({
    where: { id: widgetId, organizationId },
    select: widgetSelect,
  });
  if (!widget) throw new NotFoundError('Chat widget');
  return widget;
}

/**
 * A widget is a SocialAccount on the organization's WEBCHAT integration, so
 * conversations, contacts and the inbox treat it like any other channel.
 */
export async function createWidget(organizationId: string, input: WidgetInput & { name: string }) {
  const publicKey = newPublicKey();
  const allowedDomains = cleanDomains(input.allowedDomains) ?? [];

  const widget = await prisma.$transaction(async (tx) => {
    const integration = await tx.integration.upsert({
      where: { organizationId_provider: { organizationId, provider: IntegrationProvider.WEBCHAT } },
      create: {
        organizationId,
        provider: IntegrationProvider.WEBCHAT,
        status: IntegrationStatus.CONNECTED,
        displayName: 'Website chat',
      },
      update: { status: IntegrationStatus.CONNECTED },
    });

    const account = await tx.socialAccount.create({
      data: {
        organizationId,
        integrationId: integration.id,
        type: SocialAccountType.WEBCHAT_WIDGET,
        platform: Platform.WEBCHAT,
        externalId: publicKey,
        name: input.name,
        status: IntegrationStatus.CONNECTED,
        isActive: input.isActive ?? true,
        subscribed: true,
      },
    });

    return tx.chatWidget.create({
      data: {
        ...input,
        organizationId,
        socialAccountId: account.id,
        publicKey,
        allowedDomains,
      },
      select: widgetSelect,
    });
  });

  return widget;
}

export async function updateWidget(organizationId: string, widgetId: string, input: WidgetInput) {
  const existing = await getWidget(organizationId, widgetId);
  const data: Prisma.ChatWidgetUpdateInput = { ...input, allowedDomains: cleanDomains(input.allowedDomains) };

  const widget = await prisma.$transaction(async (tx) => {
    if (input.name !== undefined || input.isActive !== undefined) {
      await tx.socialAccount.update({
        where: { id: existing.socialAccountId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
    }
    return tx.chatWidget.update({ where: { id: widgetId }, data, select: widgetSelect });
  });

  await invalidateWidgetCache(existing.publicKey);
  // Open widgets pick up the new look without a page reload.
  await emitToVisitor(widget.id, undefined, 'config', await publicConfigFor(widget.publicKey));
  return widget;
}

/** Issues a new public key. The old snippet stops working immediately. */
export async function rotateWidgetKey(organizationId: string, widgetId: string) {
  const existing = await getWidget(organizationId, widgetId);
  const publicKey = newPublicKey();

  const [, widget] = await prisma.$transaction([
    prisma.socialAccount.update({ where: { id: existing.socialAccountId }, data: { externalId: publicKey } }),
    prisma.chatWidget.update({ where: { id: widgetId }, data: { publicKey }, select: widgetSelect }),
  ]);

  await invalidateWidgetCache(existing.publicKey);
  return widget;
}

/** Conversations stay in the inbox; they just lose their channel link. */
export async function deleteWidget(organizationId: string, widgetId: string) {
  const existing = await getWidget(organizationId, widgetId);
  await prisma.socialAccount.delete({ where: { id: existing.socialAccountId } });
  await invalidateWidgetCache(existing.publicKey);
}

// ---------------------------------------------------------------------------
// Public: widget lookup (cached — every page view on the customer's site hits it)
// ---------------------------------------------------------------------------

export interface PublicWidget {
  id: string;
  organizationId: string;
  socialAccountId: string;
  publicKey: string;
  isActive: boolean;
  allowedDomains: string[];
  preChatMode: PreChatMode;
  preChatFields: string[];
  appearance: {
    position: WidgetPosition;
    offsetX: number;
    offsetY: number;
    primaryColor: string;
    logoUrl: string | null;
    launcherIcon: string;
    title: string;
    subtitle: string | null;
    welcomeMessage: string | null;
    inputPlaceholder: string;
    offlineMessage: string | null;
    showBranding: boolean;
  };
  business: { name: string; logoUrl: string | null; timezone: string; businessHours: unknown };
}

const CACHE_TTL_SECONDS = 300;
const cacheKey = (publicKey: string) => `widget:cfg:${publicKey}`;

async function invalidateWidgetCache(publicKey: string) {
  await cacheDel(cacheKey(publicKey));
}

export async function resolvePublicWidget(publicKey: string): Promise<PublicWidget | null> {
  if (!/^wk_[A-Za-z0-9_-]{10,64}$/.test(publicKey)) return null;

  const cached = await cacheGet<PublicWidget | { missing: true }>(cacheKey(publicKey));
  if (cached) return 'missing' in cached ? null : cached;

  const row = await prisma.chatWidget.findUnique({
    where: { publicKey },
    select: {
      ...widgetSelect,
      organization: { select: { name: true, logoUrl: true, timezone: true, businessHours: true } },
    },
  });

  if (!row) {
    // Short negative cache blunts key guessing against the database.
    await cacheSet(cacheKey(publicKey), { missing: true }, 60);
    return null;
  }

  const widget: PublicWidget = {
    id: row.id,
    organizationId: row.organizationId,
    socialAccountId: row.socialAccountId,
    publicKey: row.publicKey,
    isActive: row.isActive,
    allowedDomains: row.allowedDomains,
    preChatMode: row.preChatMode,
    preChatFields: row.preChatFields,
    appearance: {
      position: row.position,
      offsetX: row.offsetX,
      offsetY: row.offsetY,
      primaryColor: row.primaryColor,
      logoUrl: row.logoUrl,
      launcherIcon: row.launcherIcon,
      title: row.title,
      subtitle: row.subtitle,
      welcomeMessage: row.welcomeMessage,
      inputPlaceholder: row.inputPlaceholder,
      offlineMessage: row.offlineMessage,
      showBranding: row.showBranding,
    },
    business: {
      name: row.organization.name,
      logoUrl: row.organization.logoUrl,
      timezone: row.organization.timezone,
      businessHours: row.organization.businessHours,
    },
  };

  await cacheSet(cacheKey(publicKey), widget, CACHE_TTL_SECONDS);
  return widget;
}

/** What the embedded script is allowed to know about the widget. */
export function toPublicConfig(widget: PublicWidget) {
  return {
    key: widget.publicKey,
    ...widget.appearance,
    logoUrl: widget.appearance.logoUrl ?? widget.business.logoUrl,
    businessName: widget.business.name,
    isOnline: isWithinBusinessHours(widget.business.businessHours, widget.business.timezone),
    preChat: { mode: widget.preChatMode, fields: widget.preChatFields },
  };
}

async function publicConfigFor(publicKey: string) {
  const widget = await resolvePublicWidget(publicKey);
  return widget ? toPublicConfig(widget) : null;
}

/** Records that the snippet is live, at most once every five minutes. */
export async function touchWidgetSeen(widget: PublicWidget, origin: string | undefined) {
  if (!(await setOnce(`widget:seen:${widget.id}`, 300))) return;
  await prisma.chatWidget
    .update({
      where: { id: widget.id },
      data: { lastSeenAt: new Date(), lastSeenOrigin: origin?.slice(0, 255) ?? null },
    })
    .catch((error) => logger.debug({ err: error }, 'failed to record widget last-seen'));
}

// ---------------------------------------------------------------------------
// Public: visitor operations
// ---------------------------------------------------------------------------

export interface VisitorMessageDTO {
  id: string;
  clientMessageId: string | null;
  body: string | null;
  from: 'visitor' | 'agent' | 'bot';
  agent: { name: string; avatarUrl: string | null } | null;
  attachments: unknown;
  status: MessageStatus;
  createdAt: Date;
}

const visitorMessageSelect = {
  id: true,
  body: true,
  direction: true,
  senderType: true,
  externalId: true,
  attachments: true,
  status: true,
  createdAt: true,
  user: { select: { firstName: true, avatarUrl: true } },
} satisfies Prisma.MessageSelect;

type VisitorMessageRow = Prisma.MessageGetPayload<{ select: typeof visitorMessageSelect }>;

export function toVisitorMessage(row: VisitorMessageRow): VisitorMessageDTO {
  const inbound = row.direction === MessageDirection.INBOUND;
  const botSenders: SenderType[] = ['AI', 'AUTOMATION', 'SYSTEM'];
  return {
    id: row.id,
    clientMessageId: inbound ? clientIdFromExternalId(row.externalId) : null,
    body: row.body,
    from: inbound ? 'visitor' : botSenders.includes(row.senderType) ? 'bot' : 'agent',
    agent: !inbound && row.user ? { name: row.user.firstName, avatarUrl: row.user.avatarUrl } : null,
    attachments: row.attachments ?? [],
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Inbound widget messages are stored with externalId "wc:<visitorId>:<clientMessageId>",
 * which makes a retried send idempotent and lets the widget reconcile its
 * optimistic copy. Client ids are validated to exclude ":".
 */
export function widgetExternalId(visitorId: string, clientMessageId: string): string {
  return `wc:${visitorId}:${clientMessageId}`;
}

function clientIdFromExternalId(externalId: string | null): string | null {
  if (!externalId?.startsWith('wc:')) return null;
  return externalId.split(':')[2] ?? null;
}

export async function loadVisitorMessage(organizationId: string, messageId: string) {
  const row = await prisma.message.findFirst({
    where: { id: messageId, organizationId },
    select: visitorMessageSelect,
  });
  return row ? toVisitorMessage(row) : null;
}

export function anonymousVisitorName(visitorId: string): string {
  return `Website visitor #${visitorId.slice(-4).toUpperCase()}`;
}

async function findVisitorContact(widget: PublicWidget, visitorId: string) {
  const identifier = await prisma.contactIdentifier.findUnique({
    where: {
      organizationId_platform_externalId: {
        organizationId: widget.organizationId,
        platform: Platform.WEBCHAT,
        externalId: visitorId,
      },
    },
    select: {
      contact: { select: { id: true, displayName: true, email: true, phone: true, isBlocked: true } },
    },
  });
  return identifier?.contact ?? null;
}

async function findVisitorConversationId(widget: PublicWidget, contactId: string): Promise<string | null> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      organizationId: widget.organizationId,
      contactId,
      platform: Platform.WEBCHAT,
      socialAccountId: widget.socialAccountId,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return conversation?.id ?? null;
}

export async function describeVisitor(widget: PublicWidget, visitorId: string) {
  const contact = await findVisitorContact(widget, visitorId);
  const anonymous = !contact || contact.displayName === anonymousVisitorName(visitorId);
  const profile = contact
    ? { name: anonymous ? null : contact.displayName, email: contact.email, phone: contact.phone }
    : { name: null, email: null, phone: null };

  const missingRequired =
    widget.preChatMode === PreChatMode.REQUIRED &&
    widget.preChatFields.some((field) => !profile[field as PreChatField]);

  return { profile, needsPreChat: missingRequired, hasConversation: Boolean(contact) };
}

export async function identifyVisitor(
  widget: PublicWidget,
  visitorId: string,
  input: { name?: string; email?: string; phone?: string },
) {
  if (widget.preChatMode === PreChatMode.REQUIRED) {
    const missing = widget.preChatFields.filter((field) => !input[field as PreChatField]?.trim());
    if (missing.length) {
      throw new BadRequestError(
        'Please fill in the required fields',
        missing.map((field) => ({ field, message: 'Required' })),
        'PRE_CHAT_REQUIRED',
      );
    }
  }

  const contact = await findOrCreateContactByIdentifier({
    organizationId: widget.organizationId,
    platform: Platform.WEBCHAT,
    externalId: visitorId,
    socialAccountId: widget.socialAccountId,
    displayName: input.name?.trim() || anonymousVisitorName(visitorId),
  });

  // Details the visitor typed are applied to their own contact only — never
  // merged into an existing contact by email, since anyone can type any email.
  const data: Prisma.ContactUpdateInput = {};
  if (input.name?.trim()) {
    const name = input.name.trim();
    const [firstName, ...rest] = name.split(/\s+/);
    Object.assign(data, { displayName: name, firstName, lastName: rest.join(' ') || null });
  }
  if (input.email?.trim()) data.email = input.email.trim().toLowerCase();
  if (input.phone?.trim()) data.phone = input.phone.trim();

  if (Object.keys(data).length) {
    const updated = await prisma.contact.update({ where: { id: contact.id }, data });
    await emitRealtime(widget.organizationId, RealtimeEvent.CONTACT_UPDATED, updated);
  }

  return describeVisitor(widget, visitorId);
}

/**
 * What the visitor is allowed to see: everything they sent, and business
 * messages only once they were actually delivered. A reply that is still
 * queued — or failed — never appears in the widget, so the visitor's view and
 * the dashboard's delivery ticks always agree.
 */
const VISIBLE_TO_VISITOR: Prisma.MessageWhereInput = {
  isInternal: false,
  type: { not: MessageType.NOTE },
  OR: [
    { direction: MessageDirection.INBOUND },
    {
      direction: MessageDirection.OUTBOUND,
      status: { in: [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ] },
    },
  ],
};

/** Overlap between polls, so a row committed mid-query is never skipped. */
const CURSOR_OVERLAP_MS = 2_000;

/**
 * The visitor's conversation. With `since` (a cursor from a previous call) it
 * returns only rows created *or changed* after it — a reply that was queued
 * before the last poll but delivered after it, or a message that became
 * "read", is still picked up. The widget merges rows by id.
 */
export async function listVisitorMessages(widget: PublicWidget, visitorId: string, since?: string) {
  const startedAt = Date.now();
  const cursor = new Date(startedAt - CURSOR_OVERLAP_MS).toISOString();

  const contact = await findVisitorContact(widget, visitorId);
  if (!contact) return { messages: [], cursor };
  const conversationId = await findVisitorConversationId(widget, contact.id);
  if (!conversationId) return { messages: [], cursor };

  const sinceDate = since ? new Date(since) : null;
  const rows = await prisma.message.findMany({
    where: {
      organizationId: widget.organizationId,
      conversationId,
      ...VISIBLE_TO_VISITOR,
      ...(sinceDate && !Number.isNaN(sinceDate.getTime()) ? { updatedAt: { gt: sinceDate } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: visitorMessageSelect,
  });

  return { messages: rows.reverse().map(toVisitorMessage), cursor };
}

export async function postVisitorMessage(
  widget: PublicWidget,
  visitorId: string,
  input: { text: string; clientMessageId: string; pageUrl?: string; userAgent?: string },
): Promise<VisitorMessageDTO> {
  const externalMessageId = widgetExternalId(visitorId, input.clientMessageId);
  const now = new Date();

  const existingContact = await findVisitorContact(widget, visitorId);

  // A blocked visitor sees their message "sent" and nothing reaches the team.
  if (existingContact?.isBlocked) {
    return {
      id: externalMessageId,
      clientMessageId: input.clientMessageId,
      body: input.text,
      from: 'visitor',
      agent: null,
      attachments: [],
      status: MessageStatus.DELIVERED,
      createdAt: now,
    };
  }

  const ingested = await ingestInboundMessage({
    organizationId: widget.organizationId,
    socialAccountId: widget.socialAccountId,
    message: {
      platform: Platform.WEBCHAT,
      externalMessageId,
      senderExternalId: visitorId,
      recipientExternalId: widget.publicKey,
      type: MessageType.TEXT,
      text: input.text,
      attachments: [],
      timestamp: now,
      isEcho: false,
      raw: { source: 'widget', pageUrl: input.pageUrl ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null },
    },
    profile: { displayName: anonymousVisitorName(visitorId) },
  });

  if (ingested) {
    await cacheSet(visitorConversationKey(widget.id, visitorId), ingested.conversationId, 3600);
    return toVisitorMessage(ingested.message);
  }

  // A retry of a message we already stored: answer with the stored copy.
  const existing = await prisma.message.findFirst({
    where: { organizationId: widget.organizationId, platform: Platform.WEBCHAT, externalId: externalMessageId },
    select: visitorMessageSelect,
  });
  if (!existing) throw new BadRequestError('The message is still being processed, please retry', [], 'RETRY');
  return toVisitorMessage(existing);
}

const visitorConversationKey = (widgetId: string, visitorId: string) => `widget:conv:${widgetId}:${visitorId}`;

async function cachedVisitorConversationId(widget: PublicWidget, visitorId: string): Promise<string | null> {
  const key = visitorConversationKey(widget.id, visitorId);
  const cached = await cacheGet<string>(key);
  if (cached) return cached;

  const contact = await findVisitorContact(widget, visitorId);
  const conversationId = contact ? await findVisitorConversationId(widget, contact.id) : null;
  if (conversationId) await cacheSet(key, conversationId, 3600);
  return conversationId;
}

/** Shows "customer is typing…" to agents watching the conversation. */
export async function visitorTyping(widget: PublicWidget, visitorId: string) {
  const conversationId = await cachedVisitorConversationId(widget, visitorId);
  if (!conversationId) return;
  await emitRealtime(
    widget.organizationId,
    RealtimeEvent.TYPING,
    { conversationId, contact: true },
    { conversationId },
  );
}

/** The visitor opened the chat: everything the business sent is now read. */
export async function markVisitorRead(widget: PublicWidget, visitorId: string) {
  const conversationId = await cachedVisitorConversationId(widget, visitorId);
  if (!conversationId) return;

  const unread = await prisma.message.findMany({
    where: {
      organizationId: widget.organizationId,
      conversationId,
      direction: MessageDirection.OUTBOUND,
      isInternal: false,
      status: { in: [MessageStatus.SENT, MessageStatus.DELIVERED] },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true },
  });
  if (!unread.length) return;

  const readAt = new Date();
  await prisma.message.updateMany({
    where: { id: { in: unread.map((m) => m.id) } },
    data: { status: MessageStatus.READ, readAt },
  });

  // Agents only need the newest few ticks to turn blue.
  for (const { id } of unread.slice(0, 10)) {
    await emitRealtime(
      widget.organizationId,
      RealtimeEvent.MESSAGE_UPDATED,
      { id, conversationId, status: MessageStatus.READ, readAt },
      { conversationId },
    );
  }
}

// ---------------------------------------------------------------------------
// Conversation → visitor (agent typing, AI typing, outbound delivery)
// ---------------------------------------------------------------------------

export interface VisitorAddress {
  widgetId: string;
  visitorId: string;
}

/** Resolves which widget visitor a conversation belongs to. Cached. */
export async function visitorForConversation(
  organizationId: string,
  conversationId: string,
): Promise<VisitorAddress | null> {
  const key = `widget:visitor:${conversationId}`;
  const cached = await cacheGet<VisitorAddress | { none: true }>(key);
  if (cached) return 'none' in cached ? null : cached;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
    select: {
      platform: true,
      socialAccount: { select: { chatWidget: { select: { id: true } } } },
      contact: { select: { identifiers: { where: { platform: Platform.WEBCHAT }, select: { externalId: true } } } },
    },
  });

  const widgetId = conversation?.socialAccount?.chatWidget?.id;
  const visitorId = conversation?.contact.identifiers[0]?.externalId;
  const address = conversation?.platform === Platform.WEBCHAT && widgetId && visitorId ? { widgetId, visitorId } : null;

  await cacheSet(key, address ?? { none: true }, 3600);
  return address;
}

export async function widgetIdForSocialAccount(socialAccountId: string): Promise<string | null> {
  const key = `widget:account:${socialAccountId}`;
  const cached = await cacheGet<string>(key);
  if (cached) return cached;
  const widget = await prisma.chatWidget.findUnique({ where: { socialAccountId }, select: { id: true } });
  if (widget) await cacheSet(key, widget.id, 3600);
  return widget?.id ?? null;
}

/** Best-effort typing indicator for a website visitor. */
export async function signalVisitorTyping(organizationId: string, conversationId: string, from: 'agent' | 'bot') {
  const address = await visitorForConversation(organizationId, conversationId);
  if (address) await emitToVisitor(address.widgetId, address.visitorId, 'typing', { from });
}
