/**
 * `/internal/payments/*` — the platform operator surface (#50).
 *
 * ## Mounted OUTSIDE `/admin`, and that is the security boundary
 *
 * Everything under `/admin/stores/:storeId/*` is reached through `loadStore`,
 * which establishes a MEMBERSHIP, and gated by `requireStorePermission`, which
 * reads it. That whole chain is scoped to one store by construction — which is
 * exactly why this surface cannot live there. It reads across every store and
 * every P2P seller, so there is no store whose membership could authorize it,
 * and mounting it in that tree would put a platform-wide read one forgotten
 * `requireStorePermission` away from a merchant session.
 *
 * Issue #50 says operator tooling must not be exposed through the merchant
 * dashboard. A separate prefix, a separate gate and no store in the chain is
 * what makes that structural rather than a rule somebody has to remember.
 *
 * ## The MOUNT is gated, not just the handler
 *
 * `app.ts` registers this router only when `PAYMENT_OPERATOR_OXY_USER_IDS` names
 * somebody, so a deployment with no operators answers 404 on every path here —
 * `STRIPE_ENABLED`'s rule rather than the outbox's. There is nothing to park,
 * and a 401 would tell an unauthenticated caller that an operator surface exists
 * on this deployment. `requirePaymentOperator` repeats the check anyway, because
 * the mount and the gate are in different files and that is exactly the pair
 * that drifts.
 *
 * ## Metered, and not for the reason most routes are
 *
 * The `payments` scope, shared with onboarding-link minting. These are
 * authenticated, allow-listed callers, so abuse is not the concern — cost is:
 * `refetch` and every repair make live Stripe API calls against the platform's
 * own rate limit, and a dashboard polling `trace` in a loop during an incident
 * is the realistic way that budget gets spent. The limiter is modest rather than
 * tight, because an operator working an incident must not be locked out of their
 * own tools.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requirePaymentOperator } from '../middleware/operator-authz.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import {
  discrepancyResolutionSchema,
  paymentExceptionsQuerySchema,
  paymentRefetchSchema,
  paymentRepairSchema,
  paymentTraceQuerySchema,
} from '../middleware/payments-schemas.js';
import {
  listExceptionsHandler,
  paymentMetricsHandler,
  refetchPaymentHandler,
  replayEventHandler,
  resolveDiscrepancyHandler,
  runRepairHandler,
  tracePaymentHandler,
} from '../controllers/payments-operator.controller.js';
import { feeScheduleCreateSchema } from '../middleware/fees-schemas.js';
import {
  activateFeeScheduleHandler,
  createFeeScheduleHandler,
  listFeeSchedulesHandler,
  retireFeeScheduleHandler,
} from '../controllers/fee-schedules-operator.controller.js';
import { retailPricingPolicyCreateSchema } from '../middleware/retail-pricing-schemas.js';
import {
  activateRetailPricingPolicyHandler,
  createRetailPricingPolicyHandler,
  listRetailPricingPoliciesHandler,
  retireRetailPricingPolicyHandler,
} from '../controllers/retail-pricing-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list. The order matters: the gate reads
// `getRequiredOxyUserId`, which needs a verified caller — and an allow-list
// consulted before authentication would be comparing against whatever a client
// claimed.
router.use(authenticateToken);
router.use(requirePaymentOperator);
router.use(makeRateLimiter('payments'));

/** Everything known about one payment, from any of five handles. */
router.get('/trace', validateQuery(paymentTraceQuerySchema), tracePaymentHandler);

/** The open discrepancy and exception queues. */
router.get('/exceptions', validateQuery(paymentExceptionsQuerySchema), listExceptionsHandler);

/** The fuller counts `/health` only summarises. */
router.get('/metrics', paymentMetricsHandler);

/** Re-run a failed or dead-lettered event processor (#48's `replayProviderEvent`). */
router.post('/events/:id/replay', replayEventHandler);

/** Re-read provider state for one payment — the sweep's single-item path. */
router.post('/refetch', validateBody(paymentRefetchSchema), refetchPaymentHandler);

/** Run one of the four named repairs. */
router.post('/repairs', validateBody(paymentRepairSchema), runRepairHandler);

/** Close an investigated discrepancy, with an actor and a reason. */
router.post(
  '/discrepancies/:id/resolve',
  validateBody(discrepancyResolutionSchema),
  resolveDiscrepancyHandler,
);

// ── Marketplace fee schedules (#88) ─────────────────────────────────────────
//
// Platform-wide commercial policy, so it lives behind the SAME operator gate as
// the repair tooling — no store membership can express "may set every store's
// commission". Nothing below moves money: schedules price FUTURE orders only,
// and every placed order keeps its immutable snapshot. Activation supersedes
// the previous version atomically; editing an active version is refused by a
// database trigger, not by this router.

/** Every version of every schedule, with audit columns. */
router.get('/fee-schedules', listFeeSchedulesHandler);

/** Draft a new schedule version. */
router.post('/fee-schedules', validateBody(feeScheduleCreateSchema), createFeeScheduleHandler);

/** Publish a draft, superseding the key's current active version. */
router.post('/fee-schedules/:id/activate', activateFeeScheduleHandler);

/** Withdraw an active version (or abandon a draft) without a replacement. */
router.post('/fee-schedules/:id/retire', retireFeeScheduleHandler);

// ── Retail pricing policies (#120) ──────────────────────────────────────────
//
// The other half of "what does Mercaria charge", and the half where Mercaria is
// the SELLER: `mercaria_retail` is cost recovery with zero markup and zero
// intended item profit (ADR 0004 D3). A policy version approves which of the
// eight direct-cost components may enter a customer amount and nothing else —
// there is no markup, margin, profit or padding field on the body, and a
// request that reaches for one is refused by NAME rather than as an unknown
// key. Same operator gate as the fee schedules above, same reason: no store
// membership can express a platform-wide pricing decision.

/** Every version of every retail pricing policy, with audit columns. */
router.get('/retail-pricing-policies', listRetailPricingPoliciesHandler);

/** Draft a new policy version. */
router.post(
  '/retail-pricing-policies',
  validateBody(retailPricingPolicyCreateSchema),
  createRetailPricingPolicyHandler,
);

/** Publish a draft, superseding the key's current active version. */
router.post('/retail-pricing-policies/:id/activate', activateRetailPricingPolicyHandler);

/** Withdraw an active version (or abandon a draft) without a replacement. */
router.post('/retail-pricing-policies/:id/retire', retireRetailPricingPolicyHandler);

export default router;
