/**
 * Oxy's file events — `POST /webhooks/oxy-files` (Oxy ADR 0043 D9).
 *
 * The SIXTH raw-body mount (`docs/house-invariants.md`): Oxy signs the bytes it
 * sent (`oxy-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`), so a
 * parser reaching the stream first does not weaken verification — it breaks
 * every delivery. `app.ts` mounts this above `express.json()` and
 * `oxy-files-webhook.integration.test.ts` asserts it against the real chain,
 * with a vacuity guard behind `express.json()`.
 *
 * ## Registering the endpoint
 *
 * Oxy stores an application's endpoint only after it echoes a challenge —
 * `{ "type": "webhook.challenge", "challenge": "<random>" }` answered with
 * `{ "challenge": "<random>" }` — and shows the signing secret only AFTER that.
 * So the challenge is answered without a signature (it carries nothing to
 * protect), and with `OXY_FILE_EVENTS_ENABLED` on and no
 * `OXY_FILE_EVENTS_SECRET` yet every EVENT is refused 503, which Oxy retries
 * for about three and a half days: enable → register in the Oxy console → set
 * the secret → deploy.
 *
 * No Oxy auth and no rate limiter, for the Peable webhook's reasons: a provider
 * webhook is a different principal that verifies its own signature, and every
 * delivery comes from one small pool of addresses.
 */

import express, { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import { handleOxyFileEvent, toOxyFileEvent } from '../services/catalog-media/file-events.js';
import { verifyOxyFileDelivery } from '../services/catalog-media/oxy-files.js';

const router: Router = Router();

/** A file event is a few hundred bytes; this bounds what an unauthenticated caller can make us buffer. */
const RAW_BODY_LIMIT = '64kb';

async function handleDelivery(req: Request, res: Response): Promise<void> {
  // `express.raw` leaves a Buffer; anything else means a parser got here first,
  // and the empty buffer then fails verification — the safe direction.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const secret = config.oxyFiles.eventsSecret;
  const delivery = verifyOxyFileDelivery(rawBody, req.headers, secret);
  if (delivery.kind === 'challenge') {
    res.status(200).json({ challenge: delivery.challenge });
    return;
  }
  if (!secret) {
    res.status(503).json({ received: false, error: 'not_configured' });
    return;
  }
  if (delivery.kind === 'refused') {
    res.status(400).json({ received: false, error: 'invalid_delivery' });
    return;
  }
  const event = toOxyFileEvent(delivery.event);
  if (!event) {
    res.status(400).json({ received: false, error: 'invalid_event' });
    return;
  }
  try {
    const result = await handleOxyFileEvent(event);
    res.status(200).json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    log.general.error(
      { err: error, type: event.type },
      '[OxyFiles] file event handling failed; Oxy will retry',
    );
    res.status(500).json({ received: false, error: 'handling_failed' });
  }
}

router.post('/', express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }), (req, res) => {
  void handleDelivery(req, res);
});

/** NO `express.json()` is mounted on this router, and none may ever be. */
export default router;
