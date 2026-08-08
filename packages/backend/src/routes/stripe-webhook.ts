/**
 * Inbound Stripe webhooks: `/webhooks/stripe` and `/webhooks/stripe/connect`.
 *
 * ## This router MUST be mounted BEFORE the global `express.json()`
 *
 * Stripe signs the exact BYTES it sent. `JSON.stringify(req.body)` reproduces
 * them only by luck — key order, unicode escaping and number formatting all
 * differ — so a parser reaching the stream first does not weaken verification,
 * it breaks every delivery. The third router in this application with that
 * property, after `/channels/webhooks` (Shopify's HMAC) and
 * `/webhooks/crowdsource`, and `app.ts` mounts all three together for exactly
 * this reason.
 *
 * This router mounts its OWN `express.raw` on each path, so the bytes survive as
 * a Buffer. That parser must never be replaced by `express.json()` "for
 * consistency": it would run before the handler on every request to these paths
 * and silently make every signature fail.
 *
 * `routes/__tests__/stripe-webhook.integration.test.ts` asserts the invariant
 * against the REAL middleware chain — a valid signature verifies through
 * `createApp()` and fails through a deliberately json-parsed copy of the same
 * router — so a later reorder fails CI rather than production.
 *
 * ## Two endpoints, because Stripe signs them with two different secrets
 *
 * ADR 0001 registers a platform-scope endpoint (`connect=false`) and a
 * Connect-scope one (`connect=true`). They are separate Stripe objects with
 * separate signing secrets, so they cannot share a path — the secret to verify
 * against is decided by which endpoint the delivery arrived at, and nothing in
 * the body can be trusted to say.
 *
 * ## No Oxy auth, and no rate limiter
 *
 * No session, no bearer, no device: Stripe is not an Oxy principal and the
 * signature is the entire authenticity story (issue #48, security 1). The
 * routers are mounted before the global limiter too, and no scoped limiter is
 * added here — deliberately. `makeRateLimiter` keys anonymous callers by IP, and
 * every Stripe delivery on earth arrives from a small pool of Stripe's own
 * addresses, so a per-IP bucket is one bucket for the entire provider: a
 * legitimate burst (an incident backlog being redelivered, a batch of payouts)
 * would trip it, and Stripe would retry into the same bucket until it disabled
 * the endpoint (issue #48, security 2 — "rate limits must not block legitimate
 * Stripe retries"). What bounds the work instead is real: `express.raw`'s size
 * limit caps the bytes, an unverifiable body is refused before any database
 * access, and a duplicate costs one indexed insert that conflicts.
 */

import express, { Router, type Request, type Response } from 'express';
import { ingestStripeDelivery, type StripeIngressResult } from '../services/payments/stripe/ingress.js';
import type { StripeWebhookScope } from '../services/payments/stripe/event-scopes.js';

const router = Router();

/**
 * Hard cap on a buffered delivery.
 *
 * Stripe's own limit on an event payload is well under this; the biggest real
 * ones are a `charge` with a long metadata set. This is the actual bound on what
 * an unauthenticated caller can make this endpoint allocate, which is why it is
 * here rather than relying on a rate limiter that cannot safely be applied.
 */
const RAW_BODY_LIMIT = '1mb';

/** Turn an ingress result into the HTTP answer. */
function respond(res: Response, result: StripeIngressResult): void {
  switch (result.outcome) {
    case 'accepted':
    case 'duplicate':
      // 200 means STORED. Never processed — see `ingress.ts`.
      res.status(200).json({ received: true, duplicate: result.outcome === 'duplicate' });
      return;
    case 'ignored':
      // Authentic and correctly refused. 200 so Stripe stops retrying something
      // that will never be accepted; the `code` says which condition it was.
      res.status(200).json({ received: false, ignored: result.code });
      return;
    case 'rejected':
      // 400 and nothing persisted. Not 401: Stripe treats any non-2xx as a
      // failed delivery and retries either way, and a 400 reads correctly in the
      // dashboard as "this endpoint refused the request" rather than implying a
      // credential Mercaria could have supplied.
      res.status(400).json({ received: false, error: result.code });
      return;
  }
}

/** One endpoint's handler. Both scopes run identical code with a different secret. */
function handleDelivery(scope: StripeWebhookScope) {
  return async (req: Request, res: Response): Promise<void> => {
    const signature = req.get('Stripe-Signature');
    if (signature === undefined || signature === '') {
      res.status(400).json({ received: false, error: 'missing_signature' });
      return;
    }

    const result = await ingestStripeDelivery({
      // `express.raw` leaves a Buffer; anything else means a parser got here
      // first, which the integration test exists to stop. An empty buffer then
      // fails verification, which is the safe direction.
      payload: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      signature,
      scope,
    });
    respond(res, result);
  };
}

/**
 * The CONNECT path is registered first.
 *
 * Express matches in registration order and `/` on this router would otherwise
 * also match `/connect`'s parent path for a POST to `/connect`… it would not,
 * but the ordering is written down anyway because the two paths differ by a
 * suffix and a future `router.post('/*')` added above them would silently
 * swallow the connect endpoint into the platform secret — verifying every
 * connect delivery against the wrong secret and rejecting all of them.
 */
router.post(
  '/connect',
  express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }),
  handleDelivery('connect'),
);

router.post('/', express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }), handleDelivery('platform'));

/**
 * NO `express.json()` is mounted on this router, and none may ever be.
 *
 * Unmatched subpaths fall through to the application's normal 404 handling,
 * which is why there is no catch-all here.
 */

export default router;
