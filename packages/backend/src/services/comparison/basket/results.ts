/**
 * The eight named alternatives (#96 §"Result types").
 *
 * PURE. Each kind is produced from a plan the solver already found, or REFUSED
 * with reason codes — and the refusals are the interesting half, because the
 * conditions that produce them are the ones the issue's acceptance criteria are
 * about.
 *
 * ## `cheapest_known_total` is the hardest one to earn, deliberately
 *
 * It is produced only when THREE things hold at once:
 *
 *  1. Every requested line is covered.
 *  2. Every merchant's delivery cost is known — which, per `plan.ts`, means
 *     each merchant either serves one line or quotes one consistent shipping
 *     policy across the lines it serves.
 *  3. The plan's combined tax inclusion is `inclusive`.
 *
 * The third is the one worth stating plainly: **today no offer in Mercaria
 * carries a tax-inclusion fact.** #74's `resolveOfferTaxInclusion` is a named
 * seam that always answers `unknown`, because `offers` has no tax column and no
 * adapter publishes one, and guessing from the market is how a 21% error enters
 * a total. So in production this result is currently REFUSED with
 * `tax_inclusion_unknown`, every time, and `cheapest_known_item_prices` is what
 * a shopper actually gets — under a name that says exactly what it compared.
 *
 * That is not a gap to be worked around. Acceptance 4 says an unknown cost must
 * prevent a "cheapest known total" claim, and a tax treatment nobody recorded
 * is an unknown cost. The seam closes when an offer-side tax column lands, and
 * the solver, the totals and this file need no change when it does.
 *
 * ## `best_nearby_pickup` is in the vocabulary and is never produced
 *
 * Still never produced — but #93 SHIPPED, so the reason changed and the old
 * sentence ("#93 publishes no collection points") is now false. Collection
 * points are published and `resolvePickupProximity` answers real distances; what
 * a basket comparison does not have is a VIEWER POSITION. `BasketRequest`
 * carries no coordinate and deliberately should not: an origin belongs to a
 * request a shopper knowingly made from where they are standing, and a basket
 * plan is composed from a saved list. So every item resolves
 * `viewer_location_absent` and the result is refused with
 * `pickup_data_unavailable`, exactly as before.
 *
 * Keeping it in the tuple is what makes the seam visible: a result kind that is
 * simply missing is a feature nobody notices is absent.
 */

import {
  hasKnownPlanTotal,
  type BasketObjective,
  type BasketOptimality,
  type BasketPlan,
  type BasketReasonCode,
  type BasketRequest,
  type BasketResult,
  type BasketResultKind,
} from '@mercaria/shared-types';
import { renderMoney } from '../render.js';

/** One solved objective, as the composer receives it. */
export interface SolvedObjective {
  readonly objective: BasketObjective;
  readonly plan: BasketPlan;
  readonly optimality: BasketOptimality;
}

export interface ComposeResultsInput {
  readonly request: BasketRequest;
  readonly solved: readonly SolvedObjective[];
  /** How many lines the request asked for. */
  readonly requestedLineCount: number;
}

/**
 * Name every result the solved plans support, and refuse the rest by name.
 *
 * The output order is {@link BASKET_RESULT_KINDS}' own, so a client renders the
 * same list every time and a refusal keeps its place beside the results it sits
 * between — a surface that only rendered what succeeded would make an absent
 * pickup plan indistinguishable from a pickup plan nobody asked for.
 */
export function composeBasketResults(input: ComposeResultsInput): readonly BasketResult[] {
  const byObjective = new Map(input.solved.map((entry) => [entry.objective, entry]));
  const results: BasketResult[] = [];

  results.push(cheapestItemPrices(byObjective, input));
  results.push(cheapestKnownTotal(byObjective, input));
  results.push(fewestMerchants(byObjective, input));
  results.push(bestNativePlan(byObjective, input));
  results.push(officialChannelPlan(byObjective, input));
  results.push(bestNearbyPickup());
  results.push(usedOrRefurbishedValue(byObjective, input));

  const partial = partialCoverage(byObjective, input);
  if (partial !== undefined) results.push(partial);

  return results;
}

/** Whether a plan covers every line the request asked for. */
function isComplete(plan: BasketPlan, requestedLineCount: number): boolean {
  return plan.coveredLineIds.length === requestedLineCount && plan.unresolved.length === 0;
}

/** The item-price optimum, produced whenever anything at all was covered. */
function cheapestItemPrices(
  byObjective: ReadonlyMap<BasketObjective, SolvedObjective>,
  input: ComposeResultsInput,
): BasketResult {
  const solved = byObjective.get('cheapest_known_item_prices');
  const kind: BasketResultKind = 'cheapest_known_item_prices';
  if (solved === undefined || solved.plan.coveredLineIds.length === 0) {
    return { kind, state: 'refused', reasons: ['no_eligible_offer'] };
  }
  const reasons: BasketReasonCode[] = [];
  if (!isComplete(solved.plan, input.requestedLineCount)) reasons.push('no_eligible_offer');
  if (!hasKnownPlanTotal(solved.plan.deliveredTotal)) {
    for (const missing of solved.plan.deliveredTotal.missing) {
      if (missing === 'delivery_cost') reasons.push('delivery_cost_unknown');
      if (missing === 'tax_inclusion') reasons.push('tax_inclusion_unknown');
    }
  }
  return {
    kind,
    state: 'produced',
    objective: 'cheapest_known_item_prices',
    optimality: solved.optimality,
    plan: solved.plan,
    reasons,
  };
}

/** The delivered optimum, or the named reason there is no such thing today. */
function cheapestKnownTotal(
  byObjective: ReadonlyMap<BasketObjective, SolvedObjective>,
  input: ComposeResultsInput,
): BasketResult {
  const kind: BasketResultKind = 'cheapest_known_total';
  const solved = byObjective.get('cheapest_known_total');
  if (solved === undefined) {
    return { kind, state: 'refused', reasons: ['objective_requires_complete_costs'] };
  }
  if (!isComplete(solved.plan, input.requestedLineCount)) {
    return { kind, state: 'refused', reasons: ['objective_requires_complete_costs'] };
  }
  // The narrowing IS the guarantee: an incomplete total has no `amount` to
  // build a claim from, so acceptance 4 is held by the type rather than by this
  // branch. The branch exists to name WHICH component is missing.
  if (!hasKnownPlanTotal(solved.plan.deliveredTotal)) {
    const reasons: BasketReasonCode[] = [];
    for (const missing of solved.plan.deliveredTotal.missing) {
      if (missing === 'delivery_cost') reasons.push('delivery_cost_unknown');
      else if (missing === 'tax_inclusion') reasons.push('tax_inclusion_unknown');
      else reasons.push('no_convertible_price');
    }
    return { kind, state: 'refused', reasons };
  }
  return {
    kind,
    state: 'produced',
    objective: 'cheapest_known_total',
    optimality: solved.optimality,
    plan: solved.plan,
    reasons: [],
  };
}

/** The consolidation optimum. */
function fewestMerchants(
  byObjective: ReadonlyMap<BasketObjective, SolvedObjective>,
  input: ComposeResultsInput,
): BasketResult {
  const kind: BasketResultKind = 'fewest_merchants';
  const solved = byObjective.get('fewest_merchants');
  if (solved === undefined || solved.plan.coveredLineIds.length === 0) {
    return { kind, state: 'refused', reasons: ['no_eligible_offer'] };
  }
  const reasons: BasketReasonCode[] = [];
  if (!isComplete(solved.plan, input.requestedLineCount)) reasons.push('no_eligible_offer');
  return {
    kind,
    state: 'produced',
    objective: 'fewest_merchants',
    optimality: solved.optimality,
    plan: solved.plan,
    reasons,
  };
}

/**
 * The all-Mercaria plan.
 *
 * Refused unless EVERY covered line is native: "best native plan" naming a plan
 * with two external lines is the sentence a shopper would act on wrongly, and
 * the mixed plan is already available under its own name.
 */
function bestNativePlan(
  byObjective: ReadonlyMap<BasketObjective, SolvedObjective>,
  input: ComposeResultsInput,
): BasketResult {
  const kind: BasketResultKind = 'best_native_plan';
  const solved = byObjective.get('all_native');
  if (solved === undefined || solved.plan.coveredLineIds.length === 0) {
    return { kind, state: 'refused', reasons: ['objective_requires_native_offer'] };
  }
  if (solved.plan.lines.some((line) => line.channel !== 'native_checkout')) {
    return { kind, state: 'refused', reasons: ['objective_requires_native_offer'] };
  }
  const reasons: BasketReasonCode[] = [];
  if (!isComplete(solved.plan, input.requestedLineCount)) {
    reasons.push('objective_requires_native_offer');
  }
  return {
    kind,
    state: 'produced',
    objective: 'all_native',
    optimality: solved.optimality,
    plan: solved.plan,
    reasons,
  };
}

/**
 * The official-channel plan.
 *
 * Derived from the cheapest plan rather than searched for separately, and
 * produced only when every covered line carries a VERIFIED official-channel
 * standing (#55). An `authorized_reseller` is deliberately not enough: #55
 * keeps the two kinds, badges and lists apart, and folding them here would
 * publish a distinction the relationship layer refuses to make.
 */
function officialChannelPlan(
  byObjective: ReadonlyMap<BasketObjective, SolvedObjective>,
  input: ComposeResultsInput,
): BasketResult {
  const kind: BasketResultKind = 'official_channel_plan';
  const solved = byObjective.get('cheapest_known_item_prices');
  if (solved === undefined || solved.plan.coveredLineIds.length === 0) {
    return { kind, state: 'refused', reasons: ['objective_requires_official_channel'] };
  }
  if (solved.plan.lines.some((line) => line.relationship !== 'official_channel')) {
    return { kind, state: 'refused', reasons: ['objective_requires_official_channel'] };
  }
  const reasons: BasketReasonCode[] = [];
  if (!isComplete(solved.plan, input.requestedLineCount)) {
    reasons.push('objective_requires_official_channel');
  }
  return {
    kind,
    state: 'produced',
    objective: 'cheapest_known_item_prices',
    optimality: solved.optimality,
    plan: solved.plan,
    reasons,
  };
}

/**
 * Never produced. See the module header.
 *
 * Refused whether or not the shopper ASKED for pickup, and that is deliberate:
 * a result that appeared only when requested would make "we cannot do this"
 * indistinguishable from "you did not ask", and the first is the fact a surface
 * has to be able to render.
 */
function bestNearbyPickup(): BasketResult {
  return {
    kind: 'best_nearby_pickup',
    state: 'refused',
    reasons: ['pickup_data_unavailable'],
  };
}

/**
 * The second-hand value plan.
 *
 * Produced when every covered line is a USED or REFURBISHED offer.
 * `open_box` and `for_parts` are excluded: #74's `isUsedConditionGroup` states
 * why for the first two, and a for-parts item is not a working product a value
 * plan may quietly include.
 */
function usedOrRefurbishedValue(
  byObjective: ReadonlyMap<BasketObjective, SolvedObjective>,
  input: ComposeResultsInput,
): BasketResult {
  const kind: BasketResultKind = 'used_or_refurbished_value';
  const solved = byObjective.get('cheapest_known_item_prices');
  if (solved === undefined || solved.plan.coveredLineIds.length === 0) {
    return { kind, state: 'refused', reasons: ['objective_requires_used_offer'] };
  }
  const allSecondHand = solved.plan.lines.every(
    (line) => line.conditionGroup === 'used' || line.conditionGroup === 'refurbished',
  );
  if (!allSecondHand) {
    return { kind, state: 'refused', reasons: ['objective_requires_used_offer'] };
  }
  const reasons: BasketReasonCode[] = [];
  if (!isComplete(solved.plan, input.requestedLineCount)) {
    reasons.push('objective_requires_used_offer');
  }
  return {
    kind,
    state: 'produced',
    objective: 'cheapest_known_item_prices',
    optimality: solved.optimality,
    plan: solved.plan,
    reasons,
  };
}

/**
 * The honest partial answer (solver design rule 10).
 *
 * Emitted only when the best plan leaves something out, and it carries the SAME
 * plan the cheapest result carries — the difference is the NAME, which is the
 * whole point: "cheapest known item prices" over four of five lines and
 * "partial plan with unresolved items" are the same rows read two ways, and a
 * shopper needs the second reading before they act on the first.
 */
function partialCoverage(
  byObjective: ReadonlyMap<BasketObjective, SolvedObjective>,
  input: ComposeResultsInput,
): BasketResult | undefined {
  const solved = byObjective.get('cheapest_known_item_prices');
  if (solved === undefined) {
    return {
      kind: 'partial_coverage',
      state: 'produced',
      objective: 'cheapest_known_item_prices',
      optimality: { status: 'proven_optimal' },
      plan: emptyPlanFor(input),
      reasons: ['no_eligible_offer'],
    };
  }
  if (isComplete(solved.plan, input.requestedLineCount)) return undefined;

  const reasons: BasketReasonCode[] = [];
  for (const line of solved.plan.unresolved) {
    for (const reason of line.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return {
    kind: 'partial_coverage',
    state: 'produced',
    objective: 'cheapest_known_item_prices',
    optimality: solved.optimality,
    plan: solved.plan,
    reasons,
  };
}

/**
 * The plan for a request nothing could serve.
 *
 * Every line unresolved, no merchants and a zero-length line list — never a
 * `known` total of zero, which a client would render as "free".
 */
function emptyPlanFor(input: ComposeResultsInput): BasketPlan {
  const zero = { amount: 0, currency: input.request.comparisonCurrency };
  return {
    planDigest: '',
    lines: [],
    merchants: [],
    merchantCount: 0,
    coveredLineIds: [],
    unresolved: input.request.lines.map((line) => ({
      lineId: line.lineId,
      canonicalProductId: line.canonicalProductId,
      reasons: ['no_eligible_offer'] as readonly BasketReasonCode[],
    })),
    itemSubtotal: {
      state: 'unknown',
      missing: ['item_price'],
      knownFloor: zero,
      renderedFloor: renderMoney(zero),
    },
    deliveredTotal: {
      state: 'unknown',
      missing: ['item_price', 'delivery_cost'],
      knownFloor: zero,
      renderedFloor: renderMoney(zero),
    },
    currency: input.request.comparisonCurrency,
    freshness: 'unknown',
    taxInclusion: 'unknown',
  };
}
