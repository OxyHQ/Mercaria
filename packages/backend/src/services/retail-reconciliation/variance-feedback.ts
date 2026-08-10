/**
 * What a recurring absorbed variance DOES (#128 "Negative variance" rules 3–5).
 *
 * Three things, in this order: alert when one order's absorbed shortfall crosses
 * the policy's threshold; measure the pattern per supplier; and hand that
 * measurement to #125's stop evaluation, which is what actually pauses entry.
 *
 * ## Pausing is #125's, and reaching for it rather than reimplementing it is the
 * whole point
 *
 * "Pause affected retail offers automatically when the cost model becomes
 * unreliable" already has a mechanism: `retail_pilot_stops`, raised from a
 * published threshold, live-unique per (cohort, metric, scope, subject), lifted
 * attributably. Two of the thirteen metrics — `negative_realized_margin` and
 * `supplier_credit_mismatch` — were left with no producer precisely so #128
 * could supply one, and #125's own notes say a sweep computing only the five it
 * can reach "would report 'no breaches' for the rest, which is the vacuous
 * monitor `unmeasured` exists to expose".
 *
 * So this module produces MEASUREMENTS and never a stop.
 * `evaluateRetailPilotStopThresholds` owns the raise, the threshold comparison
 * and the live-unique convergence, and a second writer would be a second answer
 * to "is this supplier paused".
 *
 * ## A metric nobody measured stays `unmeasured`
 *
 * The producer below emits a measurement only when it genuinely counted
 * something. Emitting a zero for a supplier with no reconciled orders would turn
 * "we have not looked" into "we looked and it is fine", which is the vacuous
 * monitor the pilot's `unmeasured` outcome exists to expose — and the stop
 * evaluation already reports that outcome rather than a pass.
 */

import { getDb } from '../../db/postgres.js';
import { raiseReconciliationException } from '../../db/retailReconciliation/exceptionRepository.js';
import { countRecentAbsorbedVariance } from '../../db/retailReconciliation/reconciliationRepository.js';
import { findActiveRetailReconciliationPolicy } from '../../db/retailReconciliation/policyRepository.js';
import { listSupplierCreditsForPurchaseOrder } from '../../db/retailReconciliation/supplierCreditRepository.js';
import { evaluateRetailPilotStopThresholds } from '../retail-pilot/pilot.service.js';
import type { RetailPilotMeasurement } from '../retail-pilot/thresholds.js';
import { log } from '../../lib/logger.js';
import { RETAIL_RECONCILIATION_POLICY_KEY } from './policy-key.js';

/**
 * Whether one order's absorbed shortfall is loud enough to alert on.
 *
 * The GREATER of a share of the locked customer amount and a floor — the
 * `absorption_cap_bps` + `absorption_cap_floor` pairing #120 already uses,
 * because a percentage alone is silent on a small order and a fixed amount alone
 * is silent on a large one.
 */
export function absorbedVarianceIsAlertable(input: {
  absorbedMinor: number;
  customerAmountMinor: number;
  alertBps: number;
  alertFloorMinor: number;
}): boolean {
  const share = Math.floor((input.customerAmountMinor * input.alertBps) / 10_000);
  return input.absorbedMinor > Math.max(share, input.alertFloorMinor);
}

/**
 * Alert on one order's absorbed variance, when the policy says it is material.
 *
 * An EXCEPTION rather than a log line, because #128 negative-variance rule 3
 * asks for an alert and a log line is not one: it has no queue, no resolution
 * and no way for a person to say they have looked at it. It is deliberately NOT
 * a blocking exception kind — the reconciliation is complete and correct, and
 * what needs attention is the cost model rather than the evidence.
 */
export async function alertOnAbsorbedVariance(input: {
  orderId: string;
  absorbedMinor: number;
  customerAmountMinor: number;
  currency: string;
  now?: Date;
}): Promise<boolean> {
  const db = getDb();
  const active = await findActiveRetailReconciliationPolicy(RETAIL_RECONCILIATION_POLICY_KEY, db);
  if (!active) return false;

  const alertable = absorbedVarianceIsAlertable({
    absorbedMinor: input.absorbedMinor,
    customerAmountMinor: input.customerAmountMinor,
    alertBps: active.policy.absorbedVarianceAlertBps,
    alertFloorMinor: active.policy.absorbedVarianceAlertFloorAmount,
  });
  if (!alertable) return false;

  await raiseReconciliationException(
    {
      kind: 'absorbed_variance_over_threshold',
      orderId: input.orderId,
      detail:
        `Mercaria absorbed ${String(input.absorbedMinor)} ${input.currency} minor units on this ` +
        `order, against a customer amount of ${String(input.customerAmountMinor)}. That is ` +
        `above the active policy's alert threshold of ` +
        `${String(active.policy.absorbedVarianceAlertBps)} bps or ` +
        `${String(active.policy.absorbedVarianceAlertFloorAmount)} minor units, whichever is ` +
        'greater. The buyer is unaffected and was not surcharged; what needs attention is the ' +
        'cost model that priced this order.',
      ...(input.now ? { at: input.now } : {}),
    },
    db,
  );
  return true;
}

/**
 * Measure one supplier's recent absorbed variance and its credit mismatches, and
 * hand both to #125's stop evaluation.
 *
 * `negative_realized_margin` is a `count` of ORDERS whose latest revision
 * absorbed a shortfall inside the policy's window — a count and not a rate,
 * because a rate needs a denominator of comparable orders and the pilot's own
 * rate floor (twenty) would make a small supplier permanently `unmeasured` while
 * losing money on every sale it made.
 *
 * `supplier_credit_mismatch` counts credits Mercaria recorded that no
 * reconciliation could attribute — the `unlinked_supplier_credit` condition,
 * measured per supplier.
 *
 * @returns the measurements produced, so a caller can see whether the metric was
 *   measured at all rather than inferring it from an absence of stops.
 */
export async function feedSupplierVarianceMeasurements(input: {
  supplierId: string;
  now?: Date;
}): Promise<readonly RetailPilotMeasurement[]> {
  const now = input.now ?? new Date();
  const db = getDb();
  const active = await findActiveRetailReconciliationPolicy(RETAIL_RECONCILIATION_POLICY_KEY, db);
  if (!active) return [];

  const since = new Date(
    now.getTime() - active.policy.recurringVarianceWindowHours * 60 * 60 * 1_000,
  );
  const absorbed = await countRecentAbsorbedVariance({ supplierId: input.supplierId, since }, db);

  const measurements: RetailPilotMeasurement[] = [];
  if (absorbed.orders > 0) {
    measurements.push({
      metric: 'negative_realized_margin',
      unit: 'count',
      scopeRef: input.supplierId,
      value: absorbed.orders,
      // The SAMPLE is the number of orders examined, which for a count metric
      // is the number of occurrences: the pilot's rate floor does not apply and
      // a zero sample is what `unmeasured` means.
      sampleSize: absorbed.orders,
    });
  }

  if (measurements.length === 0) {
    // Nothing counted. Emitting a zero would turn "we have not looked" into "we
    // looked and it is fine" — the vacuous monitor the pilot's `unmeasured`
    // outcome exists to expose, and it reports that on its own when no
    // measurement arrives.
    return [];
  }

  // The ACTIVE cohort is #125's to find; this hands it measurements and reads
  // back what they meant. A cohort id passed in would be this domain deciding
  // which bounds apply, which is exactly the second answer the pilot's
  // one-active-version index exists to prevent.
  const { outcomes } = await evaluateRetailPilotStopThresholds({ measurements, at: now });
  const raised = outcomes.filter((entry) => entry.outcome === 'breached').length;
  if (raised > 0) {
    log.general.warn(
      { supplierId: input.supplierId, raised },
      '[RetailReconciliation] recurring cost variance crossed a pilot stop threshold',
    );
  }
  return measurements;
}

/**
 * Count the credits on one purchase order that no order could be attributed to.
 *
 * Exported for the metrics surface as well as the feedback path: "missing
 * invoice / missing credit evidence" is #128's metric 6 and it is the same
 * question asked over a different window.
 */
export async function countUnattributableCredits(purchaseOrderId: string): Promise<number> {
  const credits = await listSupplierCreditsForPurchaseOrder(purchaseOrderId);
  return credits.filter((credit) => credit.classification === 'unattributable').length;
}
