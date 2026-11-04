/**
 * `/internal/affiliate/*` — the affiliate outbound operator surface (#67).
 *
 * ## On the PAYMENT operator key, not the catalogue one
 *
 * `payments.operate`, and deliberately not a new key. Both of
 * this surface's powers are money-adjacent in the same way: approving a
 * destination host decides where Mercaria sends its buyers and therefore which
 * commercial relationships can earn, and the report reads what Mercaria EARNED.
 * "May see all stores' money" is the power `payments.operate` already names, and
 * splitting the host approval onto `catalog.operate` would mean two operators
 * with different remits could each half-configure one rail.
 *
 * Anyone without the key is answered 404 (never a 401 that would advertise the
 * surface exists), and it stays mounted while
 * `OUTBOUND_REDIRECT_ENABLED` is off — the evidence has to be readable during
 * the incident that turned the redirect off, and a host has to be approvable
 * BEFORE the redirect is switched on.
 *
 * ## Four routes, and the omissions are the design
 *
 * There is no "set this click's disposition", no delete of any kind, no "point
 * this offer at that URL" and no "mark this commission paid". The first three
 * would each be a way to make the record say something that did not happen; the
 * fourth would move money outside the ledger, whose only correction is a
 * reversing transaction booked through the one repository that writes it.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requirePaymentOperator } from '../middleware/operator-authz.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  affiliateReportQuerySchema,
  approveOutboundHostSchema,
  listOutboundHostsQuerySchema,
  outboundClickTraceQuerySchema,
  revokeOutboundHostSchema,
} from '../middleware/affiliate-schemas.js';
import {
  affiliateReportHandler,
  approveOutboundHostHandler,
  listOutboundHostsHandler,
  outboundClickTraceHandler,
  revokeOutboundHostHandler,
} from '../controllers/internal-affiliate.controller.js';

const router = Router();

// Authentication FIRST, then the operator gate — it asks Oxy about the verified
// caller's own session, which only `authenticateToken` establishes.
router.use(authenticateToken);
router.use(requirePaymentOperator);

/** GET — every approval for one source, live and revoked. */
router.get('/hosts', validateQuery(listOutboundHostsQuerySchema), listOutboundHostsHandler);

/** POST — approve one destination host for one source. */
router.post('/hosts', validateBody(approveOutboundHostSchema), approveOutboundHostHandler);

/** POST — revoke one live approval, attributably. */
router.post('/hosts/:id/revoke', validateBody(revokeOutboundHostSchema), revokeOutboundHostHandler);

/** GET — one OFFER's recent clicks. The trace opens from nothing else. */
router.get('/clicks', validateQuery(outboundClickTraceQuerySchema), outboundClickTraceHandler);

/** GET — human clicks, non-human clicks and refusals over one window. */
router.get('/report', validateQuery(affiliateReportQuerySchema), affiliateReportHandler);

export default router;
