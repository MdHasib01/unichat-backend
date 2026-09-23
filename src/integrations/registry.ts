import { Platform } from '@prisma/client';
import { mockMode } from '../config/env';
import { prisma } from '../lib/prisma';
import { decryptNullable } from '../utils/crypto';
import { IntegrationError, NotFoundError } from '../utils/errors';
import { facebookProvider } from './facebook/facebook.provider';
import { instagramProvider } from './instagram/instagram.provider';
import { whatsappProvider } from './whatsapp/whatsapp.provider';
import {
  mockFacebookProvider,
  mockInstagramProvider,
  mockWhatsAppProvider,
} from './mock/mock.provider';
import type { MessagingProvider, ProviderCredentials } from './types';

const REAL_PROVIDERS: Record<Platform, MessagingProvider | null> = {
  FACEBOOK: facebookProvider,
  INSTAGRAM: instagramProvider,
  WHATSAPP: whatsappProvider,
  INTERNAL: null,
};

const MOCK_PROVIDERS: Record<Platform, MessagingProvider | null> = {
  FACEBOOK: mockFacebookProvider,
  INSTAGRAM: mockInstagramProvider,
  WHATSAPP: mockWhatsAppProvider,
  INTERNAL: null,
};

/**
 * Adding Telegram, TikTok, email or SMS later means registering one more
 * adapter here — nothing downstream changes (spec section 10).
 */
export function getProvider(platform: Platform): MessagingProvider {
  const table = mockMode ? MOCK_PROVIDERS : REAL_PROVIDERS;
  const provider = table[platform];
  if (!provider) throw new IntegrationError(`No messaging provider registered for ${platform}`);
  return provider;
}

/**
 * Resolves the credentials for one social account, scoped to the organization.
 * Tokens are decrypted here and never leave the backend.
 */
export async function resolveCredentials(
  organizationId: string,
  socialAccountId: string,
): Promise<ProviderCredentials> {
  const account = await prisma.socialAccount.findFirst({
    where: { id: socialAccountId, organizationId },
    select: {
      id: true,
      organizationId: true,
      externalId: true,
      parentExternalId: true,
      accessTokenEnc: true,
      isActive: true,
      integration: { select: { accessTokenEnc: true } },
    },
  });

  if (!account) throw new NotFoundError('Connected channel');
  if (!account.isActive) throw new IntegrationError('This channel is disconnected');

  const token =
    decryptNullable(account.accessTokenEnc) ??
    decryptNullable(account.integration.accessTokenEnc) ??
    (mockMode ? 'mock-token' : null);

  if (!token) {
    throw new IntegrationError('This channel has no valid access token. Please reconnect it.');
  }

  return {
    organizationId: account.organizationId,
    socialAccountId: account.id,
    accessToken: token,
    externalId: account.externalId,
    parentExternalId: account.parentExternalId,
  };
}

export const SUPPORTED_PLATFORMS: Platform[] = [
  Platform.FACEBOOK,
  Platform.INSTAGRAM,
  Platform.WHATSAPP,
];

export function isMockMode(): boolean {
  return mockMode;
}
