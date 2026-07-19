/**
 * Public inbound connector webhooks, mounted at `/channels/webhooks`.
 *
 * The external platform (Shopify, …) delivers product events here server-to-server
 * (no Oxy session, no browser CORS). Authenticity rests on the platform's HMAC over
 * the RAW request body: this route mounts its OWN `express.raw` body parser and is
 * registered BEFORE the global `express.json()` in `index.ts`, so the exact bytes
 * Shopify signed survive for verification (re-serializing parsed JSON would change
 * them and break the check).
 *
 * On a valid signature the event is ENQUEUED onto the `marketplace-sync` queue
 * (`webhook.process`) and acked immediately; the worker does the upsert/archive
 * (inline fallback when Redis is off). An invalid signature is rejected 401.
 */

import express, { Router, type Request, type Response } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { Connection } from '../models/connection.js';
import { verifyShopifyWebhook, isHandledWebhookTopic } from '../connectors/shopify/webhook.js';
import { enqueueWebhookProcess } from '../queue/producers.js';
import { log } from '../lib/logger.js';

const router = Router();

/** Hard cap on a buffered webhook body (Shopify product payloads are well under this). */
const RAW_BODY_LIMIT = '2mb';

/** Send a minimal, non-leaking text response. */
function sendText(res: Response, status: number, message: string): void {
  res.status(status).type('text/plain').send(message);
}

/**
 * POST /channels/webhooks/shopify — verify Shopify's HMAC over the raw body, then
 * enqueue a `webhook.process` job per connected connection for that shop.
 */
router.post(
  '/shopify',
  makeRateLimiter('channels'),
  express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }),
  async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // 1. Authenticity — the app-secret HMAC over the exact raw bytes.
    if (!verifyShopifyWebhook(rawBody, req.get('X-Shopify-Hmac-Sha256'))) {
      sendText(res, 401, 'Invalid webhook signature');
      return;
    }

    const topic = req.get('X-Shopify-Topic');
    const shopDomain = req.get('X-Shopify-Shop-Domain')?.trim().toLowerCase();
    if (!isHandledWebhookTopic(topic) || !shopDomain) {
      // Authentic, but not a topic/shop we act on — ack so Shopify stops retrying.
      sendText(res, 200, 'ignored');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendText(res, 400, 'Malformed JSON body');
      return;
    }

    try {
      // Resolve the connection(s) by shop domain — server-side, never trusting a
      // client-supplied id. The `{provider, externalId}` upsert is idempotent, so
      // enqueuing per connected connection is safe in the (rare) multi-store case.
      const connections = await Connection.find({
        provider: 'shopify',
        shopDomain,
        status: 'connected',
      }).select('_id');

      for (const conn of connections) {
        await enqueueWebhookProcess({ connectionId: String(conn._id), topic, payload });
      }
      sendText(res, 200, 'ok');
    } catch (err) {
      log.general.error({ err, shopDomain, topic }, 'Failed to enqueue Shopify webhook');
      // 5xx asks Shopify to retry the delivery later.
      sendText(res, 500, 'error');
    }
  },
);

export default router;
