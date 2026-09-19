/**
 * The Peable webhook endpoint — `POST /webhooks/peable`.
 *
 * ONE endpoint, where Stripe needs two. Stripe's split exists because its
 * Connect-scope deliveries are signed with a different secret, which is a
 * property of Stripe's API rather than an organisational choice; the gateway
 * signs everything with one secret, so there is one path and no way for a
 * delivery to arrive at the wrong one.
 *
 * ## The two things this router must never gain
 *
 * **`express.json()`, here or above it.** A signature covers BYTES. Re-encoding
 * a parsed body reproduces them only by luck, so a parser reaching the stream
 * first does not weaken verification — it breaks every delivery, permanently,
 * with a green build. `app.ts` mounts this above the global parser and
 * `peable-webhook.integration.test.ts` asserts that against the REAL middleware
 * chain, including a vacuity guard that mounts this same router behind
 * `express.json()` and requires it to fail.
 *
 * **A rate limiter.** The limiter keys anonymous callers by IP, and every
 * gateway delivery arrives from one small pool of addresses — so a per-IP bucket
 * is one bucket for the entire provider, and the first burst after an incident
 * (exactly when the events matter most) is throttled into redelivery. The bound
 * that does apply is `RAW_BODY_LIMIT` below, which is the real cap on what an
 * unauthenticated caller can make this endpoint allocate.
 *
 * There is no Oxy auth either, and that is not an omission: a provider webhook
 * is a different principal and verifies its own signature. Building a second
 * verifier here would be the mistake AGENTS.md names.
 */

import express, { Router, type Request, type Response } from 'express';
import { ingestPeableDelivery, type PeableIngressResult } from '../services/payments/peable/ingress.js';

const router: Router = Router();

/**
 * Hard cap on a buffered delivery.
 *
 * The gateway's own event bodies are far smaller; this is the actual bound on
 * what an unauthenticated caller can make this endpoint allocate, which is why
 * it is here rather than relying on a rate limiter that cannot safely be
 * applied.
 */
const RAW_BODY_LIMIT = '1mb';

/** Turn an ingress result into the HTTP answer. */
function respond(res: Response, result: PeableIngressResult): void {
  switch (result.outcome) {
    case 'accepted':
    case 'duplicate':
      // 200 means STORED. Never processed — see `ingress.ts`.
      res.status(200).json({ received: true, duplicate: result.outcome === 'duplicate' });
      return;
    case 'rejected':
      // 400 and nothing persisted. Not 401: the gateway treats any non-2xx as a
      // failed delivery and retries either way, and a 400 reads correctly in its
      // delivery log as "this endpoint refused the request" rather than implying
      // a credential Mercaria could have supplied.
      res.status(400).json({ received: false, error: result.code });
      return;
  }
}

async function handleDelivery(req: Request, res: Response): Promise<void> {
  const signature = req.get('Peable-Signature');
  if (signature === undefined || signature === '') {
    res.status(400).json({ received: false, error: 'missing_signature' });
    return;
  }

  const result = await ingestPeableDelivery({
    // `express.raw` leaves a Buffer; anything else means a parser got here
    // first, which the integration test exists to stop. An empty buffer then
    // fails verification, which is the safe direction.
    payload: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    signature,
  });
  respond(res, result);
}

router.post('/', express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }), (req, res) => {
  void handleDelivery(req, res);
});

/**
 * NO `express.json()` is mounted on this router, and none may ever be.
 *
 * Unmatched subpaths fall through to the application's normal 404 handling,
 * which is why there is no catch-all here.
 */

export default router;
