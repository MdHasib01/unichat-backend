import type { Request, Response } from 'express';
import { Platform } from '@prisma/client';
import { env, mockMode } from '../config/env';
import { prisma } from '../lib/prisma';
import { ok } from '../utils/response';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  completeMetaConnection,
  consumeOAuthState,
  createOAuthState,
  disconnectAccount,
  disconnectMeta,
  getMetaAuthUrl,
  listIntegrations,
  reconnectAccount,
  selectAccounts,
} from '../services/integration.service';
import { auditFromRequest } from '../services/audit.service';
import { ingestMetaWebhook } from '../services/webhook.service';

export async function listIntegrationsController(req: Request, res: Response) {
  return ok(res, await listIntegrations(req.tenant!.organizationId));
}

export async function startMetaConnectController(req: Request, res: Response) {
  const state = await createOAuthState(req.tenant!.organizationId, req.auth!.userId);
  await auditFromRequest(req, 'integration.meta_connect_started');
  return ok(
    res,
    { url: getMetaAuthUrl(state), state, mockMode },
    mockMode
      ? 'Mock mode is on — connect demo channels without Meta credentials'
      : 'Continue in the Meta consent screen',
  );
}

/**
 * Meta redirects the browser here. The organization comes from the signed
 * state we issued, never from the query string.
 */
export async function metaCallbackController(req: Request, res: Response) {
  const { code, state, error, error_description: errorDescription } = req.query as Record<string, string>;

  if (error) {
    return res.redirect(
      `${env.FRONTEND_URL}/integrations?error=${encodeURIComponent(errorDescription || error)}`,
    );
  }
  if (!code || !state) {
    return res.redirect(`${env.FRONTEND_URL}/integrations?error=missing_code`);
  }

  try {
    const { organizationId } = await consumeOAuthState(state);
    const result = await completeMetaConnection(organizationId, code);
    return res.redirect(
      `${env.FRONTEND_URL}/integrations?connected=1&integration=${result.integrationId}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return res.redirect(`${env.FRONTEND_URL}/integrations?error=${encodeURIComponent(message)}`);
  }
}

/** Mock-mode connect: the UI calls this instead of leaving for Meta. */
export async function mockConnectController(req: Request, res: Response) {
  if (!mockMode) {
    throw new ForbiddenError('Mock connect is only available while MOCK_MODE is enabled');
  }
  const result = await completeMetaConnection(req.tenant!.organizationId, 'mock-code');
  await auditFromRequest(req, 'integration.meta_connected_mock');
  return ok(res, result, 'Demo channels are ready to select');
}

export async function availableAccountsController(req: Request, res: Response) {
  const result = await completeMetaConnection(req.tenant!.organizationId, 'refresh');
  return ok(res, result);
}

export async function selectAccountsController(req: Request, res: Response) {
  const result = await selectAccounts(req.tenant!.organizationId, req.body);
  await auditFromRequest(req, 'integration.accounts_selected', { metadata: req.body });
  return ok(res, result, 'Channels connected');
}

export async function disconnectAccountController(req: Request, res: Response) {
  const result = await disconnectAccount(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'integration.account_disconnected', {
    entityType: 'SocialAccount',
    entityId: req.params.id,
  });
  return ok(res, result, 'Channel disconnected');
}

export async function reconnectAccountController(req: Request, res: Response) {
  const result = await reconnectAccount(req.tenant!.organizationId, req.params.id);
  await auditFromRequest(req, 'integration.account_reconnected', {
    entityType: 'SocialAccount',
    entityId: req.params.id,
  });
  return ok(res, result, 'Channel reconnected');
}

export async function disconnectMetaController(req: Request, res: Response) {
  const result = await disconnectMeta(req.tenant!.organizationId);
  await auditFromRequest(req, 'integration.meta_disconnected');
  return ok(res, result, 'Meta disconnected');
}

/**
 * Operator-triggered inbound simulator for mock mode. It builds a real Meta
 * webhook envelope and pushes it through the production pipeline, so nothing
 * about the inbox is faked — only the transport.
 */
export async function simulateInboundController(req: Request, res: Response) {
  if (!mockMode) {
    throw new ForbiddenError('The inbound simulator is only available while MOCK_MODE is enabled');
  }

  const organizationId = req.tenant!.organizationId;
  const account = await prisma.socialAccount.findFirst({
    where: { id: req.body.socialAccountId, organizationId },
  });
  if (!account) throw new NotFoundError('Connected channel');
  if (!account.isActive) throw new BadRequestError('That channel is disconnected');

  const senderId = req.body.senderExternalId ?? `mock_sender_${Date.now()}`;
  const timestamp = Date.now();
  const mid = `mock_mid_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;

  const body =
    account.platform === Platform.WHATSAPP
      ? {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: account.parentExternalId ?? account.externalId,
              changes: [
                {
                  field: 'messages',
                  value: {
                    messaging_product: 'whatsapp',
                    metadata: { phone_number_id: account.externalId },
                    contacts: [{ profile: { name: req.body.senderName ?? 'Demo customer' }, wa_id: senderId }],
                    messages: [
                      {
                        id: mid,
                        from: senderId,
                        timestamp: String(Math.floor(timestamp / 1000)),
                        type: 'text',
                        text: { body: req.body.text },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }
      : {
          object: account.platform === Platform.INSTAGRAM ? 'instagram' : 'page',
          entry: [
            {
              id: account.externalId,
              time: timestamp,
              messaging: [
                {
                  sender: { id: senderId },
                  recipient: { id: account.externalId },
                  timestamp,
                  message: { mid, text: req.body.text },
                },
              ],
            },
          ],
        };

  const queued = await ingestMetaWebhook(body, JSON.stringify(body));

  return ok(
    res,
    { queued, senderExternalId: senderId },
    'Inbound message queued — watch the inbox update in real time',
  );
}
