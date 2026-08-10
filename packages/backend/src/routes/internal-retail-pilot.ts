/**
 * The bounded retail pilot's operator surface (#125).
 *
 * On the SAME sixth allow-list (`PROCUREMENT_OPERATOR_OXY_USER_IDS`) that
 * #122's preflight and #124's procurement surfaces use, and deliberately NOT a
 * seventh: publishing the bounds Mercaria buys under, recording what its
 * supplier balance is, and pausing entry when a threshold is crossed are the
 * same power as reading what Mercaria pays a supplier and flipping a supplier
 * kill switch. Splitting them would create a list to keep in sync with no
 * distinction to justify it.
 *
 * ## What it can do, and the three things it deliberately cannot
 *
 * Drafting a cohort version, allow-listing a SKU and a threshold on that draft,
 * publishing it, recording a funding observation, raising a stop and lifting
 * one. That is the whole surface, and every write is a decision with a name on
 * it.
 *
 * There is no "widen the active cohort" — a widening is a NEW version, which is
 * what makes #125 acceptance 8's measured review something a reader can find
 * rather than something somebody remembers doing. There is no "clear this stop"
 * beside the lift — a lift is attributable, dated and explained, and a clear
 * would be none of those. And there is no "override this admission": the gate is
 * a conjunction of published bounds, and a per-request escape would make every
 * one of them advisory.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  RETAIL_PILOT_AUDIENCES,
  RETAIL_PILOT_STOP_METRICS,
  RETAIL_PILOT_STOP_SCOPES,
  RETAIL_PILOT_THRESHOLD_UNITS,
  SUPPLIER_FUNDING_SOURCES,
} from '@mercaria/shared-types';
import { authenticateToken } from '../middleware/auth.js';
import { requireProcurementOperator } from '../middleware/procurement-operator-authz.js';
import { validateBody, validateId } from '../middleware/validate.js';
import {
  addRetailPilotSkuHandler,
  addRetailPilotThresholdHandler,
  createRetailPilotCohortHandler,
  liftRetailPilotStopHandler,
  listRetailPilotCohortsHandler,
  publishRetailPilotCohortHandler,
  raiseRetailPilotStopHandler,
  recordSupplierFundingHandler,
  retailPilotCohortTraceHandler,
  supplierFundingHandler,
} from '../controllers/retail-pilot-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list — the gate reads the verified
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireProcurementOperator);

/**
 * Every schema is `.strict()`.
 *
 * A body able to carry an unrecognised key is where a bound eventually arrives
 * that nobody meant to publish — `checkoutSchema`'s reasoning, applied to the
 * surface that decides how much Mercaria may buy.
 */
const cohortDraftSchema = z
  .object({
    version: z.number().int().min(1),
    supplierId: z.string().min(1),
    supplierAccountId: z.string().min(1),
    marketCountry: z.string().regex(/^[A-Z]{2}$/),
    currency: z.enum(ALL_CURRENCY_CODES as unknown as [string, ...string[]]),
    audience: z.enum(RETAIL_PILOT_AUDIENCES as unknown as [string, ...string[]]),
    audiencePercentageBps: z.number().int().min(1).max(10_000).optional(),
    maxItemTotalMinor: z.number().int().positive(),
    maxOrderTotalMinor: z.number().int().positive(),
    minOrderTotalMinor: z.number().int().min(0),
    maxLineQuantity: z.number().int().min(1),
    // At least one, because a cohort permitting no shipping service could never
    // sell anything — and the CHECK refuses it at publication anyway.
    permittedShippingServiceCodes: z.array(z.string().min(1)).min(1),
    fundingFloorMinor: z.number().int().min(0),
    fundingAlertMinor: z.number().int().min(0),
    monthlySpendCapMinor: z.number().int().positive(),
    fundingObservationMaxAgeSeconds: z.number().int().min(60),
    rationale: z.string().min(1),
  })
  .strict();

const skuSchema = z
  .object({
    supplierSku: z.string().min(1),
    procurementOfferId: z.string().min(1).optional(),
    // The evidence, in words: design-IP screening, EU availability, category.
    // Mandatory, because an allow-list entry with no reason is a decision
    // nobody can review.
    note: z.string().min(1),
  })
  .strict();

const thresholdSchema = z
  .object({
    metric: z.enum(RETAIL_PILOT_STOP_METRICS as unknown as [string, ...string[]]),
    unit: z.enum(RETAIL_PILOT_THRESHOLD_UNITS as unknown as [string, ...string[]]),
    thresholdValue: z.number().int().min(0),
    windowHours: z.number().int().min(0),
    scope: z.enum(RETAIL_PILOT_STOP_SCOPES as unknown as [string, ...string[]]),
  })
  .strict();

const fundingSchema = z
  .object({
    supplierAccountId: z.string().min(1),
    balanceMinor: z.number().int().min(0),
    currency: z.enum(ALL_CURRENCY_CODES as unknown as [string, ...string[]]),
    source: z.enum(SUPPLIER_FUNDING_SOURCES as unknown as [string, ...string[]]),
    observedAt: z.string().datetime().optional(),
    note: z.string().optional(),
  })
  .strict();

const raiseStopSchema = z
  .object({
    metric: z.enum(RETAIL_PILOT_STOP_METRICS as unknown as [string, ...string[]]),
    scope: z.enum(RETAIL_PILOT_STOP_SCOPES as unknown as [string, ...string[]]),
    scopeRef: z.string(),
    detail: z.string().min(1),
  })
  .strict();

const liftStopSchema = z.object({ liftReason: z.string().min(1) }).strict();

/** GET — every version of the pilot, newest first, with the active one named. */
router.get('/cohorts', listRetailPilotCohortsHandler);

/** GET — one version's bounds, its SKU allow-list, its thresholds and its stops. */
router.get('/cohorts/:cohortId', validateId('cohortId'), retailPilotCohortTraceHandler);

/** POST — draft a version. A draft binds nothing until it is published. */
router.post('/cohorts', validateBody(cohortDraftSchema), createRetailPilotCohortHandler);

/** POST — allow-list one SKU. The trigger refuses a published cohort. */
router.post(
  '/cohorts/:cohortId/skus',
  validateId('cohortId'),
  validateBody(skuSchema),
  addRetailPilotSkuHandler,
);

/** POST — publish one stop threshold onto a draft. */
router.post(
  '/cohorts/:cohortId/thresholds',
  validateId('cohortId'),
  validateBody(thresholdSchema),
  addRetailPilotThresholdHandler,
);

/** POST — publish a draft, superseding the incumbent. All thirteen thresholds or nothing. */
router.post(
  '/cohorts/:cohortId/publish',
  validateId('cohortId'),
  publishRetailPilotCohortHandler,
);

/** GET — the freshest supplier balance Mercaria has recorded. */
router.get(
  '/funding/:supplierAccountId',
  validateId('supplierAccountId'),
  supplierFundingHandler,
);

/** POST — record what the balance is. Append-only; a correction is a new row. */
router.post('/funding', validateBody(fundingSchema), recordSupplierFundingHandler);

/** POST — pause entry by hand. Attributed, and it pauses ENTRY only. */
router.post('/stops', validateBody(raiseStopSchema), raiseRetailPilotStopHandler);

/** POST — lift one stop. Attributable, dated and explained, or the CHECK refuses. */
router.post(
  '/stops/:stopId/lift',
  validateId('stopId'),
  validateBody(liftStopSchema),
  liftRetailPilotStopHandler,
);

export default router;
