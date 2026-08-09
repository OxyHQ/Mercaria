/**
 * Inbound supplier webhooks: `POST /webhooks/suppliers/:supplierAccountId`.
 *
 * ## This router MUST be mounted BEFORE the global `express.json()`
 *
 * A supplier signs (or HMACs) the exact BYTES it sent, and
 * `JSON.stringify(req.body)` reproduces them only by luck — key order, unicode
 * escaping and number formatting all differ. A parser reaching the stream first
 * does not weaken verification, it breaks every delivery. This is the FOURTH
 * router in this application with that property, after `/channels/webhooks`,
 * `/webhooks/crowdsource` and `/webhooks/stripe`, and `app.ts` mounts all four
 * together for exactly this reason.
 *
 * ## The account is in the PATH, and the body cannot claim otherwise
 *
 * A delivery names the supplier account it is for by URL, and the secret to
 * verify against is that account's. Nothing in the body is trusted to say which
 * account it belongs to — that would let one supplier's credential verify
 * another supplier's events, which is #124 security item 10 ("no supplier API
 * can call Mercaria with arbitrary order ids or destinations") at its first
 * hop.
 *
 * The path segment is a Mercaria account row id, not the provider's own: a
 * provider account id is a foreign key space that changes between test and live
 * mode, and using one here would make the endpoint's identity depend on the
 * provider's.
 *
 * ## An unverifiable delivery is REFUSED, never stored
 *
 * `SupplierEventVerification` has no `unverified` member, so an unverified
 * callback has no row shape at all — it cannot be stored now and applied later
 * by a sweep that never re-checked (#124 polling and webhooks 8). Without a
 * credential there is nothing to verify against, so the answer is 401 rather
 * than accepting bytes to interpret later: that would be storing a stranger's
 * opinion, which is the `STRIPE_ENABLED` mount rule.
 *
 * A refusal is COUNTED (`readSupplierEventIngestCounters`) so a spray of forged
 * callbacks is visible on the operator metrics, and the log line carries the
 * account and the reason and no part of the body.
 *
 * ## A 200 means STORED, never processed
 *
 * The handler verifies, resolves and stores. Interpretation is a separate,
 * leased, retryable act (`event-processing.service.ts`), because collapsing the
 * two would make a slow handler a delivery failure the supplier retries — which
 * is how a webhook endpoint gets disabled.
 *
 * ## No Oxy auth, and no rate limiter
 *
 * A supplier is not an Oxy principal and the signature is the entire
 * authenticity story. No scoped limiter is added either, for the reason
 * `/webhooks/stripe` records: a per-IP bucket is one bucket for a provider that
 * delivers from a small pool, so a legitimate retry burst would trip it. What
 * bounds the work is real — `express.raw`'s size limit caps the bytes, an
 * unverifiable body is refused before any database write, and a duplicate costs
 * one indexed insert that conflicts.
 */

import express, { Router, type Request, type Response } from 'express';
import { log } from '../lib/logger.js';
import { findSupplierAccountById, readCredentialReference } from '../db/procurement/supplierAccountRepository.js';
import { readSupplierCredential } from '../services/supplier-orders/credential.port.js';
import {
  ingestSupplierEvent,
  refuseUnverifiedSupplierCallback,
} from '../services/supplier-orders/event-ingest.service.js';
import { resolveOrderAdapter } from '../services/supplier-orders/provider-call.js';

const router = Router();

/**
 * Hard cap on a buffered delivery.
 *
 * The actual bound on what an unauthenticated caller can make this endpoint
 * allocate, which is why it is here rather than relying on a rate limiter that
 * cannot safely be applied. A fulfilment event is small; a megabyte is generous
 * for one carrying a long shipment list.
 */
const MAX_BODY_BYTES = 1_048_576;

router.post(
  '/:supplierAccountId',
  express.raw({ type: '*/*', limit: MAX_BODY_BYTES }),
  async (req: Request, res: Response) => {
    const supplierAccountIdParam = req.params['supplierAccountId'];
    const supplierAccountId =
      typeof supplierAccountIdParam === 'string' ? supplierAccountIdParam : '';
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const account = await findSupplierAccountById(supplierAccountId);
    if (!account) {
      // The SAME answer an unverifiable delivery gets. A distinguishable
      // response would let a caller enumerate which account ids exist.
      refuseUnverifiedSupplierCallback({
        provider: 'unknown',
        supplierAccountId: null,
        reason: 'unknown supplier account',
      });
      res.status(401).json({ success: false, error: 'unverified' });
      return;
    }

    const adapter = resolveOrderAdapter(account.provider);
    if (!adapter?.verifyWebhook || !adapter.capabilities.includes('order_webhooks')) {
      refuseUnverifiedSupplierCallback({
        provider: account.provider,
        supplierAccountId: account.id,
        reason: 'no adapter declares webhook verification for this provider',
      });
      res.status(401).json({ success: false, error: 'unverified' });
      return;
    }

    const secret = await readSupplierCredential((await readCredentialReference(account.id)) ?? null);
    if (secret === null) {
      refuseUnverifiedSupplierCallback({
        provider: account.provider,
        supplierAccountId: account.id,
        reason: 'no credential available to verify against',
      });
      res.status(401).json({ success: false, error: 'unverified' });
      return;
    }

    const verification = adapter.verifyWebhook({
      body,
      headers: req.headers,
      secret,
      providerAccountId: account.providerAccountId,
      environment: account.environment,
    });
    if (verification.verified === false) {
      refuseUnverifiedSupplierCallback({
        provider: account.provider,
        supplierAccountId: account.id,
        reason: verification.reason,
      });
      res.status(401).json({ success: false, error: 'unverified' });
      return;
    }

    const stored = await ingestSupplierEvent({
      supplierAccountId: account.id,
      provider: account.provider,
      delivery: 'webhook',
      verification: verification.verification,
      providerEventId: verification.providerEventId,
      eventType: verification.eventType,
      externalOrderId: verification.externalOrderId,
      clientReference: verification.clientReference,
      state: verification.state,
      providerState: verification.providerState,
      stateMappingVersion: adapter.stateMappingVersion,
      observedAt: verification.observedAt,
      payload: verification.payload,
      shipments: verification.shipments,
    });

    log.general.debug(
      {
        supplierAccountId: account.id,
        eventId: stored.event.id,
        stored: stored.stored,
        purchaseOrderId: stored.event.purchaseOrderId,
      },
      '[Procurement] supplier webhook stored',
    );
    // 200 whether it was new or a duplicate: a supplier retrying a delivery
    // Mercaria already has must be told to stop, and any other answer makes it
    // retry forever.
    res.status(200).json({ success: true, received: true });
  },
);

export default router;
