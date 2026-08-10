/**
 * The bounded retail pilot's operator handlers (#125).
 *
 * Thin, for the reason every other operator controller in this repo is: each
 * one validates, calls exactly one service or repository function, and projects.
 * The decisions live in `services/retail-pilot/`, which is pure and testable
 * without an HTTP request.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  ALL_CURRENCY_CODES,
  RETAIL_PILOT_AUDIENCES,
  RETAIL_PILOT_STOP_METRICS,
  RETAIL_PILOT_STOP_SCOPES,
  RETAIL_PILOT_THRESHOLD_UNITS,
  SUPPLIER_FUNDING_SOURCES,
} from '@mercaria/shared-types';
import type {
  CurrencyCode,
  RetailPilotAudience,
  RetailPilotStopMetric,
  RetailPilotStopScope,
  RetailPilotThresholdUnit,
  SupplierFundingSource,
} from '@mercaria/shared-types';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { validationError } from '../lib/errors/error-codes.js';
import { procurementOperatorId } from '../middleware/procurement-operator-authz.js';
import {
  addRetailPilotSku,
  addRetailPilotThreshold,
  createRetailPilotCohortDraft,
  findActiveRetailPilotCohort,
  findLatestSupplierFunding,
  listRetailPilotCohorts,
  listRetailPilotSkus,
  listRetailPilotStops,
  listRetailPilotThresholds,
  publishRetailPilotCohortVersion,
} from '../db/retailPilot/pilotRepository.js';
import { RETAIL_PILOT_COHORT_KEY } from '../services/retail-pilot/admission.js';
import {
  liftRetailPilotStop,
  raiseRetailPilotStop,
  recordSupplierFundingObservation,
} from '../services/retail-pilot/pilot.service.js';

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`\`${name}\` is required.`);
  }
  return value;
}

/** Read one closed-set value off a validated body, narrowed rather than cast. */
function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  const found = values.find((entry) => entry === value);
  if (found === undefined) throw validationError(`\`${field}\` is not a recognised value.`);
  return found;
}

/** GET — every version of the pilot, newest first, with the active one named. */
export async function listRetailPilotCohortsHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const versions = await listRetailPilotCohorts(RETAIL_PILOT_COHORT_KEY);
    const active = await findActiveRetailPilotCohort(RETAIL_PILOT_COHORT_KEY);
    sendSuccess(res, { versions, activeVersion: active?.version ?? null });
  } catch (error) {
    next(error);
  }
}

/** GET — one version's bounds, its SKU allow-list, its thresholds and its stops. */
export async function retailPilotCohortTraceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cohortId = requiredParam(req, 'cohortId');
    const versions = await listRetailPilotCohorts(RETAIL_PILOT_COHORT_KEY);
    const cohort = versions.find((entry) => entry.id === cohortId);
    if (!cohort) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    const [skus, thresholds, stops] = await Promise.all([
      listRetailPilotSkus(cohortId),
      listRetailPilotThresholds(cohortId),
      listRetailPilotStops(cohortId),
    ]);
    sendSuccess(res, { cohort, skus, thresholds, stops });
  } catch (error) {
    next(error);
  }
}

/** POST — draft a version. A draft binds nothing until it is published. */
export async function createRetailPilotCohortHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const cohort = await createRetailPilotCohortDraft({
      cohortKey: RETAIL_PILOT_COHORT_KEY,
      version: Number(body['version']),
      supplierId: String(body['supplierId']),
      supplierAccountId: String(body['supplierAccountId']),
      marketCountry: String(body['marketCountry']),
      currency: oneOf<CurrencyCode>(ALL_CURRENCY_CODES, body['currency'], 'currency'),
      audience: oneOf<RetailPilotAudience>(RETAIL_PILOT_AUDIENCES, body['audience'], 'audience'),
      audiencePercentageBps:
        body['audiencePercentageBps'] === undefined ? null : Number(body['audiencePercentageBps']),
      maxItemTotalMinor: Number(body['maxItemTotalMinor']),
      maxOrderTotalMinor: Number(body['maxOrderTotalMinor']),
      minOrderTotalMinor: Number(body['minOrderTotalMinor']),
      maxLineQuantity: Number(body['maxLineQuantity']),
      permittedShippingServiceCodes: (body['permittedShippingServiceCodes'] as string[]) ?? [],
      fundingFloorMinor: Number(body['fundingFloorMinor']),
      fundingAlertMinor: Number(body['fundingAlertMinor']),
      monthlySpendCapMinor: Number(body['monthlySpendCapMinor']),
      fundingObservationMaxAgeSeconds: Number(body['fundingObservationMaxAgeSeconds']),
      rationale: String(body['rationale']),
    });
    sendSuccess(res, cohort, 201);
  } catch (error) {
    next(error);
  }
}

/** POST — allow-list one SKU. The trigger refuses a published cohort. */
export async function addRetailPilotSkuHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    await addRetailPilotSku({
      cohortId: requiredParam(req, 'cohortId'),
      supplierSku: String(body['supplierSku']),
      procurementOfferId:
        body['procurementOfferId'] === undefined ? null : String(body['procurementOfferId']),
      addedByOxyUserId: procurementOperatorId(req),
      note: String(body['note']),
    });
    sendSuccess(res, { added: true }, 201);
  } catch (error) {
    next(error);
  }
}

/** POST — publish one stop threshold onto a draft. */
export async function addRetailPilotThresholdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    await addRetailPilotThreshold({
      cohortId: requiredParam(req, 'cohortId'),
      metric: oneOf<RetailPilotStopMetric>(RETAIL_PILOT_STOP_METRICS, body['metric'], 'metric'),
      unit: oneOf<RetailPilotThresholdUnit>(RETAIL_PILOT_THRESHOLD_UNITS, body['unit'], 'unit'),
      thresholdValue: Number(body['thresholdValue']),
      windowHours: Number(body['windowHours']),
      scope: oneOf<RetailPilotStopScope>(RETAIL_PILOT_STOP_SCOPES, body['scope'], 'scope'),
    });
    sendSuccess(res, { added: true }, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * POST — publish a draft, superseding the incumbent.
 *
 * The one act that changes what Mercaria may buy, and it refuses a draft whose
 * thresholds do not cover all thirteen metrics: a pilot running with an
 * unmonitored stop condition is one whose review has a hole in it, and the
 * cheapest moment to find that is before it is live.
 */
export async function publishRetailPilotCohortHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cohortId = requiredParam(req, 'cohortId');
    const thresholds = await listRetailPilotThresholds(cohortId);
    const covered = new Set(thresholds.map((entry) => entry.metric));
    const missing = RETAIL_PILOT_STOP_METRICS.filter((metric) => !covered.has(metric));
    if (missing.length > 0) {
      throw validationError(
        `This cohort has no threshold for ${missing.join(', ')}. Every stop condition needs a ` +
          'published number before the pilot may run under these bounds.',
      );
    }
    const skus = await listRetailPilotSkus(cohortId);
    if (skus.length === 0) {
      // A cohort allow-listing nothing could sell nothing, which reads as a
      // broken pilot rather than a deliberately empty one.
      throw validationError('This cohort allow-lists no SKU, so it could never sell anything.');
    }
    const published = await publishRetailPilotCohortVersion({
      cohortId,
      publishedByOxyUserId: procurementOperatorId(req),
    });
    if (!published) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    sendSuccess(res, published);
  } catch (error) {
    next(error);
  }
}

/** GET — the freshest supplier balance Mercaria has recorded. */
export async function supplierFundingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const latest = await findLatestSupplierFunding(requiredParam(req, 'supplierAccountId'));
    sendSuccess(res, latest ?? null);
  } catch (error) {
    next(error);
  }
}

/** POST — record what the balance is. Append-only; a correction is a new row. */
export async function recordSupplierFundingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const source = oneOf<SupplierFundingSource>(SUPPLIER_FUNDING_SOURCES, body['source'], 'source');
    await recordSupplierFundingObservation({
      supplierAccountId: String(body['supplierAccountId']),
      balanceMinor: Number(body['balanceMinor']),
      currency: oneOf<CurrencyCode>(ALL_CURRENCY_CODES, body['currency'], 'currency'),
      source,
      ...(body['observedAt'] === undefined
        ? {}
        : { observedAt: new Date(String(body['observedAt'])) }),
      // An operator-entered figure NAMES the operator; a provider reading does
      // not, because attributing an API's answer to a person makes the trail
      // say something false. The CHECK enforces the pairing.
      recordedByOxyUserId: source === 'operator_entry' ? procurementOperatorId(req) : null,
      ...(body['note'] === undefined ? {} : { note: String(body['note']) }),
    });
    sendSuccess(res, { recorded: true }, 201);
  } catch (error) {
    next(error);
  }
}

/** POST — pause entry by hand. Attributed, and it pauses ENTRY only. */
export async function raiseRetailPilotStopHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const result = await raiseRetailPilotStop({
      metric: oneOf<RetailPilotStopMetric>(RETAIL_PILOT_STOP_METRICS, body['metric'], 'metric'),
      scope: oneOf<RetailPilotStopScope>(RETAIL_PILOT_STOP_SCOPES, body['scope'], 'scope'),
      scopeRef: String(body['scopeRef'] ?? ''),
      raisedByOxyUserId: procurementOperatorId(req),
      detail: String(body['detail']),
    });
    sendSuccess(res, result, result.raised ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

/** POST — lift one stop. Attributable, dated and explained, or the CHECK refuses. */
export async function liftRetailPilotStopHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const lifted = await liftRetailPilotStop({
      stopId: requiredParam(req, 'stopId'),
      liftedByOxyUserId: procurementOperatorId(req),
      liftReason: String((req.body as Record<string, unknown>)['liftReason']),
    });
    if (!lifted) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    sendSuccess(res, { lifted: true });
  } catch (error) {
    next(error);
  }
}
