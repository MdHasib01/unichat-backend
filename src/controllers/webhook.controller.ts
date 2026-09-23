import type { Request, Response } from 'express';
import { env, mockMode } from '../config/env';
import { logger } from '../lib/logger';
import { verifyMetaSignature } from '../utils/crypto';
import { ingestMetaWebhook } from '../services/webhook.service';

/**
 * Meta's subscription handshake: echo hub.challenge when the verify token
 * matches (spec section 13).
 */
export function verifyWebhookController(req: Request, res: Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
    logger.info('meta webhook verified');
    return res.status(200).send(challenge);
  }

  logger.warn('meta webhook verification rejected');
  return res.sendStatus(403);
}

/**
 * Webhook receiver. It verifies the signature, persists + enqueues, and
 * returns 200 immediately — Meta retries anything slower.
 */
export async function receiveWebhookController(req: Request, res: Response) {
  const signature = req.headers['x-hub-signature-256'];

  if (!mockMode) {
    if (!env.META_APP_SECRET) {
      logger.error('META_APP_SECRET missing; rejecting webhook');
      return res.sendStatus(403);
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const header = Array.isArray(signature) ? signature[0] : signature;
    if (!header || !verifyMetaSignature(raw, header, env.META_APP_SECRET)) {
      logger.warn('meta webhook signature mismatch');
      return res.sendStatus(403);
    }
  }

  // Acknowledge first; all real work happens on the queue.
  res.sendStatus(200);

  try {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body);
    const queued = await ingestMetaWebhook(req.body, raw);
    logger.debug({ queued }, 'webhook entries queued');
  } catch (error) {
    logger.error({ err: error }, 'failed to enqueue webhook');
  }
}
