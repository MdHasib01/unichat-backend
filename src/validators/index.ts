import { z } from 'zod';
import {
  aiModeEnum,
  attachmentSchema,
  businessHoursSchema,
  conversationPriorityEnum,
  conversationStatusEnum,
  cuid,
  hexColor,
  memberRoleEnum,
  messagingPlatformEnum,
  paginationQuery,
  platformEnum,
} from './common.validator';

export * from './common.validator';
export * from './auth.validator';

// --- organization ----------------------------------------------------------

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  industry: z.string().trim().max(120).nullable().optional(),
  website: z.string().url().max(300).nullable().optional().or(z.literal('')),
  logoUrl: z.string().url().max(500).nullable().optional(),
  timezone: z.string().max(80).optional(),
  currency: z.string().length(3).optional(),
  businessHours: businessHoursSchema.optional(),
});

export const onboardingSchema = updateOrganizationSchema.extend({
  step: z.number().int().min(0).max(10).optional(),
  complete: z.boolean().optional(),
});

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().max(80).optional(),
});

export const switchOrganizationSchema = z.object({ organizationId: cuid });

// --- conversations ---------------------------------------------------------

export const listConversationsQuery = paginationQuery.extend({
  status: conversationStatusEnum.optional(),
  platform: messagingPlatformEnum.optional(),
  assignment: z.enum(['me', 'unassigned', 'all']).optional(),
  assigneeId: cuid.optional(),
  tagId: cuid.optional(),
  unreadOnly: z.coerce.boolean().optional(),
});

export const listMessagesQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  before: cuid.optional(),
});

export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(4000).optional(),
    attachments: z.array(attachmentSchema).max(5).optional(),
    templateId: cuid.optional(),
  })
  .refine((v) => Boolean(v.body?.length || v.attachments?.length || v.templateId), {
    message: 'A message needs text, an attachment or a template',
  });

export const updateConversationSchema = z.object({
  status: conversationStatusEnum.optional(),
  priority: conversationPriorityEnum.optional(),
  aiMode: aiModeEnum.optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  snoozedUntil: z.coerce.date().nullable().optional(),
});

export const assignConversationSchema = z.object({
  assigneeId: cuid.nullable(),
  note: z.string().trim().max(500).optional(),
});

export const setTagsSchema = z.object({ tagIds: z.array(cuid).max(20) });

export const internalNoteSchema = z.object({ body: z.string().trim().min(1).max(2000) });

// --- contacts --------------------------------------------------------------

export const listContactsQuery = paginationQuery.extend({
  platform: messagingPlatformEnum.optional(),
  tagId: cuid.optional(),
  sort: z.enum(['recent', 'name', 'created']).optional(),
});

export const contactSchema = z.object({
  firstName: z.string().trim().max(80).nullable().optional(),
  lastName: z.string().trim().max(80).nullable().optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(40).nullable().optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  isBlocked: z.boolean().optional(),
});

export const contactNoteSchema = z.object({ body: z.string().trim().min(1).max(2000) });

// --- integrations ----------------------------------------------------------

export const selectAccountsSchema = z.object({
  pages: z
    .array(z.object({ externalId: z.string().min(1).max(120), connectInstagram: z.boolean().optional() }))
    .optional(),
  whatsapp: z
    .array(z.object({ externalId: z.string().min(1).max(120), wabaId: z.string().min(1).max(120) }))
    .optional(),
});

// --- automations -----------------------------------------------------------

const triggerTypeEnum = z.enum([
  'FIRST_MESSAGE',
  'KEYWORD',
  'MESSAGE_CONTAINS',
  'BUSINESS_HOURS',
  'CONVERSATION_CREATED',
  'CUSTOMER_TAGGED',
  'CONVERSATION_IDLE',
]);

const actionTypeEnum = z.enum([
  'SEND_MESSAGE',
  'SEND_TEMPLATE',
  'ASSIGN_AGENT',
  'ADD_TAG',
  'REMOVE_TAG',
  'CHANGE_STATUS',
  'INTERNAL_NOTE',
  'DELAY',
  'TRIGGER_AI',
  'WEBHOOK',
]);

export const automationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  runOncePerContact: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  platforms: z.array(platformEnum).max(4).optional(),
  triggers: z
    .array(
      z.object({
        type: triggerTypeEnum,
        config: z
          .object({
            keywords: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
            matchType: z.enum(['any', 'all', 'exact']).optional(),
            caseSensitive: z.boolean().optional(),
            idleMinutes: z.number().int().positive().max(10080).optional(),
            inHours: z.boolean().optional(),
            tagId: cuid.optional(),
          })
          .optional(),
      }),
    )
    .min(1, 'Add at least one trigger'),
  actions: z
    .array(
      z.object({
        type: actionTypeEnum,
        order: z.number().int().min(0).max(100).optional(),
        config: z
          .object({
            message: z.string().trim().max(2000).optional(),
            templateId: cuid.optional(),
            agentId: cuid.optional(),
            tagId: cuid.optional(),
            status: conversationStatusEnum.optional(),
            note: z.string().trim().max(1000).optional(),
            delaySeconds: z.number().int().min(1).max(86400).optional(),
            url: z.string().url().max(500).optional(),
            method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
          })
          .optional(),
      }),
    )
    .min(1, 'Add at least one action'),
});

export const updateAutomationSchema = automationSchema.partial();

export const toggleSchema = z.object({ isActive: z.boolean() });

// --- AI --------------------------------------------------------------------

export const updateAssistantSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  persona: z.string().trim().max(300).optional(),
  systemPrompt: z.string().trim().max(4000).nullable().optional(),
  language: z.string().max(10).optional(),
  model: z.string().max(80).optional(),
  provider: z.enum(['openai', 'anthropic', 'mock']).optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(50).max(4000).optional(),
  autoReplyEnabled: z.boolean().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  businessHoursOnly: z.boolean().optional(),
  outsideHoursOnly: z.boolean().optional(),
  maxRepliesPerConversation: z.number().int().min(1).max(50).optional(),
  handoffKeywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  fallbackMessage: z.string().trim().min(1).max(500).optional(),
  handoffMessage: z.string().trim().min(1).max(500).optional(),
  suggestionsEnabled: z.boolean().optional(),
});

export const knowledgeDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(200_000),
  sourceType: z.enum(['MANUAL', 'FAQ', 'WEBSITE', 'DOCUMENT', 'PRODUCT']).optional(),
  sourceUrl: z.string().url().max(500).optional(),
});

export const updateKnowledgeDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(200_000).optional(),
});

export const listKnowledgeQuery = paginationQuery.extend({
  sourceType: z.enum(['MANUAL', 'FAQ', 'WEBSITE', 'DOCUMENT', 'PRODUCT']).optional(),
});

export const aiTestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: cuid.optional(),
});

// --- team ------------------------------------------------------------------

export const inviteMemberSchema = z.object({
  email: z.string().email().max(200),
  role: memberRoleEnum,
});

export const updateMemberSchema = z.object({
  role: memberRoleEnum.optional(),
  status: z.enum(['ACTIVE', 'INVITED', 'SUSPENDED']).optional(),
});

// --- templates & tags ------------------------------------------------------

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(['GREETING', 'SUPPORT', 'SALES', 'FOLLOW_UP', 'CLOSING', 'OTHER']).optional(),
  body: z.string().trim().min(1).max(4000),
  platforms: z.array(platformEnum).max(4).optional(),
  isActive: z.boolean().optional(),
});

export const updateTemplateSchema = templateSchema.partial();

export const tagSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: hexColor.optional(),
  description: z.string().trim().max(200).optional(),
});

export const customFieldSchema = z.object({
  entity: z.enum(['CONTACT', 'CONVERSATION']).optional(),
  key: z.string().trim().regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores').max(40),
  label: z.string().trim().min(1).max(80),
  type: z.enum(['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'URL']).optional(),
  options: z.array(z.string().trim().max(80)).max(40).optional(),
  isRequired: z.boolean().optional(),
  order: z.number().int().min(0).max(100).optional(),
});

// --- sales -----------------------------------------------------------------

export const listProductsQuery = paginationQuery.extend({
  category: z.string().trim().max(80).optional(),
  isActive: z.coerce.boolean().optional(),
});

export const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  price: z.number().nonnegative().max(1_000_000_000),
  compareAtPrice: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  currency: z.string().length(3).optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  trackInventory: z.boolean().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updateProductSchema = productSchema.partial();

export const listOrdersQuery = paginationQuery.extend({
  status: z
    .enum(['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'])
    .optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'REFUNDED']).optional(),
  contactId: cuid.optional(),
});

export const orderSchema = z.object({
  contactId: cuid.nullable().optional(),
  conversationId: cuid.nullable().optional(),
  status: z
    .enum(['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'])
    .optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'REFUNDED']).optional(),
  currency: z.string().length(3).optional(),
  discount: z.number().nonnegative().optional(),
  shippingFee: z.number().nonnegative().optional(),
  tax: z.number().nonnegative().optional(),
  customerName: z.string().trim().max(160).nullable().optional(),
  customerPhone: z.string().trim().max(40).nullable().optional(),
  customerEmail: z.string().email().max(200).nullable().optional().or(z.literal('')),
  shippingAddress: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  items: z
    .array(
      z.object({
        productId: cuid.nullable().optional(),
        name: z.string().trim().max(200).optional(),
        sku: z.string().trim().max(80).nullable().optional(),
        quantity: z.number().int().positive().max(10_000),
        unitPrice: z.number().nonnegative().optional(),
      }),
    )
    .min(1),
});

export const updateOrderSchema = orderSchema.partial().omit({ items: true });

export const listParcelsQuery = paginationQuery.extend({
  status: z
    .enum(['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'CANCELLED'])
    .optional(),
});

export const parcelSchema = z.object({
  orderId: cuid.nullable().optional(),
  trackingNumber: z.string().trim().min(1).max(80),
  courier: z.string().trim().min(1).max(80),
  status: z
    .enum(['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'CANCELLED'])
    .optional(),
  recipientName: z.string().trim().max(160).nullable().optional(),
  recipientPhone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  weightKg: z.number().nonnegative().max(1000).nullable().optional(),
  codAmount: z.number().nonnegative().nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export const updateParcelSchema = parcelSchema.partial().omit({ trackingNumber: true });

export const parcelStatusSchema = z.object({
  status: z.enum([
    'CREATED',
    'PICKED_UP',
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'RETURNED',
    'CANCELLED',
  ]),
  note: z.string().trim().max(500).optional(),
});

// --- calls -----------------------------------------------------------------

export const listCallsQuery = paginationQuery.extend({
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
  status: z.enum(['RINGING', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'FAILED', 'VOICEMAIL']).optional(),
  withRecordingOnly: z.coerce.boolean().optional(),
});

export const callSchema = z.object({
  contactId: cuid.nullable().optional(),
  conversationId: cuid.nullable().optional(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
  status: z.enum(['RINGING', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'FAILED', 'VOICEMAIL']).optional(),
  fromNumber: z.string().trim().max(40).nullable().optional(),
  toNumber: z.string().trim().max(40).nullable().optional(),
  durationSeconds: z.number().int().min(0).max(86400).optional(),
  provider: z.string().trim().max(80).nullable().optional(),
  externalId: z.string().trim().max(120).nullable().optional(),
  recordingUrl: z.string().url().max(500).nullable().optional(),
  recordingMime: z.string().max(80).nullable().optional(),
  recordingSize: z.number().int().min(0).nullable().optional(),
  transcript: z.string().max(50_000).nullable().optional(),
  summary: z.string().max(2000).nullable().optional(),
  agentUserId: cuid.nullable().optional(),
  startedAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().nullable().optional(),
});

export const updateCallSchema = callSchema.partial();

// --- analytics -------------------------------------------------------------

export const analyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

// --- notifications ---------------------------------------------------------

export const listNotificationsQuery = paginationQuery.extend({
  unreadOnly: z.coerce.boolean().optional(),
});

// --- mock simulator --------------------------------------------------------

export const simulateInboundSchema = z.object({
  socialAccountId: cuid,
  senderExternalId: z.string().trim().min(1).max(120).optional(),
  senderName: z.string().trim().min(1).max(120).optional(),
  text: z.string().trim().min(1).max(2000),
});
