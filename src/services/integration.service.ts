import {
  IntegrationProvider,
  IntegrationStatus,
  Platform,
  SocialAccountType,
} from '@prisma/client';
import { env, metaScopes, mockMode } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getRedis } from '../lib/redis';
import { decryptNullable, encrypt, randomToken } from '../utils/crypto';
import { BadRequestError, IntegrationError, NotFoundError } from '../utils/errors';
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getMe,
  listBusinesses,
  listPages,
  listWhatsAppAccounts,
  listWhatsAppPhoneNumbers,
  subscribePageToApp,
  unsubscribePageFromApp,
  type MetaPage,
} from '../integrations/meta/client';
import { emitRealtime } from '../realtime/publisher';
import { RealtimeEvent } from '../realtime/events';

const OAUTH_STATE_TTL_SECONDS = 600;

/**
 * OAuth state binds the callback to the organization that started it, so a
 * callback can never attach an account to a different tenant (spec section 12).
 */
export async function createOAuthState(organizationId: string, userId: string): Promise<string> {
  const state = randomToken(24);
  await getRedis().set(
    `oauth:meta:${state}`,
    JSON.stringify({ organizationId, userId }),
    'EX',
    OAUTH_STATE_TTL_SECONDS,
  );
  return state;
}

export async function consumeOAuthState(
  state: string,
): Promise<{ organizationId: string; userId: string }> {
  const key = `oauth:meta:${state}`;
  const raw = await getRedis().get(key);
  if (!raw) throw new BadRequestError('This connection link has expired. Please start again.', [], 'OAUTH_STATE_EXPIRED');
  await getRedis().del(key);
  return JSON.parse(raw) as { organizationId: string; userId: string };
}

export function getMetaAuthUrl(state: string): string {
  if (mockMode) {
    // Without Meta credentials the UI is sent to the local simulator instead
    // of a real consent screen.
    return `${env.FRONTEND_URL}/integrations?mock=1&state=${state}`;
  }
  return buildOAuthUrl(state);
}

export interface ConnectResult {
  integrationId: string;
  availablePages: Array<{
    externalId: string;
    name: string;
    avatarUrl?: string;
    category?: string;
    instagram?: { externalId: string; username?: string; name?: string; avatarUrl?: string };
  }>;
  availableWhatsApp: Array<{
    externalId: string;
    wabaId: string;
    displayPhoneNumber: string;
    verifiedName: string;
  }>;
}

/**
 * Exchanges the OAuth code, stores the encrypted long-lived token and returns
 * the pages / accounts the owner can choose from (onboarding steps 8–10).
 */
export async function completeMetaConnection(
  organizationId: string,
  code: string,
): Promise<ConnectResult> {
  if (mockMode) return completeMockConnection(organizationId);

  const shortLived = await exchangeCodeForToken(code);
  const longLived = await exchangeForLongLivedToken(shortLived.access_token);
  const me = await getMe(longLived.access_token);

  const expiresAt = longLived.expires_in
    ? new Date(Date.now() + longLived.expires_in * 1000)
    : null;

  const integration = await prisma.integration.upsert({
    where: { organizationId_provider: { organizationId, provider: IntegrationProvider.META } },
    create: {
      organizationId,
      provider: IntegrationProvider.META,
      status: IntegrationStatus.CONNECTED,
      externalUserId: me.id,
      displayName: me.name,
      scopes: metaScopes,
      accessTokenEnc: encrypt(longLived.access_token),
      tokenExpiresAt: expiresAt,
      lastSyncedAt: new Date(),
      lastError: null,
    },
    update: {
      status: IntegrationStatus.CONNECTED,
      externalUserId: me.id,
      displayName: me.name,
      scopes: metaScopes,
      accessTokenEnc: encrypt(longLived.access_token),
      tokenExpiresAt: expiresAt,
      lastSyncedAt: new Date(),
      lastError: null,
    },
  });

  const pages = await listPages(longLived.access_token);

  // Page tokens are cached encrypted so selecting a page later needs no
  // second round trip to Meta.
  await cachePageTokens(integration.id, pages);

  const whatsapp = await discoverWhatsAppNumbers(longLived.access_token);

  return {
    integrationId: integration.id,
    availablePages: pages.map((p) => ({
      externalId: p.id,
      name: p.name,
      avatarUrl: p.picture?.data?.url,
      category: p.category,
      instagram: p.instagram_business_account
        ? {
            externalId: p.instagram_business_account.id,
            username: p.instagram_business_account.username,
            name: p.instagram_business_account.name,
            avatarUrl: p.instagram_business_account.profile_picture_url,
          }
        : undefined,
    })),
    availableWhatsApp: whatsapp,
  };
}

async function discoverWhatsAppNumbers(userAccessToken: string) {
  const result: ConnectResult['availableWhatsApp'] = [];
  try {
    const businesses = await listBusinesses(userAccessToken);
    for (const business of businesses) {
      const wabas = await listWhatsAppAccounts(business.id, userAccessToken);
      for (const waba of wabas) {
        const numbers = await listWhatsAppPhoneNumbers(waba.id, userAccessToken);
        for (const number of numbers) {
          result.push({
            externalId: number.id,
            wabaId: waba.id,
            displayPhoneNumber: number.display_phone_number,
            verifiedName: number.verified_name,
          });
        }
      }
    }
  } catch (error) {
    // WhatsApp requires extra permissions and Meta app review; a business
    // without them still gets Messenger and Instagram.
    logger.info({ err: error }, 'WhatsApp discovery unavailable for this Meta account');
  }
  return result;
}

async function cachePageTokens(integrationId: string, pages: MetaPage[]) {
  const payload = pages.map((p) => ({
    id: p.id,
    name: p.name,
    tokenEnc: encrypt(p.access_token),
    igId: p.instagram_business_account?.id ?? null,
  }));
  await prisma.integration.update({
    where: { id: integrationId },
    data: { metadata: { pages: payload } as never },
  });
}

async function completeMockConnection(organizationId: string): Promise<ConnectResult> {
  const integration = await prisma.integration.upsert({
    where: { organizationId_provider: { organizationId, provider: IntegrationProvider.META } },
    create: {
      organizationId,
      provider: IntegrationProvider.META,
      status: IntegrationStatus.CONNECTED,
      displayName: 'Meta (mock mode)',
      scopes: metaScopes,
      lastSyncedAt: new Date(),
      metadata: { mock: true } as never,
    },
    update: { status: IntegrationStatus.CONNECTED, lastSyncedAt: new Date(), lastError: null },
  });

  const suffix = organizationId.slice(-6);

  return {
    integrationId: integration.id,
    availablePages: [
      {
        externalId: `mockpage_${suffix}`,
        name: 'Demo Facebook Page',
        category: 'Business',
        instagram: { externalId: `mockig_${suffix}`, username: 'demo.business', name: 'Demo Business' },
      },
    ],
    availableWhatsApp: [
      {
        externalId: `mockwa_${suffix}`,
        wabaId: `mockwaba_${suffix}`,
        displayPhoneNumber: '+1 555 0100',
        verifiedName: 'Demo Business',
      },
    ],
  };
}

export interface SelectAccountsInput {
  pages?: Array<{ externalId: string; connectInstagram?: boolean }>;
  whatsapp?: Array<{ externalId: string; wabaId: string }>;
}

/**
 * Persists the accounts the owner picked and subscribes the pages so Meta
 * starts delivering webhooks for them.
 */
export async function selectAccounts(organizationId: string, input: SelectAccountsInput) {
  const integration = await prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId, provider: IntegrationProvider.META } },
  });
  if (!integration) throw new NotFoundError('Meta integration');

  const metadata = (integration.metadata ?? {}) as {
    pages?: Array<{ id: string; name: string; tokenEnc: string; igId: string | null }>;
    mock?: boolean;
  };

  const created: string[] = [];

  for (const page of input.pages ?? []) {
    const cached = metadata.pages?.find((p) => p.id === page.externalId);
    const pageToken = cached ? decryptNullable(cached.tokenEnc) : null;

    if (!cached && !mockMode) {
      throw new BadRequestError('That page is no longer available. Please reconnect Meta.');
    }

    const account = await prisma.socialAccount.upsert({
      where: { platform_externalId: { platform: Platform.FACEBOOK, externalId: page.externalId } },
      create: {
        organizationId,
        integrationId: integration.id,
        type: SocialAccountType.FACEBOOK_PAGE,
        platform: Platform.FACEBOOK,
        externalId: page.externalId,
        name: cached?.name ?? 'Facebook Page',
        accessTokenEnc: pageToken ? encrypt(pageToken) : null,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
      update: {
        // Re-selecting a page that another tenant holds must not steal it.
        name: cached?.name ?? undefined,
        accessTokenEnc: pageToken ? encrypt(pageToken) : undefined,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });

    if (account.organizationId !== organizationId) {
      throw new BadRequestError(
        'This Facebook Page is already connected to another Unichat workspace.',
        [],
        'PAGE_ALREADY_CONNECTED',
      );
    }

    if (pageToken && !mockMode) {
      try {
        await subscribePageToApp(page.externalId, pageToken);
        await prisma.socialAccount.update({ where: { id: account.id }, data: { subscribed: true } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Subscription failed';
        await prisma.socialAccount.update({
          where: { id: account.id },
          data: { lastError: message.slice(0, 500), status: IntegrationStatus.ERROR },
        });
      }
    } else if (mockMode) {
      await prisma.socialAccount.update({ where: { id: account.id }, data: { subscribed: true } });
    }

    created.push(account.id);

    if (page.connectInstagram && cached?.igId) {
      const ig = await prisma.socialAccount.upsert({
        where: { platform_externalId: { platform: Platform.INSTAGRAM, externalId: cached.igId } },
        create: {
          organizationId,
          integrationId: integration.id,
          type: SocialAccountType.INSTAGRAM_ACCOUNT,
          platform: Platform.INSTAGRAM,
          externalId: cached.igId,
          // Instagram Direct is sent through the linked page.
          parentExternalId: page.externalId,
          name: cached.name ? `${cached.name} (Instagram)` : 'Instagram account',
          accessTokenEnc: pageToken ? encrypt(pageToken) : null,
          status: IntegrationStatus.CONNECTED,
          subscribed: true,
        },
        update: {
          parentExternalId: page.externalId,
          accessTokenEnc: pageToken ? encrypt(pageToken) : undefined,
          status: IntegrationStatus.CONNECTED,
          isActive: true,
        },
      });
      if (ig.organizationId === organizationId) created.push(ig.id);
    }
  }

  const userToken = decryptNullable(integration.accessTokenEnc);

  for (const number of input.whatsapp ?? []) {
    const account = await prisma.socialAccount.upsert({
      where: { platform_externalId: { platform: Platform.WHATSAPP, externalId: number.externalId } },
      create: {
        organizationId,
        integrationId: integration.id,
        type: SocialAccountType.WHATSAPP_NUMBER,
        platform: Platform.WHATSAPP,
        externalId: number.externalId,
        parentExternalId: number.wabaId,
        name: 'WhatsApp Business',
        accessTokenEnc: userToken ? encrypt(userToken) : null,
        status: IntegrationStatus.CONNECTED,
        subscribed: true,
      },
      update: {
        parentExternalId: number.wabaId,
        accessTokenEnc: userToken ? encrypt(userToken) : undefined,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });
    if (account.organizationId === organizationId) created.push(account.id);
  }

  await emitRealtime(organizationId, RealtimeEvent.INTEGRATION_UPDATED, { connected: created.length });

  return listIntegrations(organizationId);
}

/** Never returns tokens — only status the UI needs (spec section 12). */
export async function listIntegrations(organizationId: string) {
  const [integration, accounts] = await Promise.all([
    prisma.integration.findUnique({
      where: { organizationId_provider: { organizationId, provider: IntegrationProvider.META } },
      select: {
        id: true,
        status: true,
        displayName: true,
        scopes: true,
        tokenExpiresAt: true,
        lastSyncedAt: true,
        lastError: true,
        createdAt: true,
      },
    }),
    prisma.socialAccount.findMany({
      where: { organizationId },
      orderBy: [{ platform: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        type: true,
        platform: true,
        externalId: true,
        name: true,
        username: true,
        avatarUrl: true,
        phoneNumber: true,
        status: true,
        isActive: true,
        subscribed: true,
        lastError: true,
        createdAt: true,
        _count: { select: { conversations: true } },
      },
    }),
  ]);

  const tokenExpired = integration?.tokenExpiresAt
    ? integration.tokenExpiresAt.getTime() < Date.now()
    : false;

  return {
    meta: integration
      ? { ...integration, status: tokenExpired ? IntegrationStatus.EXPIRED : integration.status }
      : null,
    accounts,
    mockMode,
    /**
     * Capabilities that need Meta review are declared so the UI can say so
     * plainly instead of pretending they work (spec section 11).
     */
    capabilities: {
      facebookMessenger: { available: true, requiresReview: ['pages_messaging'] },
      instagramDirect: {
        available: true,
        requiresReview: ['instagram_manage_messages'],
        note: 'Requires an Instagram professional account linked to a connected Facebook Page.',
      },
      whatsapp: {
        available: true,
        requiresReview: ['whatsapp_business_messaging'],
        note: 'Free-form replies are limited to the 24-hour customer service window; outside it an approved template is required.',
      },
    },
  };
}

export async function disconnectAccount(organizationId: string, socialAccountId: string) {
  const account = await prisma.socialAccount.findFirst({
    where: { id: socialAccountId, organizationId },
  });
  if (!account) throw new NotFoundError('Connected channel');

  const token = decryptNullable(account.accessTokenEnc);
  if (token && account.platform === Platform.FACEBOOK && !mockMode) {
    await unsubscribePageFromApp(account.externalId, token).catch((error) =>
      logger.warn({ err: error }, 'failed to unsubscribe page from app'),
    );
  }

  await prisma.socialAccount.update({
    where: { id: account.id },
    data: {
      isActive: false,
      subscribed: false,
      status: IntegrationStatus.DISCONNECTED,
      accessTokenEnc: null,
    },
  });

  await emitRealtime(organizationId, RealtimeEvent.INTEGRATION_UPDATED, { disconnected: account.id });
  return listIntegrations(organizationId);
}

export async function disconnectMeta(organizationId: string) {
  await prisma.$transaction([
    prisma.socialAccount.updateMany({
      where: { organizationId },
      data: { isActive: false, subscribed: false, status: IntegrationStatus.DISCONNECTED, accessTokenEnc: null },
    }),
    prisma.integration.updateMany({
      where: { organizationId, provider: IntegrationProvider.META },
      data: { status: IntegrationStatus.DISCONNECTED, accessTokenEnc: null },
    }),
  ]);

  await emitRealtime(organizationId, RealtimeEvent.INTEGRATION_UPDATED, { disconnected: 'all' });
  return listIntegrations(organizationId);
}

export async function reconnectAccount(organizationId: string, socialAccountId: string) {
  const account = await prisma.socialAccount.findFirst({
    where: { id: socialAccountId, organizationId },
    include: { integration: true },
  });
  if (!account) throw new NotFoundError('Connected channel');

  const token = decryptNullable(account.accessTokenEnc) ?? decryptNullable(account.integration.accessTokenEnc);
  if (!token && !mockMode) {
    throw new IntegrationError('The stored token is no longer valid. Reconnect Meta to continue.');
  }

  if (token && account.platform === Platform.FACEBOOK && !mockMode) {
    await subscribePageToApp(account.externalId, token);
  }

  await prisma.socialAccount.update({
    where: { id: account.id },
    data: { isActive: true, subscribed: true, status: IntegrationStatus.CONNECTED, lastError: null },
  });

  return listIntegrations(organizationId);
}
