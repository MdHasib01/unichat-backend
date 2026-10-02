import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROD = 'repliva.site';
const INTERNAL = 'unichat.nuktatechnologies.com';

/** env.ts parses process.env at import time, so each case re-imports. */
async function load(extraEnv: Record<string, string | undefined> = {}) {
  vi.resetModules();
  Object.assign(process.env, { NODE_ENV: 'production', INTERNAL_AUTH_USER: 'tester', INTERNAL_AUTH_PASS: 's3cret' });
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const host = await import('../src/utils/host');
  const guards = await import('../src/middleware/internalDomain');
  return { ...host, ...guards };
}

function req(host: string, headers: Record<string, string> = {}, path = '/'): Request {
  return { headers: { host, ...headers }, path, method: 'GET' } as unknown as Request;
}

function res() {
  const out = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      out.statusCode = code;
      return out;
    },
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
    },
    type() {
      return out;
    },
    send(body: unknown) {
      out.body = body;
      return out;
    },
    json(body: unknown) {
      out.body = body;
      return out;
    },
  };
  return out;
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('getBaseUrl', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('keeps each allowlisted domain on itself', async () => {
    const { getBaseUrl } = await load();
    expect(getBaseUrl(req(PROD))).toBe('https://repliva.site');
    expect(getBaseUrl(req(INTERNAL))).toBe('https://unichat.nuktatechnologies.com');
    expect(getBaseUrl(req('backend:4000', { 'x-forwarded-host': PROD }))).toBe('https://repliva.site');
  });

  it('falls back to production for unknown hosts, and for localhost in production', async () => {
    const { getBaseUrl } = await load();
    expect(getBaseUrl(req('evil.example.com'))).toBe('https://repliva.site');
    expect(getBaseUrl(req('localhost:3000'))).toBe('https://repliva.site');
  });

  it('allows localhost in development', async () => {
    const { getBaseUrl } = await load({ NODE_ENV: 'development', FRONTEND_URL: 'http://localhost:3000' });
    expect(getBaseUrl(req('localhost:4000'))).toBe('http://localhost:3000');
  });
});

describe('isAllowedOrigin (CORS)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts only the request’s own site', async () => {
    const { isAllowedOrigin } = await load();
    expect(isAllowedOrigin(req(PROD), 'https://repliva.site')).toBe(true);
    expect(isAllowedOrigin(req(PROD), 'https://unichat.nuktatechnologies.com')).toBe(false);
    expect(isAllowedOrigin(req(INTERNAL), 'https://repliva.site')).toBe(false);
    expect(isAllowedOrigin(req(PROD), undefined)).toBe(true);
  });
});

describe('metaHostOnly', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('passes on production and answers 404 on the internal domain', async () => {
    const { metaHostOnly } = await load();
    const next = vi.fn() as unknown as NextFunction;
    metaHostOnly(req(PROD), res() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();

    const blocked = res();
    const next2 = vi.fn() as unknown as NextFunction;
    metaHostOnly(req(INTERNAL), blocked as unknown as Response, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(blocked.statusCode).toBe(404);
  });
});

describe('internalDomainGuard', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('leaves production untouched', async () => {
    const { internalDomainGuard } = await load();
    const out = res();
    const next = vi.fn() as unknown as NextFunction;
    internalDomainGuard(req(PROD), out as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(out.headers['x-robots-tag']).toBeUndefined();
  });

  it('demands Basic Auth on the internal domain and marks it noindex', async () => {
    const { internalDomainGuard } = await load();
    const out = res();
    const next = vi.fn() as unknown as NextFunction;
    internalDomainGuard(req(INTERNAL), out as unknown as Response, next);
    expect(out.statusCode).toBe(401);
    expect(out.headers['www-authenticate']).toMatch(/^Basic /);
    expect(out.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects wrong credentials and accepts the right ones', async () => {
    const { internalDomainGuard } = await load();
    const wrong = res();
    internalDomainGuard(req(INTERNAL, { authorization: basic('tester', 'nope') }), wrong as unknown as Response, vi.fn());
    expect(wrong.statusCode).toBe(401);

    const next = vi.fn() as unknown as NextFunction;
    const right = res();
    internalDomainGuard(req(INTERNAL, { authorization: basic('tester', 's3cret') }), right as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(right.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('refuses everyone when the credentials are not configured', async () => {
    const { internalDomainGuard } = await load({ INTERNAL_AUTH_USER: undefined, INTERNAL_AUTH_PASS: undefined });
    const out = res();
    const next = vi.fn() as unknown as NextFunction;
    internalDomainGuard(req(INTERNAL, { authorization: basic('', '') }), out as unknown as Response, next);
    expect(out.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('serves a Disallow-all robots.txt without auth', async () => {
    const { internalDomainGuard } = await load();
    const out = res();
    internalDomainGuard(req(INTERNAL, {}, '/robots.txt'), out as unknown as Response, vi.fn());
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('Disallow: /');
  });
});

describe('Meta OAuth redirect_uri in production', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is always the repliva.site callback, whatever META_REDIRECT_URI says', async () => {
    await load({ META_APP_ID: 'app1', META_REDIRECT_URI: 'https://unichat.nuktatechnologies.com/api/integrations/meta/callback' });
    const { buildOAuthUrl } = await import('../src/integrations/meta/client');
    const params = new URL(buildOAuthUrl('s')).searchParams;
    expect(params.get('redirect_uri')).toBe('https://repliva.site/api/integrations/meta/callback');
  });
});

describe('session cookies', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('are host-only (__Host- prefix, no Domain) in production', async () => {
    await load();
    const { ACCESS_COOKIE, REFRESH_COOKIE, setAuthCookies } = await import('../src/services/token.service');
    expect(ACCESS_COOKIE.startsWith('__Host-')).toBe(true);
    expect(REFRESH_COOKIE.startsWith('__Host-')).toBe(true);
    const cookie = vi.fn();
    setAuthCookies({ cookie } as unknown as Response, 'a', 'r', new Date(Date.now() + 1000));
    for (const [, , options] of cookie.mock.calls) {
      expect(options.domain).toBeUndefined();
      expect(options.secure).toBe(true);
      expect(options.path).toBe('/');
    }
  });
});
