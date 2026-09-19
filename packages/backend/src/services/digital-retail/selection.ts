/**
 * The deterministic procurement selector (#1016 Workstream 6, ADR 0011 D9).
 *
 * ## "Cheapest wins" is not the policy, and the ordering says why
 *
 * Steps 1–6 are GATES and produce closed-set reasons; step 7 is the only place
 * cost appears, and it appears last. A cheapest-first selector would route every
 * order to whichever supplier is currently mispricing, which is also the supplier
 * most likely to reject, resell a grey key, or fail to replace one — and the
 * customer pays for that in a support case rather than in a price.
 *
 * ```text
 * 1. exact mapping and rights match     (a hard gate, from eligibility)
 * 2. authorized territory                (a hard gate)
 * 3. supplier, account and capability healthy and unpaused
 * 4. availability
 * 5. cost within the order's max_accepted_cost
 * 6. the fulfilment capability the line requires
 * 7. rank: provenance strength, reliability, latency, cost, id
 * ```
 *
 * Gates 1–6 are exactly `deriveDigitalProcurementEligibility`, which is why this
 * module does not re-implement them: one authority over "may this supplier be
 * used", and the selector's job is only to ORDER what survives it.
 *
 * ## The ranking is TOTAL, and the last key is the offer id
 *
 * A selector that can return either of two suppliers makes an incident
 * unreproducible: the same order, replayed, routes elsewhere, and the question
 * "why did this one get chosen" has no answer. So every comparison ends in the
 * offer id, which is unique.
 *
 * ## Nothing here is visible outside the private domain
 *
 * The catalogue's ranking inputs and this selector share no module, no table and
 * no type — which is the structural half of "supplier economics may never buy
 * organic ranking" (the epic's acceptance criterion 22).
 */

import {
  DIGITAL_SUPPLY_PROVENANCE_STRENGTH,
  type DigitalFulfilmentCapability,
  type DigitalProcurementEligibility,
  type DigitalSupplyProvenance,
} from '@mercaria/shared-types';
import {
  deriveDigitalProcurementEligibility,
  type DigitalEligibilityInput,
} from './eligibility.js';

/** One candidate as the selector judges it: the facts, plus its verdict. */
export interface RankedCandidate {
  readonly offerId: string;
  readonly supplierId: string;
  readonly supplierAccountId: string;
  readonly provenance: DigitalSupplyProvenance | null;
  readonly costAmount: number;
  readonly costCurrency: string;
  readonly capability: DigitalFulfilmentCapability;
  readonly expectedFulfilmentSeconds: number | null;
  /**
   * Historical fulfilment reliability, 0..1, or null when there is no history.
   *
   * NULL is NOT 1. A supplier nobody has bought from is not a perfect supplier,
   * and treating an absence as a maximum is how a new account wins every routing
   * decision on its first day. {@link RELIABILITY_WITHOUT_HISTORY} is what an
   * unmeasured supplier ranks as, and it sits below a measured good one.
   */
  readonly reliability: number | null;
  readonly eligibility: DigitalProcurementEligibility;
}

/**
 * What a supplier with NO fulfilment history ranks as.
 *
 * Deliberately not 1 and not 0: a new authorized distributor must be reachable
 * (or nothing could ever be its first order) and must not outrank a supplier with
 * a measured record.
 */
export const RELIABILITY_WITHOUT_HISTORY = 0.5;

/** The selector chose a supplier. */
export interface SelectionMade {
  readonly selected: true;
  readonly candidate: RankedCandidate;
  readonly rest: RankedCandidate[];
}

/** It chose none, and carries every candidate it looked at so a caller can say why. */
export interface SelectionRefused {
  readonly selected: false;
  readonly refusals: readonly RankedCandidate[];
}

/** What the selector decided, and — when it decided nothing — why. */
export type SelectionResult = SelectionMade | SelectionRefused;

/**
 * Narrow a selection to its refusal branch.
 *
 * A type GUARD rather than `if (!result.selected)`: this package compiles with
 * `strict` off, so narrowing a union by a boolean-literal discriminant does not
 * happen and every `result.refusals` after such a check is a TS2339. The guard
 * narrows either way — the same device `adapterFailed` uses one module over.
 */
export function selectionRefused(result: SelectionResult): result is SelectionRefused {
  return result.selected === false;
}

/**
 * Rank one candidate against another. Lower sorts FIRST.
 *
 * Every comparison is `a - b` on a value where SMALLER is better, so the ordering
 * reads in one direction throughout — provenance and reliability are negated at
 * the point they are read rather than by an inverted comparison somewhere below.
 */
function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  const strength = (candidate: RankedCandidate): number =>
    candidate.provenance ? -DIGITAL_SUPPLY_PROVENANCE_STRENGTH[candidate.provenance] : 0;
  const byProvenance = strength(a) - strength(b);
  if (byProvenance !== 0) return byProvenance;

  const reliability = (candidate: RankedCandidate): number =>
    -(candidate.reliability ?? RELIABILITY_WITHOUT_HISTORY);
  const byReliability = reliability(a) - reliability(b);
  if (byReliability !== 0) return byReliability;

  // An unknown latency sorts as the worst measured one rather than as zero: a
  // supplier that has never reported a fulfilment time is not instantaneous.
  const latency = (candidate: RankedCandidate): number =>
    candidate.expectedFulfilmentSeconds ?? Number.MAX_SAFE_INTEGER;
  const byLatency = latency(a) - latency(b);
  if (byLatency !== 0) return byLatency;

  const byCost = a.costAmount - b.costAmount;
  if (byCost !== 0) return byCost;

  // The total-order tiebreak. Without it the same order, replayed, can route
  // elsewhere — and an incident nobody can reproduce is one nobody can fix.
  return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
}

/**
 * Choose the supplier to procure from, or explain why there is none.
 *
 * `exclude` carries the offers already tried for this order line, so a fallback
 * cannot loop back onto the supplier that just failed. It is passed in rather
 * than derived here because the attempt history lives on `digital_purchase_orders`
 * and this function stays pure.
 */
export function selectProcurementCandidate(
  candidates: readonly RankedCandidate[],
  exclude: readonly string[] = [],
): SelectionResult {
  const excluded = new Set(exclude);
  const eligible = candidates.filter(
    (candidate) => candidate.eligibility.eligible && !excluded.has(candidate.offerId),
  );
  if (eligible.length === 0) {
    return { selected: false, refusals: candidates };
  }
  const ordered = [...eligible].sort(compareCandidates);
  const [best, ...rest] = ordered;
  // `eligible.length > 0` guarantees this, but the compiler does not know it and
  // a non-null assertion here would be the one place this file lies to `tsc`.
  if (!best) return { selected: false, refusals: candidates };
  return { selected: true, candidate: best, rest };
}

/** What `rankCandidate` needs beside the eligibility facts. */
export interface RankInput extends DigitalEligibilityInput {
  readonly offerId: string;
  readonly supplierId: string;
  readonly supplierAccountId: string;
  readonly provenance: DigitalSupplyProvenance | null;
  readonly reliability: number | null;
}

/** Derive one candidate's verdict and fold it into the shape the selector ranks. */
export function rankCandidate(input: RankInput): RankedCandidate {
  return {
    offerId: input.offerId,
    supplierId: input.supplierId,
    supplierAccountId: input.supplierAccountId,
    provenance: input.provenance,
    costAmount: input.offer.costAmount,
    costCurrency: input.offer.costCurrency,
    capability: input.offer.fulfilmentCapability,
    expectedFulfilmentSeconds: input.offer.expectedFulfilmentSeconds,
    reliability: input.reliability,
    eligibility: deriveDigitalProcurementEligibility(input),
  };
}
