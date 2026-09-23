import { Router } from 'express';
import { asyncHandler } from '../middleware/requestContext';
import { requireAuth, requireOrganization, requirePermission } from '../middleware/auth';
import { validate, validateBody, validateParams, validateQuery } from '../middleware/validate';
import { aiLimiter, authLimiter, sendLimiter } from '../middleware/rateLimit';
import { PERMISSIONS } from '../config/permissions';
import * as v from '../validators';
import * as auth from '../controllers/auth.controller';
import * as org from '../controllers/organization.controller';
import * as conversations from '../controllers/conversation.controller';
import * as contacts from '../controllers/contact.controller';
import * as integrations from '../controllers/integration.controller';
import * as ai from '../controllers/ai.controller';
import * as automations from '../controllers/automation.controller';
import * as team from '../controllers/team.controller';
import * as sales from '../controllers/sales.controller';
import * as misc from '../controllers/misc.controller';
import * as webhooks from '../controllers/webhook.controller';

const router = Router();

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

router.get('/health', asyncHandler(misc.healthController));

router.post('/auth/register', authLimiter, validateBody(v.registerSchema), asyncHandler(auth.registerController));
router.post('/auth/login', authLimiter, validateBody(v.loginSchema), asyncHandler(auth.loginController));
router.post('/auth/refresh', asyncHandler(auth.refreshController));
router.post('/auth/forgot-password', authLimiter, validateBody(v.forgotPasswordSchema), asyncHandler(auth.forgotPasswordController));
router.post('/auth/reset-password', authLimiter, validateBody(v.resetPasswordSchema), asyncHandler(auth.resetPasswordController));
router.post('/auth/verify-email', validateBody(v.verifyEmailSchema), asyncHandler(auth.verifyEmailController));
router.post('/team/invitations/accept', authLimiter, validateBody(v.acceptInvitationSchema), asyncHandler(team.acceptInvitationController));

// Meta redirects the browser straight here, so it cannot carry our cookies —
// the organization comes from the one-time OAuth state instead.
router.get('/integrations/meta/callback', asyncHandler(integrations.metaCallbackController));

// Webhook verification + receipt (signature-verified, not cookie-authenticated)
router.get('/webhooks/meta', webhooks.verifyWebhookController);
router.post('/webhooks/meta', asyncHandler(webhooks.receiveWebhookController));

// ---------------------------------------------------------------------------
// Authenticated (user context only — no organization required yet)
// ---------------------------------------------------------------------------

router.use(requireAuth);

router.get('/me', asyncHandler(auth.meController));
router.patch('/me', validateBody(v.updateProfileSchema), asyncHandler(auth.updateProfileController));
router.post('/auth/logout', asyncHandler(auth.logoutController));
router.post('/auth/logout-all', asyncHandler(auth.logoutAllController));
router.post('/auth/change-password', validateBody(v.changePasswordSchema), asyncHandler(auth.changePasswordController));
router.get('/auth/sessions', asyncHandler(auth.listSessionsController));
router.delete('/auth/sessions/:id', validateParams(v.idParam), asyncHandler(auth.revokeSessionController));

router.get('/organizations', asyncHandler(org.listOrganizationsController));
router.post('/organizations', validateBody(v.createOrganizationSchema), asyncHandler(org.createOrganizationController));
router.post('/organizations/switch', validateBody(v.switchOrganizationSchema), asyncHandler(org.switchOrganizationController));

// ---------------------------------------------------------------------------
// Tenant-scoped — every route below resolves the organization from the session
// and verifies membership before the controller runs (spec section 49).
// ---------------------------------------------------------------------------

router.use(requireOrganization);

// Organization & onboarding
router.get('/organization', asyncHandler(org.getCurrentOrganizationController));
router.patch(
  '/organization',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateBody(v.updateOrganizationSchema),
  asyncHandler(org.updateOrganizationController),
);
router.post('/organization/onboarding', validateBody(v.onboardingSchema), asyncHandler(org.saveOnboardingController));

// Dashboard & insights
router.get('/dashboard', asyncHandler(misc.dashboardController));
router.get(
  '/analytics',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validateQuery(v.analyticsQuery),
  asyncHandler(misc.insightsController),
);

// Conversations
router.get(
  '/conversations',
  requirePermission(PERMISSIONS.CONVERSATIONS_READ),
  validateQuery(v.listConversationsQuery),
  asyncHandler(conversations.listConversationsController),
);
router.get(
  '/conversations/counts',
  requirePermission(PERMISSIONS.CONVERSATIONS_READ),
  asyncHandler(conversations.conversationCountsController),
);
router.get(
  '/conversations/:id',
  requirePermission(PERMISSIONS.CONVERSATIONS_READ),
  validateParams(v.idParam),
  asyncHandler(conversations.getConversationController),
);
router.get(
  '/conversations/:id/messages',
  requirePermission(PERMISSIONS.CONVERSATIONS_READ),
  validate({ params: v.idParam, query: v.listMessagesQuery }),
  asyncHandler(conversations.listMessagesController),
);
router.post(
  '/conversations/:id/messages',
  sendLimiter,
  requirePermission(PERMISSIONS.CONVERSATIONS_REPLY),
  validate({ params: v.idParam, body: v.sendMessageSchema }),
  asyncHandler(conversations.sendMessageController),
);
router.patch(
  '/conversations/:id',
  requirePermission(PERMISSIONS.CONVERSATIONS_RESOLVE),
  validate({ params: v.idParam, body: v.updateConversationSchema }),
  asyncHandler(conversations.updateConversationController),
);
router.post(
  '/conversations/:id/assign',
  requirePermission(PERMISSIONS.CONVERSATIONS_ASSIGN),
  validate({ params: v.idParam, body: v.assignConversationSchema }),
  asyncHandler(conversations.assignConversationController),
);
router.post(
  '/conversations/:id/tags',
  requirePermission(PERMISSIONS.CONVERSATIONS_READ),
  validate({ params: v.idParam, body: v.setTagsSchema }),
  asyncHandler(conversations.setConversationTagsController),
);
router.post(
  '/conversations/:id/read',
  requirePermission(PERMISSIONS.CONVERSATIONS_READ),
  validateParams(v.idParam),
  asyncHandler(conversations.markReadController),
);
router.post(
  '/conversations/:id/notes',
  requirePermission(PERMISSIONS.CONVERSATIONS_REPLY),
  validate({ params: v.idParam, body: v.internalNoteSchema }),
  asyncHandler(conversations.addNoteController),
);
router.post(
  '/conversations/:id/ai-suggestion',
  aiLimiter,
  requirePermission(PERMISSIONS.CONVERSATIONS_REPLY),
  validateParams(v.idParam),
  asyncHandler(conversations.suggestReplyController),
);

// Contacts
router.get(
  '/contacts',
  requirePermission(PERMISSIONS.CONTACTS_READ),
  validateQuery(v.listContactsQuery),
  asyncHandler(contacts.listContactsController),
);
router.post(
  '/contacts',
  requirePermission(PERMISSIONS.CONTACTS_UPDATE),
  validateBody(v.contactSchema),
  asyncHandler(contacts.createContactController),
);
router.get(
  '/contacts/:id',
  requirePermission(PERMISSIONS.CONTACTS_READ),
  validateParams(v.idParam),
  asyncHandler(contacts.getContactController),
);
router.patch(
  '/contacts/:id',
  requirePermission(PERMISSIONS.CONTACTS_UPDATE),
  validate({ params: v.idParam, body: v.contactSchema }),
  asyncHandler(contacts.updateContactController),
);
router.delete(
  '/contacts/:id',
  requirePermission(PERMISSIONS.CONTACTS_UPDATE),
  validateParams(v.idParam),
  asyncHandler(contacts.deleteContactController),
);
router.post(
  '/contacts/:id/notes',
  requirePermission(PERMISSIONS.CONTACTS_UPDATE),
  validate({ params: v.idParam, body: v.contactNoteSchema }),
  asyncHandler(contacts.addContactNoteController),
);
router.post(
  '/contacts/:id/tags',
  requirePermission(PERMISSIONS.CONTACTS_UPDATE),
  validate({ params: v.idParam, body: v.setTagsSchema }),
  asyncHandler(contacts.setContactTagsController),
);

// Integrations
router.get(
  '/integrations',
  requirePermission(PERMISSIONS.INTEGRATIONS_READ),
  asyncHandler(integrations.listIntegrationsController),
);
router.post(
  '/integrations/meta/connect',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(integrations.startMetaConnectController),
);
router.post(
  '/integrations/meta/mock-connect',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(integrations.mockConnectController),
);
router.get(
  '/integrations/meta/accounts',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(integrations.availableAccountsController),
);
router.post(
  '/integrations/meta/accounts',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  validateBody(v.selectAccountsSchema),
  asyncHandler(integrations.selectAccountsController),
);
router.delete(
  '/integrations/meta',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  asyncHandler(integrations.disconnectMetaController),
);
router.post(
  '/integrations/accounts/:id/reconnect',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  validateParams(v.idParam),
  asyncHandler(integrations.reconnectAccountController),
);
router.delete(
  '/integrations/accounts/:id',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  validateParams(v.idParam),
  asyncHandler(integrations.disconnectAccountController),
);
router.post(
  '/integrations/simulate-inbound',
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  validateBody(v.simulateInboundSchema),
  asyncHandler(integrations.simulateInboundController),
);
router.get(
  '/integrations/webhook-events',
  requirePermission(PERMISSIONS.INTEGRATIONS_READ),
  validateQuery(v.paginationQuery),
  asyncHandler(misc.listWebhookEventsController),
);

// AI
router.get('/ai', requirePermission(PERMISSIONS.AI_READ), asyncHandler(ai.getAssistantController));
router.patch(
  '/ai',
  requirePermission(PERMISSIONS.AI_MANAGE),
  validateBody(v.updateAssistantSchema),
  asyncHandler(ai.updateAssistantController),
);
router.get(
  '/ai/knowledge',
  requirePermission(PERMISSIONS.AI_READ),
  validateQuery(v.listKnowledgeQuery),
  asyncHandler(ai.listKnowledgeController),
);
router.post(
  '/ai/knowledge',
  requirePermission(PERMISSIONS.AI_MANAGE),
  validateBody(v.knowledgeDocumentSchema),
  asyncHandler(ai.createKnowledgeController),
);
router.patch(
  '/ai/knowledge/:id',
  requirePermission(PERMISSIONS.AI_MANAGE),
  validate({ params: v.idParam, body: v.updateKnowledgeDocumentSchema }),
  asyncHandler(ai.updateKnowledgeController),
);
router.delete(
  '/ai/knowledge/:id',
  requirePermission(PERMISSIONS.AI_MANAGE),
  validateParams(v.idParam),
  asyncHandler(ai.deleteKnowledgeController),
);
router.post(
  '/ai/knowledge/reindex',
  requirePermission(PERMISSIONS.AI_MANAGE),
  asyncHandler(ai.reindexKnowledgeController),
);
router.post(
  '/ai/knowledge/import-products',
  requirePermission(PERMISSIONS.AI_MANAGE),
  asyncHandler(ai.importProductKnowledgeController),
);
router.post(
  '/ai/test',
  aiLimiter,
  requirePermission(PERMISSIONS.AI_READ),
  validateBody(v.aiTestSchema),
  asyncHandler(ai.testAIController),
);

// Automations
router.get(
  '/automations',
  requirePermission(PERMISSIONS.AUTOMATION_READ),
  asyncHandler(automations.listAutomationsController),
);
router.post(
  '/automations',
  requirePermission(PERMISSIONS.AUTOMATION_CREATE),
  validateBody(v.automationSchema),
  asyncHandler(automations.createAutomationController),
);
router.get(
  '/automations/executions',
  requirePermission(PERMISSIONS.AUTOMATION_READ),
  validateQuery(v.paginationQuery),
  asyncHandler(automations.listExecutionsController),
);
router.get(
  '/automations/:id',
  requirePermission(PERMISSIONS.AUTOMATION_READ),
  validateParams(v.idParam),
  asyncHandler(automations.getAutomationController),
);
router.patch(
  '/automations/:id',
  requirePermission(PERMISSIONS.AUTOMATION_UPDATE),
  validate({ params: v.idParam, body: v.updateAutomationSchema }),
  asyncHandler(automations.updateAutomationController),
);
router.post(
  '/automations/:id/toggle',
  requirePermission(PERMISSIONS.AUTOMATION_UPDATE),
  validate({ params: v.idParam, body: v.toggleSchema }),
  asyncHandler(automations.toggleAutomationController),
);
router.delete(
  '/automations/:id',
  requirePermission(PERMISSIONS.AUTOMATION_DELETE),
  validateParams(v.idParam),
  asyncHandler(automations.deleteAutomationController),
);

// Team
router.get('/team', requirePermission(PERMISSIONS.TEAM_READ), asyncHandler(team.listMembersController));
router.get('/team/agents', requirePermission(PERMISSIONS.TEAM_READ), asyncHandler(team.listAgentsController));
router.get(
  '/team/invitations',
  requirePermission(PERMISSIONS.TEAM_READ),
  asyncHandler(team.listInvitationsController),
);
router.post(
  '/team/invitations',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  validateBody(v.inviteMemberSchema),
  asyncHandler(team.inviteMemberController),
);
router.delete(
  '/team/invitations/:id',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  validateParams(v.idParam),
  asyncHandler(team.revokeInvitationController),
);
router.get(
  '/team/:id',
  requirePermission(PERMISSIONS.TEAM_READ),
  validateParams(v.idParam),
  asyncHandler(team.getMemberController),
);
router.patch(
  '/team/:id',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  validate({ params: v.idParam, body: v.updateMemberSchema }),
  asyncHandler(team.updateMemberController),
);
router.delete(
  '/team/:id',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  validateParams(v.idParam),
  asyncHandler(team.removeMemberController),
);

// Sales
router.get('/sales/summary', requirePermission(PERMISSIONS.SALES_READ), asyncHandler(sales.salesSummaryController));

router.get(
  '/sales/products',
  requirePermission(PERMISSIONS.SALES_READ),
  validateQuery(v.listProductsQuery),
  asyncHandler(sales.listProductsController),
);
router.post(
  '/sales/products',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validateBody(v.productSchema),
  asyncHandler(sales.createProductController),
);
router.get(
  '/sales/products/:id',
  requirePermission(PERMISSIONS.SALES_READ),
  validateParams(v.idParam),
  asyncHandler(sales.getProductController),
);
router.patch(
  '/sales/products/:id',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validate({ params: v.idParam, body: v.updateProductSchema }),
  asyncHandler(sales.updateProductController),
);
router.delete(
  '/sales/products/:id',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validateParams(v.idParam),
  asyncHandler(sales.deleteProductController),
);

router.get(
  '/sales/orders',
  requirePermission(PERMISSIONS.SALES_READ),
  validateQuery(v.listOrdersQuery),
  asyncHandler(sales.listOrdersController),
);
router.post(
  '/sales/orders',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validateBody(v.orderSchema),
  asyncHandler(sales.createOrderController),
);
router.get(
  '/sales/orders/:id',
  requirePermission(PERMISSIONS.SALES_READ),
  validateParams(v.idParam),
  asyncHandler(sales.getOrderController),
);
router.patch(
  '/sales/orders/:id',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validate({ params: v.idParam, body: v.updateOrderSchema }),
  asyncHandler(sales.updateOrderController),
);
router.delete(
  '/sales/orders/:id',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validateParams(v.idParam),
  asyncHandler(sales.deleteOrderController),
);

router.get(
  '/sales/parcels',
  requirePermission(PERMISSIONS.SALES_READ),
  validateQuery(v.listParcelsQuery),
  asyncHandler(sales.listParcelsController),
);
router.post(
  '/sales/parcels',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validateBody(v.parcelSchema),
  asyncHandler(sales.createParcelController),
);
router.get(
  '/sales/parcels/:id',
  requirePermission(PERMISSIONS.SALES_READ),
  validateParams(v.idParam),
  asyncHandler(sales.getParcelController),
);
router.patch(
  '/sales/parcels/:id',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validate({ params: v.idParam, body: v.updateParcelSchema }),
  asyncHandler(sales.updateParcelController),
);
router.post(
  '/sales/parcels/:id/status',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validate({ params: v.idParam, body: v.parcelStatusSchema }),
  asyncHandler(sales.updateParcelStatusController),
);
router.delete(
  '/sales/parcels/:id',
  requirePermission(PERMISSIONS.SALES_MANAGE),
  validateParams(v.idParam),
  asyncHandler(sales.deleteParcelController),
);

// Calls
router.get('/calls/stats', requirePermission(PERMISSIONS.CALLS_READ), asyncHandler(misc.callStatsController));
router.get(
  '/calls',
  requirePermission(PERMISSIONS.CALLS_READ),
  validateQuery(v.listCallsQuery),
  asyncHandler(misc.listCallsController),
);
router.post(
  '/calls',
  requirePermission(PERMISSIONS.CALLS_MANAGE),
  validateBody(v.callSchema),
  asyncHandler(misc.createCallController),
);
router.get(
  '/calls/:id',
  requirePermission(PERMISSIONS.CALLS_READ),
  validateParams(v.idParam),
  asyncHandler(misc.getCallController),
);
router.patch(
  '/calls/:id',
  requirePermission(PERMISSIONS.CALLS_MANAGE),
  validate({ params: v.idParam, body: v.updateCallSchema }),
  asyncHandler(misc.updateCallController),
);
router.delete(
  '/calls/:id',
  requirePermission(PERMISSIONS.CALLS_MANAGE),
  validateParams(v.idParam),
  asyncHandler(misc.deleteCallController),
);

// Templates, tags, custom fields
router.get('/templates', requirePermission(PERMISSIONS.TEMPLATES_READ), asyncHandler(misc.listTemplatesController));
router.post(
  '/templates',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validateBody(v.templateSchema),
  asyncHandler(misc.createTemplateController),
);
router.get(
  '/templates/:id',
  requirePermission(PERMISSIONS.TEMPLATES_READ),
  validateParams(v.idParam),
  asyncHandler(misc.getTemplateController),
);
router.patch(
  '/templates/:id',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validate({ params: v.idParam, body: v.updateTemplateSchema }),
  asyncHandler(misc.updateTemplateController),
);
router.delete(
  '/templates/:id',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validateParams(v.idParam),
  asyncHandler(misc.deleteTemplateController),
);

router.get('/tags', asyncHandler(misc.listTagsController));
router.post(
  '/tags',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateBody(v.tagSchema),
  asyncHandler(misc.createTagController),
);
router.patch(
  '/tags/:id',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate({ params: v.idParam, body: v.tagSchema.partial() }),
  asyncHandler(misc.updateTagController),
);
router.delete(
  '/tags/:id',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateParams(v.idParam),
  asyncHandler(misc.deleteTagController),
);

router.get('/custom-fields', asyncHandler(misc.listCustomFieldsController));
router.post(
  '/custom-fields',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateBody(v.customFieldSchema),
  asyncHandler(misc.createCustomFieldController),
);
router.delete(
  '/custom-fields/:id',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateParams(v.idParam),
  asyncHandler(misc.deleteCustomFieldController),
);

// Notifications
router.get(
  '/notifications',
  validateQuery(v.listNotificationsQuery),
  asyncHandler(misc.listNotificationsController),
);
router.post(
  '/notifications/read-all',
  asyncHandler(misc.markAllNotificationsReadController),
);
router.post(
  '/notifications/:id/read',
  validateParams(v.idParam),
  asyncHandler(misc.markNotificationReadController),
);

// Audit log
router.get(
  '/audit-logs',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateQuery(v.paginationQuery),
  asyncHandler(misc.listAuditLogsController),
);

export default router;
