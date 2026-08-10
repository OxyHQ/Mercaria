/**
 * The basket solver (#96 §"Solver design").
 *
 * PURE, deterministic, and no language model anywhere near the arithmetic
 * (solver design rule 2).
 *
 * ## The problem, stated
 *
 * Given lines `L`, each wanting a quantity of one product, and candidate offers
 * `C` each belonging to a merchant `m(c)`, choose exactly one candidate per
 * covered line so as to minimise
 *
 *     Σ_{l ∈ covered} price(c_l) · qty(l)  +  Σ_{m ∈ used} delivery(m, lines_m)
 *
 * subject to `|used| ≤ maxMerchants`, the channel policy, the excluded
 * merchants, and each line's own condition and merchant requirements.
 *
 * This is **uncapacitated facility location with per-facility setup costs** —
 * NP-hard, and NOT solvable by picking each line's cheapest offer, because the
 * delivery term couples the lines: three cheapest offers from three merchants
 * can cost more delivered than three slightly dearer ones from one. The
 * coupling is exactly what makes the naive per-item minimum wrong and exactly
 * what a shopper feels at three checkouts.
 *
 * ## Complexity boundaries, and what happens at each one
 *
 * The exact algorithm enumerates merchant SUBSETS: for a fixed set `S` the
 * problem decouples (each line independently takes its best candidate within
 * `S`), so the optimum over all `S` is the global optimum. That is
 * `O(2^M · L · C̄)`.
 *
 * ## The decoupling rests on ONE premise, and the premise is not a theorem
 *
 * Per-line independence is only valid while a line's choice cannot change
 * another line's cost. `plan.ts` breaks that in one place: a merchant serving
 * several lines has an UNKNOWN delivery unless every assigned offer agrees on
 * cost and threshold, so a per-line-best pick can create a disagreement where
 * an alternative would have aligned with a sibling and produced a strictly
 * cheaper KNOWN total. `exactSearch` explores one assignment per subset, so it
 * would miss that plan while still reporting `proven_optimal`.
 *
 * **It cannot happen today, and the reason is external to this module.** #74's
 * `resolveOfferTaxInclusion` answers `unknown` unconditionally, so
 * `combineTaxInclusion` over any real plan is `unknown`, so `deliveredTotal` is
 * never `known`, so `betterPlan`'s `cheapest_known_total` branch compares
 * `Infinity` against `Infinity` and falls through to the item subtotal — which
 * IS separable per line. The premise holds because the delivered-total
 * comparator is unreachable, not because the coupling was solved.
 *
 * `solver.test.ts` §"the exact search's decoupling premise" fails the day that
 * seam answers anything else. That is deliberate: an assumption nothing
 * recomputes is how `proven_optimal` gets printed beside a wrong answer months
 * from now. Whoever closes the tax seam has to decide what this search does
 * about the coupling BEFORE the flag flips, and the red build is what tells
 * them.
 *
 *  - `M ≤ MAX_SOLVER_MERCHANTS` (14): exact, `proven_optimal`.
 *  - `M >  MAX_SOLVER_MERCHANTS`: the deterministic greedy below, reported
 *    `approximate` / `merchant_limit_reached` with the item-price lower bound.
 *  - The clock passes `SOLVER_TIME_BUDGET_MS` mid-enumeration: the best plan
 *    found so far, `approximate` / `time_limit_reached`.
 *  - `pruneBasketCandidates` hit a cap: `approximate` /
 *    `candidate_limit_reached`, because the offer that would have won by
 *    consolidating merchants may be the one the cap removed.
 *
 * Every one of those is REPORTED. A shopper being told "this is the cheapest"
 * and "this is the cheapest we could establish in 750 ms" are being told
 * different things.
 *
 * ## Nothing here depends on ingestion order
 *
 * Subsets are enumerated over a SORTED merchant list; a line's best candidate
 * is chosen by the objective's comparator with `tieBreak` — #74's
 * `sha256(policyVersion + ':' + offerId)` — as the total last resort; and two
 * plans of equal objective value are separated by their content digests. So the
 * comparator chain is TOTAL at every level and `Array.prototype.sort`'s
 * stability can never leak the input order into the answer (solver design
 * rule 5).
 */

import {
  hasKnownPlanTotal,
  hasKnownComparisonMoney,
  type BasketApproximationReason,
  type BasketObjective,
  type BasketOptimality,
  type BasketPlan,
  type BasketReasonCode,
  type BasketRequestLine,
  type BasketUnresolvedLine,
  type CurrencyCode,
  type Money,
} from '@mercaria/shared-types';
import { MAX_SOLVER_MERCHANTS, SOLVER_TIME_BUDGET_MS } from '../policy.js';
import type { BasketCandidate } from './candidates.js';
import { composeBasketPlan, type Assignment } from './plan.js';

export interface SolveInput {
  readonly lines: readonly BasketRequestLine[];
  readonly candidates: readonly BasketCandidate[];
  readonly objective: BasketObjective;
  readonly currency: CurrencyCode;
  /** Every line that was already refused before the search. */
  readonly refusals: ReadonlyMap<string, readonly BasketReasonCode[]>;
  readonly maxMerchants?: number;
  /** Set when a cap removed a candidate that passed every filter. */
  readonly candidatesTruncated: boolean;
  /** Injected so a test can drive the budget without waiting. */
  readonly now?: () => number;
  readonly timeBudgetMs?: number;
}

export interface SolveOutcome {
  readonly plan: BasketPlan;
  readonly optimality: BasketOptimality;
  /** How many merchants the search actually considered. */
  readonly consideredMerchantCount: number;
}

/**
 * Solve for one objective.
 *
 * Always returns a plan. A request nothing can serve produces a plan with no
 * lines and every line unresolved, which is solver design rule 10 ("detect when
 * no complete feasible plan exists and return partial coverage honestly") —
 * there is no failure branch and no exception, because a basket with two of
 * three items available is a useful answer and refusing it would be a worse
 * one.
 */
export function solveBasket(input: SolveInput): SolveOutcome {
  const clock = input.now ?? Date.now;
  const deadline = clock() + (input.timeBudgetMs ?? SOLVER_TIME_BUDGET_MS);

  const byLine = new Map<string, BasketCandidate[]>();
  for (const candidate of input.candidates) {
    const bucket = byLine.get(candidate.lineId);
    if (bucket === undefined) byLine.set(candidate.lineId, [candidate]);
    else bucket.push(candidate);
  }

  // Lines that survive OBJECTIVE-specific selectability, which is not the same
  // as surviving the filters: `fastest_known_delivery` cannot use an offer that
  // quotes no window, and saying so per line is what stops the objective
  // silently answering over a subset nobody was told about.
  const selectable = new Map<string, BasketCandidate[]>();
  const objectiveRefusals = new Map<string, BasketReasonCode[]>();
  for (const line of input.lines) {
    const forLine = (byLine.get(line.lineId) ?? []).filter((candidate) =>
      objectiveAdmits(input.objective, candidate),
    );
    if (forLine.length > 0) selectable.set(line.lineId, forLine);
    else if (!input.refusals.has(line.lineId)) {
      objectiveRefusals.set(line.lineId, [objectiveRefusalFor(input.objective)]);
    }
  }

  const merchants = [...new Set([...selectable.values()].flat().map((c) => c.merchantKey))].sort();
  const cap = Math.min(input.maxMerchants ?? merchants.length, merchants.length);

  const search =
    merchants.length > MAX_SOLVER_MERCHANTS
      ? greedySearch(input, selectable, merchants, cap)
      : exactSearch(input, selectable, merchants, cap, deadline, clock);

  const unresolved: BasketUnresolvedLine[] = [];
  for (const line of input.lines) {
    if (search.assignments.some((assignment) => assignment.line.lineId === line.lineId)) continue;
    const reasons =
      input.refusals.get(line.lineId) ??
      objectiveRefusals.get(line.lineId) ??
      search.unresolvedReasons.get(line.lineId) ?? ['no_eligible_offer'];
    unresolved.push({
      lineId: line.lineId,
      canonicalProductId: line.canonicalProductId,
      reasons,
    });
  }

  const plan = composeBasketPlan({
    assignments: search.assignments,
    unresolved,
    currency: input.currency,
  });

  return {
    plan,
    optimality: resolveOptimality(input, search, plan),
    consideredMerchantCount: merchants.length,
  };
}

/** What a search pass produced. */
interface SearchResult {
  readonly assignments: readonly Assignment[];
  readonly exact: boolean;
  readonly timedOut: boolean;
  readonly unresolvedReasons: ReadonlyMap<string, readonly BasketReasonCode[]>;
  readonly lowerBound?: Money;
}

/**
 * The exact enumeration.
 *
 * A subset is SKIPPED when the assignment it produces does not use every
 * merchant in it: that same assignment is produced by the smaller subset of the
 * merchants it actually uses, and evaluating it here would charge delivery for
 * a merchant nothing was bought from. So every distinct plan is evaluated
 * exactly once, with its exact delivery.
 */
function exactSearch(
  input: SolveInput,
  selectable: ReadonlyMap<string, BasketCandidate[]>,
  merchants: readonly string[],
  cap: number,
  deadline: number,
  clock: () => number,
): SearchResult {
  let best: { assignments: readonly Assignment[]; plan: BasketPlan } | undefined;
  let timedOut = false;
  const total = 1 << merchants.length;

  for (let mask = 1; mask < total; mask += 1) {
    if (clock() > deadline) {
      timedOut = true;
      break;
    }
    if (popcount(mask) > cap) continue;

    const allowed = new Set<string>();
    for (let index = 0; index < merchants.length; index += 1) {
      if ((mask & (1 << index)) !== 0) allowed.add(merchants[index]);
    }

    const assignments = assignWithin(input, selectable, allowed);
    if (assignments.length === 0) continue;

    const used = new Set(assignments.map((assignment) => assignment.candidate.merchantKey));
    if (used.size !== allowed.size) continue;

    const plan = composeBasketPlan({ assignments, unresolved: [], currency: input.currency });
    if (best === undefined || betterPlan(input.objective, plan, best.plan)) {
      best = { assignments, plan };
    }
  }

  const assignments = best === undefined ? [] : best.assignments;
  const bound = lowerBoundOf(input, selectable);
  return {
    assignments,
    exact: !timedOut,
    timedOut,
    unresolvedReasons: unresolvedFor(input, selectable, assignments),
    ...(bound === undefined ? {} : { lowerBound: bound }),
  };
}

/**
 * The deterministic greedy, for a catalogue with more merchants than the exact
 * search can enumerate.
 *
 * Start from each line's independently best candidate, then try CONSOLIDATING
 * onto each merchant in sorted key order, keeping any move that improves the
 * objective. Bounded to three rounds — measured to converge in one on every
 * benchmark scenario, and a bound is what keeps a "greedy" from being an
 * unbounded local search with a time budget in front of it.
 *
 * Deterministic in every step: the starting assignment is the comparator's, the
 * consolidation order is the sorted merchant list, and an equal-value move is
 * NOT taken, so the result cannot depend on the order candidates arrived in.
 */
function greedySearch(
  input: SolveInput,
  selectable: ReadonlyMap<string, BasketCandidate[]>,
  merchants: readonly string[],
  cap: number,
): SearchResult {
  // The cap is satisfied BEFORE anything is optimised. `assignWithin` over
  // every merchant would return one plan per line, and the consolidation loop
  // below only ACCEPTS moves that stay within the cap — it never forces
  // convergence, so an uncapped start stays uncapped. A ceiling the shopper set
  // is a hard constraint (#96 solver requirement 10), and reporting a
  // twenty-merchant plan as `approximate` would say "could not prove optimal"
  // where the truth is "ignored your limit".
  const permitted = selectMerchantsWithinCap(input, selectable, merchants, cap);
  let assignments = assignWithin(input, selectable, permitted);
  if (assignments.length === 0) {
    return {
      assignments: [],
      exact: false,
      timedOut: false,
      unresolvedReasons: unresolvedFor(input, selectable, []),
    };
  }
  let plan = composeBasketPlan({ assignments, unresolved: [], currency: input.currency });

  for (let round = 0; round < 3; round += 1) {
    let improved = false;
    for (const merchant of [...permitted].sort()) {
      const moved = assignments.map((assignment) => {
        const alternative = (selectable.get(assignment.line.lineId) ?? [])
          .filter((candidate) => candidate.merchantKey === merchant)
          .sort((left, right) => compareCandidates(input.objective, left, right))[0];
        return alternative === undefined ? assignment : { line: assignment.line, candidate: alternative };
      });
      const used = new Set(moved.map((assignment) => assignment.candidate.merchantKey));
      if (used.size > cap) continue;
      const candidatePlan = composeBasketPlan({
        assignments: moved,
        unresolved: [],
        currency: input.currency,
      });
      if (betterPlan(input.objective, candidatePlan, plan)) {
        assignments = moved;
        plan = candidatePlan;
        improved = true;
      }
    }
    if (!improved) break;
  }

  const bound = lowerBoundOf(input, selectable);
  return {
    assignments,
    exact: false,
    timedOut: false,
    unresolvedReasons: unresolvedFor(input, selectable, assignments),
    ...(bound === undefined ? {} : { lowerBound: bound }),
  };
}

/**
 * The merchants the greedy pass may use, at most `cap` of them.
 *
 * A greedy SET COVER: repeatedly take the merchant that covers the most
 * lines nothing chosen yet can serve. That is the standard approximation for
 * the problem the cap actually poses — "reach as many of my items as possible
 * through at most N checkouts" — and it is why the choice cannot simply be the
 * first `cap` merchant keys: a merchant serving three lines is worth more than
 * three serving one each when only one may be kept.
 *
 * Deterministic at every step. Ties on coverage break on the cheaper total for
 * the lines being covered, then on the merchant key — so the answer never
 * depends on the order candidates arrived in, which is the property the whole
 * solver is built around.
 *
 * Lines left uncovered are NOT dropped: `unresolvedFor` reports each one with
 * `merchant_limit_would_be_exceeded`, which is the honest partial coverage
 * solver design rule 10 asks for.
 */
function selectMerchantsWithinCap(
  input: SolveInput,
  selectable: ReadonlyMap<string, BasketCandidate[]>,
  merchants: readonly string[],
  cap: number,
): ReadonlySet<string> {
  if (merchants.length <= cap) return new Set(merchants);

  const uncovered = new Set(
    input.lines.map((line) => line.lineId).filter((lineId) => selectable.has(lineId)),
  );
  const chosen = new Set<string>();

  while (chosen.size < cap && uncovered.size > 0) {
    let best: { merchant: string; covered: string[]; cost: number } | undefined;
    for (const merchant of [...merchants].sort()) {
      if (chosen.has(merchant)) continue;
      const covered: string[] = [];
      let cost = 0;
      for (const lineId of uncovered) {
        const options = (selectable.get(lineId) ?? []).filter(
          (candidate) => candidate.merchantKey === merchant,
        );
        if (options.length === 0) continue;
        covered.push(lineId);
        const cheapest = [...options].sort((left, right) =>
          compareCandidates(input.objective, left, right),
        )[0];
        cost += hasKnownComparisonMoney(cheapest.unitItemPrice)
          ? cheapest.unitItemPrice.amount.amount
          : 0;
      }
      if (covered.length === 0) continue;
      if (
        best === undefined ||
        covered.length > best.covered.length ||
        (covered.length === best.covered.length && cost < best.cost)
      ) {
        best = { merchant, covered, cost };
      }
    }
    if (best === undefined) break;
    chosen.add(best.merchant);
    for (const lineId of best.covered) uncovered.delete(lineId);
  }

  return chosen;
}

/** Each line's best candidate drawn from the allowed merchants, or nothing. */
function assignWithin(
  input: SolveInput,
  selectable: ReadonlyMap<string, BasketCandidate[]>,
  allowed: ReadonlySet<string>,
): readonly Assignment[] {
  const assignments: Assignment[] = [];
  for (const line of input.lines) {
    const options = (selectable.get(line.lineId) ?? []).filter((candidate) =>
      allowed.has(candidate.merchantKey),
    );
    if (options.length === 0) continue;
    const chosen = [...options].sort((left, right) =>
      compareCandidates(input.objective, left, right),
    )[0];
    assignments.push({ line, candidate: chosen });
  }
  return assignments;
}

/** Why the lines this search did not cover were not covered. */
function unresolvedFor(
  input: SolveInput,
  selectable: ReadonlyMap<string, BasketCandidate[]>,
  assignments: readonly Assignment[],
): ReadonlyMap<string, readonly BasketReasonCode[]> {
  const covered = new Set(assignments.map((assignment) => assignment.line.lineId));
  const reasons = new Map<string, readonly BasketReasonCode[]>();
  for (const line of input.lines) {
    if (covered.has(line.lineId)) continue;
    if (!selectable.has(line.lineId)) continue;
    // The line HAD a selectable candidate and still is not in the plan, which
    // under this search can only mean the merchant ceiling refused every
    // merchant that could serve it.
    reasons.set(line.lineId, ['merchant_limit_would_be_exceeded']);
  }
  return reasons;
}

/**
 * A valid lower bound on any plan's ITEM subtotal.
 *
 * The sum of each line's globally cheapest known unit price times its quantity.
 * Deliveries are non-negative, so this bounds the delivered total too — which
 * is what makes it worth reporting beside an approximate answer: a shopper can
 * see how much room the search might have left on the table.
 */
function lowerBoundOf(
  input: SolveInput,
  selectable: ReadonlyMap<string, BasketCandidate[]>,
): Money | undefined {
  let total = 0;
  let currency: CurrencyCode | undefined;
  for (const line of input.lines) {
    const options = selectable.get(line.lineId) ?? [];
    let cheapest: number | undefined;
    for (const candidate of options) {
      if (!hasKnownComparisonMoney(candidate.unitItemPrice)) continue;
      currency = candidate.unitItemPrice.amount.currency;
      const amount = candidate.unitItemPrice.amount.amount;
      if (cheapest === undefined || amount < cheapest) cheapest = amount;
    }
    if (cheapest === undefined) continue;
    total += cheapest * line.quantity;
  }
  return currency === undefined ? undefined : { amount: total, currency };
}

/**
 * Whether one objective can use this candidate at all.
 *
 * `fastest_known_delivery` refuses an offer that quotes no window, because an
 * unquoted window is not a fast one and is not a slow one. `all_native` refuses
 * an offer Mercaria cannot sell. Everything else is admitted and ordered by
 * {@link compareCandidates}.
 */
function objectiveAdmits(objective: BasketObjective, candidate: BasketCandidate): boolean {
  if (objective === 'fastest_known_delivery') return candidate.deliveryMaxDays !== undefined;
  if (objective === 'all_native') return candidate.nativeCheckoutEligible;
  return true;
}

/** The reason code a line gets when the objective admitted none of its offers. */
function objectiveRefusalFor(objective: BasketObjective): BasketReasonCode {
  if (objective === 'fastest_known_delivery') return 'delivery_cost_unknown';
  if (objective === 'all_native') return 'objective_requires_native_offer';
  return 'no_eligible_offer';
}

/**
 * Order two candidates for one line under one objective.
 *
 * TOTAL at every level: the last comparison is the stable digest, which never
 * ties, so `sort` stability can never leak the input order (solver design
 * rule 5). Returns a negative number when `left` should be preferred.
 */
function compareCandidates(
  objective: BasketObjective,
  left: BasketCandidate,
  right: BasketCandidate,
): number {
  if (objective === 'fastest_known_delivery') {
    const leftDays = left.deliveryMaxDays ?? Number.POSITIVE_INFINITY;
    const rightDays = right.deliveryMaxDays ?? Number.POSITIVE_INFINITY;
    if (leftDays !== rightDays) return leftDays - rightDays;
  }
  const leftPrice = hasKnownComparisonMoney(left.unitItemPrice)
    ? left.unitItemPrice.amount.amount
    : Number.POSITIVE_INFINITY;
  const rightPrice = hasKnownComparisonMoney(right.unitItemPrice)
    ? right.unitItemPrice.amount.amount
    : Number.POSITIVE_INFINITY;
  if (leftPrice !== rightPrice) return leftPrice - rightPrice;

  const leftDelivery = hasKnownComparisonMoney(left.delivery)
    ? left.delivery.amount.amount
    : Number.POSITIVE_INFINITY;
  const rightDelivery = hasKnownComparisonMoney(right.delivery)
    ? right.delivery.amount.amount
    : Number.POSITIVE_INFINITY;
  if (leftDelivery !== rightDelivery) return leftDelivery - rightDelivery;

  return left.tieBreak < right.tieBreak ? -1 : left.tieBreak > right.tieBreak ? 1 : 0;
}

/**
 * Whether one whole plan beats another under one objective.
 *
 * Coverage FIRST, always: a plan that serves four of five lines beats one that
 * serves three however cheap the three are, because the shopper asked for five.
 * Then the objective's own measure, then the content digest — which never ties,
 * so this comparison is total and two structurally different plans of identical
 * cost always resolve the same way.
 */
function betterPlan(objective: BasketObjective, candidate: BasketPlan, incumbent: BasketPlan): boolean {
  if (candidate.coveredLineIds.length !== incumbent.coveredLineIds.length) {
    return candidate.coveredLineIds.length > incumbent.coveredLineIds.length;
  }

  switch (objective) {
    case 'fewest_merchants': {
      if (candidate.merchantCount !== incumbent.merchantCount) {
        return candidate.merchantCount < incumbent.merchantCount;
      }
      return byItemSubtotalThenDigest(candidate, incumbent);
    }
    case 'cheapest_known_total': {
      const left = hasKnownPlanTotal(candidate.deliveredTotal)
        ? candidate.deliveredTotal.amount.amount
        : Number.POSITIVE_INFINITY;
      const right = hasKnownPlanTotal(incumbent.deliveredTotal)
        ? incumbent.deliveredTotal.amount.amount
        : Number.POSITIVE_INFINITY;
      if (left !== right) return left < right;
      return byItemSubtotalThenDigest(candidate, incumbent);
    }
    case 'fastest_known_delivery': {
      const left = candidate.deliveryMaxDays ?? Number.POSITIVE_INFINITY;
      const right = incumbent.deliveryMaxDays ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left < right;
      return byItemSubtotalThenDigest(candidate, incumbent);
    }
    case 'all_native': {
      const left = candidate.lines.filter((line) => line.channel === 'native_checkout').length;
      const right = incumbent.lines.filter((line) => line.channel === 'native_checkout').length;
      if (left !== right) return left > right;
      return byItemSubtotalThenDigest(candidate, incumbent);
    }
    case 'cheapest_known_item_prices':
    default:
      return byItemSubtotalThenDigest(candidate, incumbent);
  }
}

/** The shared tail of every objective comparison. */
function byItemSubtotalThenDigest(candidate: BasketPlan, incumbent: BasketPlan): boolean {
  const left = hasKnownPlanTotal(candidate.itemSubtotal)
    ? candidate.itemSubtotal.amount.amount
    : Number.POSITIVE_INFINITY;
  const right = hasKnownPlanTotal(incumbent.itemSubtotal)
    ? incumbent.itemSubtotal.amount.amount
    : Number.POSITIVE_INFINITY;
  if (left !== right) return left < right;
  if (candidate.merchantCount !== incumbent.merchantCount) {
    return candidate.merchantCount < incumbent.merchantCount;
  }
  return candidate.planDigest < incumbent.planDigest;
}

/**
 * Whether the answer is proven, and if not, why not.
 *
 * The candidate cap is checked FIRST and independently of the search: an exact
 * enumeration over a truncated candidate set is an exact answer to the wrong
 * question, and reporting it `proven_optimal` would be the most misleading
 * output this domain can produce.
 */
function resolveOptimality(
  input: SolveInput,
  search: SearchResult,
  plan: BasketPlan,
): BasketOptimality {
  const reason: BasketApproximationReason | undefined = input.candidatesTruncated
    ? 'candidate_limit_reached'
    : search.timedOut
      ? 'time_limit_reached'
      : !search.exact
        ? 'merchant_limit_reached'
        : undefined;
  if (reason === undefined) return { status: 'proven_optimal' };
  // The bound is only meaningful when the plan actually covers something; an
  // empty plan's bound would be a number about a basket nobody has.
  const bound = plan.coveredLineIds.length === 0 ? undefined : search.lowerBound;
  return {
    status: 'approximate',
    reason,
    ...(bound === undefined ? {} : { lowerBound: bound }),
  };
}

/** How many merchants a bitmask names. */
function popcount(mask: number): number {
  let count = 0;
  let value = mask;
  while (value !== 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
}
