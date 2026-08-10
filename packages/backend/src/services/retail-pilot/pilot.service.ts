/**
 * The bounded retail pilot, wired to its rows (#125).
 *
 * Everything decided here is decided by `admission.ts` and `thresholds.ts`,
 * which are pure; this module reads the state they need and writes the
 * consequences. That split is the one #121 uses for the same reason: a verdict
 * whose inputs are gathered in the same function that decides it is a verdict
 * nobody can drive over its boundary cases.
 *
 * ## The gate is called from CHECKOUT and from nowhere else
 *
 * That is the whole of #125's "crossing a threshold pauses the relevant cohort
 * and preserves existing-order operations". A live stop refuses new retail
 * checkouts; purchase orders already placed keep being submitted, polled,
 * cancelled, refunded and reconciled, because none of those paths asks. It is a
 * property of the call graph, not a rule in a handler — and
 * `retail-pilot-isolation.test.ts` fails the build if a procurement,
 * fulfilment, refund or reconciliation module starts calling it.
 */

import type {
  CurrencyCode,
  RetailPilotAdmission,
  RetailPilotAudience,
  RetailPilotStopMetric,
  RetailPilotStopOrigin,
  RetailPilotStopScope,
  SupplierFundingSource,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findActiveRetailPilotCohort,
  findLatestSupplierFunding,
  liftRetailPilotStopRow,
  listLiveRetailPilotStops,
  listRetailPilotSkus,
  listRetailPilotThresholds,
  raiseRetailPilotStopRow,
  recordSupplierFundingObservationRow,
} from '../../db/retailPilot/pilotRepository.js';
import {
  deriveRetailPilotAdmission,
  RETAIL_PILOT_COHORT_KEY,
  type RetailPilotRequest,
  type RetailPilotState,
} from './admission.js';
import {
  evaluateStopThresholds,
  type RetailPilotMeasurement,
  type RetailPilotThresholdOutcome,
} from './thresholds.js';

/**
 * Whether the pilot admits one retail line.
 *
 * Reads the active cohort, its allow-list, its live stops and the supplier's
 * freshest balance, then hands all four to the pure derivation. FOUR indexed
 * reads and no provider call — which is why #123's `planRetailCheckout` runs it
 * before it troubles a supplier.
 *
 * With no active cohort it answers `no_active_cohort` after ONE read, which is
 * the state every deployment that has published no bounds is in — and is why
 * this domain needs no kill switch of its own.
 */
export async function evaluateRetailPilotAdmission(
  request: RetailPilotRequest,
  options: { db?: DatabaseOrTransaction } = {},
): Promise<RetailPilotAdmission> {
  const cohort = await findActiveRetailPilotCohort(RETAIL_PILOT_COHORT_KEY, options.db);
  if (!cohort) {
    return await Promise.resolve(deriveRetailPilotAdmission(EMPTY_STATE, request));
  }

  const [skus, liveStops, funding] = await Promise.all([
    listRetailPilotSkus(cohort.id, options.db),
    listLiveRetailPilotStops(cohort.id, options.db),
    findLatestSupplierFunding(cohort.supplierAccountId, options.db),
  ]);

  const state: RetailPilotState = {
    bounds: {
      cohortId: cohort.id,
      version: cohort.version,
      supplierId: cohort.supplierId,
      supplierAccountId: cohort.supplierAccountId,
      marketCountry: cohort.marketCountry,
      currency: cohort.currency,
      audience: cohort.audience,
      audiencePercentageBps: cohort.audiencePercentageBps,
      maxItemTotalMinor: cohort.maxItemTotalAmount,
      maxOrderTotalMinor: cohort.maxOrderTotalAmount,
      minOrderTotalMinor: cohort.minOrderTotalAmount,
      maxLineQuantity: cohort.maxLineQuantity,
      permittedShippingServiceCodes: cohort.permittedShippingServiceCodes,
      fundingFloorMinor: cohort.fundingFloorAmount,
      fundingCurrency: cohort.fundingFloorCurrency,
      fundingObservationMaxAgeSeconds: cohort.fundingObservationMaxAgeSeconds,
    },
    allowlistedSkus: new Set(skus.map((entry) => entry.supplierSku)),
    liveStops,
    funding: funding
      ? {
          balanceMinor: funding.balanceMinor,
          currency: funding.currency,
          observedAt: funding.observedAt,
        }
      : null,
  };

  return deriveRetailPilotAdmission(state, request);
}

/** The state a deployment with no published cohort is in. */
const EMPTY_STATE: RetailPilotState = {
  bounds: null,
  allowlistedSkus: new Set<string>(),
  liveStops: [],
  funding: null,
};

/**
 * Evaluate the published thresholds against measurements and raise what breached.
 *
 * Returns EVERY outcome, `unmeasured` ones included, because "twelve thresholds,
 * nine measured" is a fact an operator has to see and "no breaches" hides it.
 * Raising is idempotent on the live-stop partial unique, so two evaluations of
 * one breach page once.
 *
 * It does NOT lift anything. A threshold that has fallen back under its bound
 * is not evidence that whatever caused it was fixed — the fix is a decision,
 * and lifting is an attributed operator act with a reason attached. That is the
 * `payment_discrepancies` posture: detection and repair are separate.
 */
export async function evaluateRetailPilotStopThresholds(
  input: { measurements: readonly RetailPilotMeasurement[]; at?: Date },
  options: { db?: DatabaseOrTransaction } = {},
): Promise<{ cohortVersion: number | null; outcomes: readonly RetailPilotThresholdOutcome[] }> {
  const cohort = await findActiveRetailPilotCohort(RETAIL_PILOT_COHORT_KEY, options.db);
  if (!cohort) return { cohortVersion: null, outcomes: [] };

  const thresholds = await listRetailPilotThresholds(cohort.id, options.db);
  const outcomes = evaluateStopThresholds(thresholds, input.measurements);

  for (const outcome of outcomes) {
    if (outcome.outcome !== 'breached') continue;
    const { raised } = await raiseRetailPilotStopRow(
      {
        cohortId: cohort.id,
        metric: outcome.metric,
        scope: outcome.scope,
        scopeRef: outcome.scopeRef,
        // NO raiser: attributing a threshold evaluation to a person makes the
        // audit trail say something false. The CHECK enforces the pairing.
        origin: 'automatic',
        observedValue: outcome.observedValue,
        thresholdValue: outcome.thresholdValue,
        raisedByOxyUserId: null,
        detail: `${outcome.metric} observed ${String(outcome.observedValue)} against a threshold of ${String(outcome.thresholdValue)}`,
        ...(input.at ? { at: input.at } : {}),
      },
      options.db,
    );
    if (raised) {
      log.general.warn(
        {
          metric: outcome.metric,
          scope: outcome.scope,
          observed: outcome.observedValue,
          threshold: outcome.thresholdValue,
          cohortVersion: cohort.version,
        },
        '[RetailPilot] stop threshold crossed; new retail checkouts are paused for this scope',
      );
    }
  }

  const unmeasured = outcomes.filter((entry) => entry.outcome === 'unmeasured');
  if (unmeasured.length > 0) {
    log.general.warn(
      { unmeasured: unmeasured.length, thresholds: thresholds.length },
      '[RetailPilot] some stop thresholds had no usable measurement',
    );
  }

  return { cohortVersion: cohort.version, outcomes };
}

/** Raise a stop by hand — an operator decision, attributed and explained. */
export async function raiseRetailPilotStop(
  input: {
    metric: RetailPilotStopMetric;
    scope: RetailPilotStopScope;
    scopeRef: string;
    raisedByOxyUserId: string;
    detail: string;
  },
  options: { db?: DatabaseOrTransaction } = {},
): Promise<{ raised: boolean }> {
  const cohort = await findActiveRetailPilotCohort(RETAIL_PILOT_COHORT_KEY, options.db);
  if (!cohort) return { raised: false };
  const origin: RetailPilotStopOrigin = 'operator';
  return await raiseRetailPilotStopRow(
    {
      cohortId: cohort.id,
      metric: input.metric,
      scope: input.scope,
      scopeRef: input.scopeRef,
      origin,
      // An operator stop is a judgement, not a measurement: there is no observed
      // value and no threshold it crossed. Both are zero rather than invented,
      // and `origin` is what tells a reader which kind of row this is.
      observedValue: 0,
      thresholdValue: 0,
      raisedByOxyUserId: input.raisedByOxyUserId,
      detail: input.detail,
    },
    options.db,
  );
}

/** Lift a stop. Attributable, dated and explained — all three or the CHECK refuses. */
export async function liftRetailPilotStop(
  input: { stopId: string; liftedByOxyUserId: string; liftReason: string },
  options: { db?: DatabaseOrTransaction } = {},
): Promise<boolean> {
  return await liftRetailPilotStopRow(input, options.db);
}

/**
 * Record what the supplier balance was, and page treasury before it runs out.
 *
 * The alert fires on the OBSERVATION rather than on a sweep, because the
 * observation is the only moment Mercaria learns anything about the balance —
 * Printful publishes no endpoint to poll (`docs/suppliers/printful.md` §14), so
 * a sweep would re-read a figure nobody had refreshed and alert about it
 * repeatedly.
 */
export async function recordSupplierFundingObservation(
  input: {
    supplierAccountId: string;
    balanceMinor: number;
    currency: CurrencyCode;
    source: SupplierFundingSource;
    observedAt?: Date;
    recordedByOxyUserId: string | null;
    note?: string;
  },
  options: { db?: DatabaseOrTransaction } = {},
): Promise<void> {
  await recordSupplierFundingObservationRow(
    {
      supplierAccountId: input.supplierAccountId,
      balanceMinor: input.balanceMinor,
      currency: input.currency,
      source: input.source,
      observedAt: input.observedAt ?? new Date(),
      recordedByOxyUserId: input.recordedByOxyUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    },
    options.db,
  );

  const cohort = await findActiveRetailPilotCohort(RETAIL_PILOT_COHORT_KEY, options.db);
  if (!cohort || cohort.supplierAccountId !== input.supplierAccountId) return;
  if (cohort.fundingFloorCurrency !== input.currency) return;
  if (input.balanceMinor > cohort.fundingAlertAmount) return;
  log.general.warn(
    {
      supplierAccountId: input.supplierAccountId,
      balanceMinor: input.balanceMinor,
      alertMinor: cohort.fundingAlertAmount,
      floorMinor: cohort.fundingFloorAmount,
      currency: input.currency,
    },
    input.balanceMinor < cohort.fundingFloorAmount
      ? '[RetailPilot] supplier funding is BELOW the floor; retail checkout is refusing'
      : '[RetailPilot] supplier funding is approaching the floor; a top-up is needed',
  );
}

/** Which audience a signed-in or guest buyer counts as, for the cohort gate. */
export function retailPilotAudienceFor(input: {
  isStaff: boolean;
  isInvited: boolean;
}): RetailPilotAudience {
  // `percentage` is deliberately NOT produced here. A percentage bucket needs a
  // stable unit key, and deciding it in the gate would make the pilot's cohort
  // a place a person is identified — #77's experiment rule. Until a rollout
  // bucketer exists, a cohort published as `percentage` admits staff and
  // invitees only, which is the narrow direction.
  if (input.isStaff) return 'staff';
  if (input.isInvited) return 'invited';
  return 'public';
}
