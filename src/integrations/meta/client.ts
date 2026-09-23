import axios, { AxiosError, type AxiosInstance } from 'axios';
import { env, metaScopes } from '../../config/env';
import { logger } from '../../lib/logger';
import { IntegrationError } from '../../utils/errors';

const GRAPH_BASE = `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

export const graph: AxiosInstance = axios.create({
  baseURL: GRAPH_BASE,
  timeout: 20_000,
});

graph.interceptors.response.use(
  (r) => r,
  (error: AxiosError<{ error?: { message?: string; type?: string; code?: number } }>) => {
    const meta = error.response?.data?.error;
    // Tokens live in params; never let them reach the logs.
    logger.error(
      { status: error.response?.status, metaCode: meta?.code, metaType: meta?.type, path: error.config?.url },
      `meta graph error: ${meta?.message ?? error.message}`,
    );
    throw new IntegrationError(meta?.message ?? 'Meta API request failed');
  },
);

export interface MetaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

export function buildOAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.META_APP_ID ?? '',
    redirect_uri: env.META_REDIRECT_URI,
    state,
    scope: metaScopes.join(','),
    response_type: 'code',
  });
  return `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<MetaTokenResponse> {
  const { data } = await graph.get<MetaTokenResponse>('/oauth/access_token', {
    params: {
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      redirect_uri: env.META_REDIRECT_URI,
      code,
    },
  });
  return data;
}

/** Short-lived user tokens are swapped for ~60-day long-lived tokens. */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<MetaTokenResponse> {
  const { data } = await graph.get<MetaTokenResponse>('/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    },
  });
  return data;
}

export interface MetaMe {
  id: string;
  name: string;
  email?: string;
}

export async function getMe(accessToken: string): Promise<MetaMe> {
  const { data } = await graph.get<MetaMe>('/me', {
    params: { fields: 'id,name,email', access_token: accessToken },
  });
  return data;
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
  tasks?: string[];
}

export async function listPages(userAccessToken: string): Promise<MetaPage[]> {
  const { data } = await graph.get<{ data: MetaPage[] }>('/me/accounts', {
    params: {
      fields:
        'id,name,access_token,category,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
      limit: 100,
      access_token: userAccessToken,
    },
  });
  return data.data ?? [];
}

export interface MetaBusiness {
  id: string;
  name: string;
}

export async function listBusinesses(userAccessToken: string): Promise<MetaBusiness[]> {
  const { data } = await graph.get<{ data: MetaBusiness[] }>('/me/businesses', {
    params: { fields: 'id,name', limit: 50, access_token: userAccessToken },
  });
  return data.data ?? [];
}

export interface WhatsAppBusinessAccount {
  id: string;
  name: string;
}

export async function listWhatsAppAccounts(
  businessId: string,
  userAccessToken: string,
): Promise<WhatsAppBusinessAccount[]> {
  const { data } = await graph.get<{ data: WhatsAppBusinessAccount[] }>(
    `/${businessId}/owned_whatsapp_business_accounts`,
    { params: { access_token: userAccessToken, limit: 50 } },
  );
  return data.data ?? [];
}

export interface WhatsAppPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating?: string;
}

export async function listWhatsAppPhoneNumbers(
  wabaId: string,
  accessToken: string,
): Promise<WhatsAppPhoneNumber[]> {
  const { data } = await graph.get<{ data: WhatsAppPhoneNumber[] }>(`/${wabaId}/phone_numbers`, {
    params: {
      access_token: accessToken,
      fields: 'id,display_phone_number,verified_name,quality_rating',
      limit: 50,
    },
  });
  return data.data ?? [];
}

/** Subscribing the page is what makes Meta deliver webhooks for it. */
export async function subscribePageToApp(pageId: string, pageAccessToken: string): Promise<void> {
  await graph.post(
    `/${pageId}/subscribed_apps`,
    {},
    {
      params: {
        access_token: pageAccessToken,
        subscribed_fields:
          'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads,messaging_referrals',
      },
    },
  );
}

export async function unsubscribePageFromApp(pageId: string, pageAccessToken: string): Promise<void> {
  await graph.delete(`/${pageId}/subscribed_apps`, { params: { access_token: pageAccessToken } });
}

export interface MessengerUserProfile {
  id: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  profile_pic?: string;
  locale?: string;
}

export async function getMessengerProfile(
  psid: string,
  pageAccessToken: string,
): Promise<MessengerUserProfile | null> {
  try {
    const { data } = await graph.get<MessengerUserProfile>(`/${psid}`, {
      params: { fields: 'id,first_name,last_name,profile_pic,locale', access_token: pageAccessToken },
    });
    return data;
  } catch {
    // Profile access needs extra permissions; the inbox works without it.
    return null;
  }
}

export interface InstagramUserProfile {
  id: string;
  username?: string;
  name?: string;
  profile_pic?: string;
}

export async function getInstagramProfile(
  igsid: string,
  pageAccessToken: string,
): Promise<InstagramUserProfile | null> {
  try {
    const { data } = await graph.get<InstagramUserProfile>(`/${igsid}`, {
      params: { fields: 'id,username,name,profile_pic', access_token: pageAccessToken },
    });
    return data;
  } catch {
    return null;
  }
}

export interface SendApiResponse {
  recipient_id?: string;
  message_id?: string;
  messages?: Array<{ id: string }>;
  contacts?: Array<{ wa_id: string }>;
}

/** Messenger + Instagram Direct share the Send API. */
export async function sendViaSendApi(
  pageId: string,
  pageAccessToken: string,
  body: Record<string, unknown>,
): Promise<SendApiResponse> {
  const { data } = await graph.post<SendApiResponse>(`/${pageId}/messages`, body, {
    params: { access_token: pageAccessToken },
  });
  return data;
}

/** WhatsApp Cloud API posts to the phone number id. */
export async function sendViaWhatsAppCloud(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<SendApiResponse> {
  const { data } = await graph.post<SendApiResponse>(`/${phoneNumberId}/messages`, body, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

export async function markSeenViaSendApi(
  pageId: string,
  pageAccessToken: string,
  recipientId: string,
): Promise<void> {
  await graph
    .post(
      `/${pageId}/messages`,
      { recipient: { id: recipientId }, sender_action: 'mark_seen' },
      { params: { access_token: pageAccessToken } },
    )
    .catch(() => undefined);
}
