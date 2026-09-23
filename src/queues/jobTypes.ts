import type { AutomationTriggerType, MessageType, Platform } from '@prisma/client';

/** Every job carries organizationId so workers stay tenant-scoped too. */
export interface BaseJob {
  organizationId: string;
  requestId?: string;
}

export interface WebhookJob {
  webhookEventId: string;
  /** Present once the webhook has been matched to an integration. */
  organizationId?: string;
}

export interface InboundMessageJob extends BaseJob {
  messageId: string;
  conversationId: string;
  contactId: string;
  platform: Platform;
  isFirstMessage: boolean;
}

export interface SendMessageJob extends BaseJob {
  messageId: string;
  conversationId: string;
  platform: Platform;
  socialAccountId?: string | null;
  recipientExternalId: string;
  body?: string | null;
  type: MessageType;
  attachments?: Array<{ type: string; url: string; name?: string; mimeType?: string }>;
}

export interface AutomationJob extends BaseJob {
  conversationId: string;
  contactId: string;
  messageId?: string;
  triggerType: AutomationTriggerType;
  /** Set when a specific automation is being resumed after a delay action. */
  automationId?: string;
  resumeFromActionOrder?: number;
  executionId?: string;
}

export interface AIJob extends BaseJob {
  conversationId: string;
  messageId: string;
  contactId: string;
  /** "auto_reply" answers the customer; "suggestion" only drafts for an agent. */
  mode: 'auto_reply' | 'suggestion';
}

export interface NotificationJob extends BaseJob {
  userIds?: string[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsJob extends BaseJob {
  date?: string;
  kind: 'rollup_day' | 'rollup_org';
}

export interface EmbeddingJob extends BaseJob {
  documentId: string;
}
