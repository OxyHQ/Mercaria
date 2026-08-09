/**
 * The supplier-preflight operator surface (#122 operations 1–8).
 *
 * Lives under `/internal/supplier-preflight/*` behind
 * `requireProcurementOperator` — a SIXTH allow-list, because reading Mercaria's
 * wholesale cost base and flipping a market kill switch are supply-operations
 * powers and not payments, catalogue, cart-diagnostic, analytics or compliance
 * ones.
 *
 * ## The surface is READ plus two write kinds, and no third
 *
 * Reads: metrics, one quote's trace, one checkout group's sourcing trail, one
 * account's health and quota. Writes: publishing a sourcing policy VERSION, and
 * raising or lifting a kill switch. There is deliberately no "set this quote
 * complete", no "extend this reservation" and no "override this answer" — a
 * quote is a record of what a supplier said, and an operator who could edit one
 * could authorize a sale the supplier never agreed to.
 *
 * The one action that is neither is `POST /sweep`, which runs a pass of the
 * loop that already runs on a timer. It adds no capability: every action in
 * that pass is an idempotent compare-and-swap a buyer or the timer would drive
 * anyway (the `/internal/payments` repair-surface reasoning, inverted — there
 * the repairs drive existing idempotent paths, here the trigger does).
 */

import type { NextFunction, Request, Response } from 'express';
import type {
  SupplierSuppressionKind,
  SupplierSuppressionScope,
} from '@mercaria/shared-types';
import { SUPPLIER_FORBIDDEN_SOURCING_SIGNAL_LABELS } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { procurementOperatorId } from '../middleware/procurement-operator-authz.js';
import { validationError } from '../lib/errors/error-codes.js';
import {
  findSupplierQuoteById,
  listSupplierQuoteShippingOptions,
  readSupplierQuoteMetrics,
} from '../db/supplierPreflight/quoteRepository.js';
import {
  findSupplierReservationByQuote,
  readSupplierReservationMetrics,
  readSupplierReservationProviderId,
} from '../db/supplierPreflight/reservationRepository.js';
import {
  activateSupplierSourcingPolicy,
  insertSupplierSourcingPolicy,
  listSupplierSourcingPolicies,
  retireSupplierSourcingPolicy,
} from '../db/supplierPreflight/sourcingPolicyRepository.js';
import { listSupplierSourcingAttemptsForCheckoutGroup } from '../db/supplierPreflight/sourcingAttemptRepository.js';
import {
  deriveSupplierHealthVerdict,
  findSupplierPreflightHealth,
  listSupplierPreflightHealth,
} from '../db/supplierPreflight/healthRepository.js';
import { readSupplierCallQuota } from '../db/supplierPreflight/callLeaseRepository.js';
import {
  liftSupplierPreflightSuppression,
  listSupplierPreflightSuppressions,
  raiseSupplierPreflightSuppression,
} from '../db/supplierPreflight/suppressionRepository.js';
import { findActiveSupplierSourcingPolicy } from '../db/supplierPreflight/sourcingPolicyRepository.js';
import { SUPPLIER_SOURCING_POLICY_KEY } from '../services/supplier-preflight/preflight.service.js';
import { runSupplierPreflightSweep } from '../services/supplier-preflight/preflight-sweep.js';
import { listRegisteredSupplierProviders } from '../services/supplier-preflight/registry.js';
import { projectSupplierQuoteTrace } from '../services/supplier-preflight/redact.js';

/** How far back the metrics surface looks when the caller names no window. */
const DEFAULT_METRICS_WINDOW_HOURS = 24;

/**
 * Refuse a body reaching for a signal selection may never read.
 *
 * Mounted BEFORE the `.strict()` schema, deliberately: `.strict()` answers an
 * unknown key with "unrecognized key", which reads as a typo rather than as an
 * attempt at something #122 selection 3 forbids. This answers WHY first, naming
 * the exact signal — the `refuseForbiddenResaleEvidenceBody` (#121)
 * arrangement, and a test pins the message so a remount after the schema fails
 * rather than regressing quietly to the enum's wording.
 */
export function refuseForbiddenSourcingSignalBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null) {
    next();
    return;
  }

  const normalized = new Map(
    Object.keys(body).map((key) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), key]),
  );
  for (const [signal, label] of Object.entries(SUPPLIER_FORBIDDEN_SOURCING_SIGNAL_LABELS)) {
    const compact = signal.replace(/_/g, '');
    for (const [candidate, original] of normalized) {
      if (!candidate.includes(compact)) continue;
      sendError(
        res,
        ErrorCodes.VALIDATION_ERROR,
        `\`${original}\` names ${label}. Supplier selection ranks only on whether a supplier ` +
          'can actually deliver this item to this address; it never reads a commission or a ' +
          'ranking signal.',
        400,
      );
      return;
    }
  }

  next();
}

/** GET — quote latency, failure, expiry and stock-discrepancy counters. */
export async function supplierPreflightMetricsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const db = getDb();
    const now = new Date();
    const since = new Date(now.getTime() - windowHours(req) * 3_600_000);
    const supplierAccountId = optionalQuery(req, 'supplierAccountId');

    const [quotes, reservations, policy, health] = await Promise.all([
      readSupplierQuoteMetrics({ since, supplierAccountId, now }, db),
      readSupplierReservationMetrics({ since, supplierAccountId, now }, db),
      findActiveSupplierSourcingPolicy({ policyKey: SUPPLIER_SOURCING_POLICY_KEY, at: now }, db),
      listSupplierPreflightHealth(db),
    ]);

    const thresholds = policy
      ? {
          windowMinutes: policy.healthWindowMinutes,
          minimumSamples: policy.healthMinimumSamples,
          maxFailureBps: policy.healthMaxFailureBps,
        }
      : null;

    sendSuccess(res, {
      windowHours: windowHours(req),
      registeredProviders: listRegisteredSupplierProviders(),
      activePolicy: policy
        ? { key: policy.policyKey, version: policy.version, id: policy.id }
        : null,
      quotes,
      reservations,
      accounts: health.map((row) => ({
        supplierAccountId: row.supplierAccountId,
        windowStart: row.windowStart.toISOString(),
        attempts: row.attempts,
        successes: row.successes,
        failures: row.failures,
        timeouts: row.timeouts,
        rateLimited: row.rateLimited,
        consecutiveFailures: row.consecutiveFailures,
        // A verdict needs a policy to be measured against; without one the
        // counters are reported and no opinion is offered, rather than a
        // default threshold being invented here.
        verdict: thresholds ? deriveSupplierHealthVerdict(row, thresholds, now) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/** GET — one supplier account's health verdict and live provider quota. */
export async function supplierAccountHealthHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const db = getDb();
    const now = new Date();
    const supplierAccountId = requiredParam(req, 'accountId');

    const [health, quota, policy] = await Promise.all([
      findSupplierPreflightHealth(supplierAccountId, db),
      readSupplierCallQuota({ supplierAccountId, now }, db),
      findActiveSupplierSourcingPolicy({ policyKey: SUPPLIER_SOURCING_POLICY_KEY, at: now }, db),
    ]);

    sendSuccess(res, {
      supplierAccountId,
      quota,
      window: health
        ? {
            windowStart: health.windowStart.toISOString(),
            attempts: health.attempts,
            successes: health.successes,
            failures: health.failures,
            timeouts: health.timeouts,
            rateLimited: health.rateLimited,
            consecutiveFailures: health.consecutiveFailures,
            lastSuccessAt: health.lastSuccessAt?.toISOString() ?? null,
            lastFailureAt: health.lastFailureAt?.toISOString() ?? null,
            lastFailureKind: health.lastFailureKind,
          }
        : null,
      verdict: policy
        ? deriveSupplierHealthVerdict(
            health,
            {
              windowMinutes: policy.healthWindowMinutes,
              minimumSamples: policy.healthMinimumSamples,
              maxFailureBps: policy.healthMaxFailureBps,
            },
            now,
          )
        : null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET — one quote, redacted.
 *
 * The projection is the allow-list (`projectSupplierQuoteTrace`), and the
 * provider reservation id reaches it as its last four characters only. The
 * shipping options are attached whole because every field on them is a price
 * and a service code the supplier published — there is nothing in an option row
 * that identifies a buyer.
 */
export async function supplierQuoteTraceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const db = getDb();
    const quoteId = requiredParam(req, 'quoteId');
    const quote = await findSupplierQuoteById(quoteId, db);
    if (!quote) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    const [reservation, options] = await Promise.all([
      findSupplierReservationByQuote(quote.id, db),
      listSupplierQuoteShippingOptions(quote.id, db),
    ]);
    const providerReservationId = reservation
      ? ((await readSupplierReservationProviderId(reservation.id, db)) ?? null)
      : null;

    sendSuccess(res, {
      quote: projectSupplierQuoteTrace(quote, reservation, providerReservationId),
      shippingOptions: options.map((option) => ({
        serviceCode: option.serviceCode,
        carrier: option.carrier,
        serviceName: option.serviceName,
        cost: { amount: option.costAmount, currency: option.costCurrency },
        basis: option.basis,
        deliveryDaysMin: option.deliveryDaysMin,
        deliveryDaysMax: option.deliveryDaysMax,
        guaranteed: option.guaranteed,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET — one checkout group's whole sourcing trail.
 *
 * Opens from a checkout GROUP and nothing else. There is deliberately no lookup
 * by buyer, email or session: "show me everything this person bought from which
 * supplier" is not a question this surface can be asked, which is the
 * `/internal/analytics` trace rule applied to the supply side.
 */
export async function supplierSourcingTraceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const checkoutGroupId = requiredParam(req, 'checkoutGroupId');
    const attempts = await listSupplierSourcingAttemptsForCheckoutGroup(checkoutGroupId, getDb());
    sendSuccess(res, {
      checkoutGroupId,
      attempts: attempts.map((attempt) => ({
        sequence: attempt.sequence,
        supplierId: attempt.supplierId,
        supplierAccountId: attempt.supplierAccountId,
        procurementOfferId: attempt.procurementOfferId,
        sourcingPolicyKey: attempt.sourcingPolicyKey,
        sourcingPolicyVersion: attempt.sourcingPolicyVersion,
        rank: attempt.rank,
        outcome: attempt.outcome,
        reason: attempt.reason,
        quoteId: attempt.quoteId,
        at: attempt.at.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
}

/** GET — every sourcing policy version. */
export async function listSupplierSourcingPoliciesHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, { policies: await listSupplierSourcingPolicies(getDb()) });
  } catch (err) {
    next(err);
  }
}

/** POST — draft a sourcing policy version. Inert until activated. */
export async function createSupplierSourcingPolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as {
      version: number;
      name: string;
      summary: string;
      effectiveStart: string;
      effectiveEnd?: string | null;
      rankingCriteria: string[];
      requiredCapabilities: string[];
      maxSourcingAttempts: number;
      maxSupplierShareBps: number;
      quoteTtlSeconds: number;
      providerTimeoutMs: number;
      maxProviderConcurrency: number;
      maxProviderCallsPerMinute: number;
      healthWindowMinutes: number;
      healthMinimumSamples: number;
      healthMaxFailureBps: number;
      healthSuppressionMinutes: number;
    };

    const policy = await insertSupplierSourcingPolicy(
      {
        policyKey: SUPPLIER_SOURCING_POLICY_KEY,
        version: body.version,
        name: body.name,
        summary: body.summary,
        effectiveStart: new Date(body.effectiveStart),
        effectiveEnd: body.effectiveEnd ? new Date(body.effectiveEnd) : null,
        rankingCriteria: body.rankingCriteria as Parameters<
          typeof insertSupplierSourcingPolicy
        >[0]['rankingCriteria'],
        requiredCapabilities: body.requiredCapabilities as Parameters<
          typeof insertSupplierSourcingPolicy
        >[0]['requiredCapabilities'],
        maxSourcingAttempts: body.maxSourcingAttempts,
        maxSupplierShareBps: body.maxSupplierShareBps,
        quoteTtlSeconds: body.quoteTtlSeconds,
        providerTimeoutMs: body.providerTimeoutMs,
        maxProviderConcurrency: body.maxProviderConcurrency,
        maxProviderCallsPerMinute: body.maxProviderCallsPerMinute,
        healthWindowMinutes: body.healthWindowMinutes,
        healthMinimumSamples: body.healthMinimumSamples,
        healthMaxFailureBps: body.healthMaxFailureBps,
        healthSuppressionMinutes: body.healthSuppressionMinutes,
        createdByOxyUserId: procurementOperatorId(req),
      },
      getDb(),
    );
    sendSuccess(res, { policy }, 201);
  } catch (err) {
    next(err);
  }
}

/** POST — publish a draft, superseding the incumbent in one transaction. */
export async function activateSupplierSourcingPolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const policy = await activateSupplierSourcingPolicy(
      { policyId: requiredParam(req, 'id'), approvedByOxyUserId: procurementOperatorId(req) },
      getDb(),
    );
    sendSuccess(res, { policy });
  } catch (err) {
    next(err);
  }
}

/** POST — withdraw a version without a replacement. */
export async function retireSupplierSourcingPolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const policy = await retireSupplierSourcingPolicy(
      { policyId: requiredParam(req, 'id') },
      getDb(),
    );
    if (!policy) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    sendSuccess(res, { policy });
  } catch (err) {
    next(err);
  }
}

/** GET — every suppression, live by default. */
export async function listSupplierSuppressionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const suppressions = await listSupplierPreflightSuppressions(
      { includeLifted: optionalQuery(req, 'includeLifted') === 'true', limit: 200 },
      getDb(),
    );
    sendSuccess(res, { suppressions });
  } catch (err) {
    next(err);
  }
}

/**
 * POST — THE kill switch (#122 operations 4).
 *
 * Always an `operator` origin, never `automatic_health`: the body has no
 * `origin` field, so a person cannot file a stop that reads as the system's and
 * lapses on its own. The scope-shape CHECK on the table is what refuses a
 * `market` stop that names an account, so this handler passes the columns
 * through rather than re-deriving which ones apply.
 */
export async function raiseSupplierSuppressionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as {
      scope: SupplierSuppressionScope;
      supplierId?: string | null;
      supplierAccountId?: string | null;
      marketCountry?: string | null;
      kind: SupplierSuppressionKind;
      reason: string;
      expiresAt?: string | null;
    };

    const suppression = await raiseSupplierPreflightSuppression(
      {
        scope: body.scope,
        supplierId: body.supplierId ?? null,
        supplierAccountId: body.supplierAccountId ?? null,
        marketCountry: body.marketCountry?.toUpperCase() ?? null,
        kind: body.kind,
        origin: 'operator',
        reason: body.reason,
        sourcingPolicyId: null,
        raisedByOxyUserId: procurementOperatorId(req),
        effectiveFrom: new Date(),
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
      getDb(),
    );
    sendSuccess(res, { suppression }, 201);
  } catch (err) {
    next(err);
  }
}

/** POST — put a route back into service. The row survives; the lift is audited. */
export async function liftSupplierSuppressionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const suppression = await liftSupplierPreflightSuppression(
      {
        suppressionId: requiredParam(req, 'id'),
        liftedByOxyUserId: procurementOperatorId(req),
        liftReason: body.reason,
      },
      getDb(),
    );
    if (!suppression) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    sendSuccess(res, { suppression });
  } catch (err) {
    next(err);
  }
}

/** POST — run one sweep pass now. Adds no capability the timer does not have. */
export async function runSupplierPreflightSweepHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await runSupplierPreflightSweep());
  } catch (err) {
    next(err);
  }
}

/** A required path parameter, or a 400 that names it. */
function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`\`${name}\` is required.`);
  }
  return value;
}

/** An optional query parameter, ignoring the array form Express can produce. */
function optionalQuery(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The metrics window, bounded so one request cannot scan the whole table. */
function windowHours(req: Request): number {
  const raw = optionalQuery(req, 'windowHours');
  if (raw === undefined) return DEFAULT_METRICS_WINDOW_HOURS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 24 * 30) {
    throw validationError('windowHours must be an integer between 1 and 720.');
  }
  return parsed;
}
