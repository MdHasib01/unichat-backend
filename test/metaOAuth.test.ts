import { afterEach, describe, expect, it, vi } from 'vitest';

/** env.ts parses process.env at import time, so each case re-imports it. */
async function oauthParams(extraEnv: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { buildOAuthUrl } = await import('../src/integrations/meta/client');
  return new URL(buildOAuthUrl('state123')).searchParams;
}

describe('Meta OAuth dialog URL', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('requests scopes when no Login for Business configuration is set', async () => {
    const params = await oauthParams({
      META_APP_ID: 'app1',
      META_LOGIN_CONFIG_ID: undefined,
      META_SCOPES: 'pages_show_list,pages_messaging',
    });
    expect(params.get('scope')).toBe('pages_show_list,pages_messaging');
    expect(params.get('config_id')).toBeNull();
    expect(params.get('state')).toBe('state123');
    expect(params.get('response_type')).toBe('code');
  });

  it('uses config_id instead of scope when META_LOGIN_CONFIG_ID is set', async () => {
    const params = await oauthParams({ META_APP_ID: 'app1', META_LOGIN_CONFIG_ID: 'cfg_42' });
    expect(params.get('config_id')).toBe('cfg_42');
    expect(params.get('override_default_response_type')).toBe('true');
    expect(params.get('scope')).toBeNull();
    expect(params.get('client_id')).toBe('app1');
  });
});
