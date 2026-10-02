import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const VERIFY_TOKEN = 'verify-token-for-tests';
const APP_SECRET = 'app-secret-for-tests';

/** env.ts parses process.env at import time, so each case re-imports it. */
async function loadController() {
  vi.resetModules();
  Object.assign(process.env, {
    MOCK_MODE: 'false',
    META_APP_ID: 'app1',
    META_APP_SECRET: APP_SECRET,
    META_VERIFY_TOKEN: VERIFY_TOKEN,
  });
  const ingest = vi.fn().mockResolvedValue(1);
  vi.doMock('../src/services/webhook.service', () => ({ ingestMetaWebhook: ingest }));
  const controller = await import('../src/controllers/webhook.controller');
  return { ...controller, ingest };
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    sendStatus(code: number) {
      res.statusCode = code;
      return res;
    },
  };
  return res;
}

function sign(raw: Buffer, secret = APP_SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
}

describe('GET /api/webhooks/meta (subscription handshake)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('echoes hub.challenge with 200 when the verify token matches', async () => {
    const { verifyWebhookController } = await loadController();
    const res = fakeResponse();
    verifyWebhookController(
      { query: { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' } } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
  });

  it('returns 403 when the verify token is wrong', async () => {
    const { verifyWebhookController } = await loadController();
    const res = fakeResponse();
    verifyWebhookController(
      { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' } } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/webhooks/meta (X-Hub-Signature-256)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const payload = { object: 'page', entry: [{ id: '1', time: 1, messaging: [] }] };
  const raw = Buffer.from(JSON.stringify(payload));

  it('accepts a body signed with the app secret', async () => {
    const { receiveWebhookController, ingest } = await loadController();
    const res = fakeResponse();
    await receiveWebhookController(
      { headers: { 'x-hub-signature-256': sign(raw) }, body: payload, rawBody: raw } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledOnce();
  });

  it('rejects a body signed with a different secret', async () => {
    const { receiveWebhookController, ingest } = await loadController();
    const res = fakeResponse();
    await receiveWebhookController(
      { headers: { 'x-hub-signature-256': sign(raw, 'other-secret') }, body: payload, rawBody: raw } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature header', async () => {
    const { receiveWebhookController, ingest } = await loadController();
    const res = fakeResponse();
    await receiveWebhookController(
      { headers: {}, body: payload, rawBody: raw } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });
});
