import { describe, expect, it } from 'vitest';
import { issueVisitorToken, verifyVisitorToken } from '../src/services/widgetToken.service';
import { isOriginAllowed, normalizeDomain } from '../src/utils/domains';

describe('visitor tokens', () => {
  it('round-trips for the widget it was issued for', () => {
    const { token, visitorId } = issueVisitorToken('widget_a');
    const claims = verifyVisitorToken(token, 'widget_a');
    expect(claims?.vid).toBe(visitorId);
    expect(visitorId.startsWith('v_')).toBe(true);
  });

  it('is rejected for another widget', () => {
    const { token } = issueVisitorToken('widget_a');
    expect(verifyVisitorToken(token, 'widget_b')).toBeNull();
  });

  it('is rejected when tampered with', () => {
    const { token } = issueVisitorToken('widget_a');
    const [body, signature] = token.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), vid: 'v_someoneelse' }),
    ).toString('base64url');
    expect(verifyVisitorToken(`${forgedBody}.${signature}`, 'widget_a')).toBeNull();
    expect(verifyVisitorToken(`${body}.${signature.slice(0, -2)}xx`, 'widget_a')).toBeNull();
  });

  it('rejects junk', () => {
    expect(verifyVisitorToken(undefined, 'w')).toBeNull();
    expect(verifyVisitorToken('not-a-token', 'w')).toBeNull();
    expect(verifyVisitorToken('a.b.c', 'w')).toBeNull();
  });
});

describe('allowed domains', () => {
  it('allows everything when the list is empty', () => {
    expect(isOriginAllowed('https://anything.test', [])).toBe(true);
  });

  it('matches exact hosts', () => {
    expect(isOriginAllowed('https://shop.example.com', ['shop.example.com'])).toBe(true);
    expect(isOriginAllowed('https://evil.com', ['shop.example.com'])).toBe(false);
    expect(isOriginAllowed('https://shop.example.com.evil.com', ['shop.example.com'])).toBe(false);
  });

  it('matches wildcards, including the bare domain', () => {
    const list = ['*.example.com'];
    expect(isOriginAllowed('https://a.example.com', list)).toBe(true);
    expect(isOriginAllowed('https://a.b.example.com', list)).toBe(true);
    expect(isOriginAllowed('https://example.com', list)).toBe(true);
    expect(isOriginAllowed('https://notexample.com', list)).toBe(false);
  });

  it('refuses a missing or opaque origin when a list is set', () => {
    expect(isOriginAllowed(undefined, ['example.com'])).toBe(false);
    expect(isOriginAllowed('null', ['example.com'])).toBe(false);
  });

  it('normalizes pasted URLs', () => {
    expect(normalizeDomain('https://Shop.Example.com/path?q=1')).toBe('shop.example.com');
    expect(normalizeDomain('*.Example.com')).toBe('*.example.com');
    expect(normalizeDomain('localhost:3000')).toBe('localhost');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('intranet')).toBeNull();
  });
});
