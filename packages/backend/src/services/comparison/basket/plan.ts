/**
 * Turning an assignment into a plan (#96 solver requirements 5–8).
 *
 * PURE. Given "line L is served by candidate C", this composes the merchant
 * groups, applies each merchant's shipping threshold, and produces the two
 * totals — item subtotal and delivered total — each of which is either KNOWN or
 * an honest statement of what is missing.
 *
 * ## The hardest decision in the domain: what a merchant charges for two items
 *
 * #57 records delivery PER OFFER: a cost, and optionally the basket value above
 * which that merchant ships free. It does not record whether a merchant
 * combines two items into one parcel, and no feed Mercaria reads publishes it.
 *
 * There are three ways to answer and two of them are wrong:
 *
 *  - **Sum the per-offer costs.** Overstates every merchant that combines
 *    shipping, which is most of them, and makes consolidating with one merchant
 *    look worse than splitting across three.
 *  - **Take the cheapest, or the maximum, of the quotes.** Understates or
 *    overstates depending on the merchant, and either way invents a shipping
 *    policy Mercaria has not observed.
 *  - **Answer UNKNOWN unless the observations agree.** Which is what this
 *    module does.
 *
 * So: a merchant serving ONE line ships for what that offer quoted. A merchant
 * serving several lines ships for the quoted amount only when every one of
 * those offers quotes the SAME cost and the SAME free-over threshold — which is
 * what a merchant with one shipping policy looks like in the data. Two
 * disagreeing quotes from one merchant means Mercaria has observed two shipping
 * policies and does not know which applies to a combined order, so the
 * merchant's delivery is `unknown` and the plan cannot claim a delivered total.
 *
 * That is the "unknown is never zero and never a soft yes" rule applied to the
 * one cost a basket exists to reason about, and it is why
 * `cheapest_known_total` is a genuinely hard result to earn rather than the
 * default one.
 *
 * ## The threshold is applied to the merchant's ITEM SUBTOTAL
 *
 * `freeOver` is a basket-value threshold, so it is compared against what the
 * shopper is spending WITH THAT MERCHANT and never against the whole plan:
 * a threshold met by adding another merchant's items is a discount nobody
 * offered. Inclusive at the boundary (`>=`), because "free over 50" in every
 * feed Mercaria reads means "free at 50".
 */

import {
  combineTaxInclusion,
  coarserFreshness,
  hasKnownPlanTotal,
  hasKnownComparisonMoney,
  type BasketCostComponent,
  type BasketPlan,
  type BasketPlanLine,
  type BasketPlanMerchant,
  type BasketRequestLine,
  type BasketTotal,
  type BasketUnresolvedLine,
  type ComparisonMoneyFact,
  type ComparisonOfferFreshness,
  type CurrencyCode,
  type OfferTaxInclusion,
} from '@mercaria/shared-types';
import { createHash } from 'node:crypto';
import { addMoneyFacts, knownMoney, renderMoney, scaleMoneyFact } from '../render.js';
import type { BasketCandidate } from './candidates.js';

/** One line's chosen candidate, with the quantity it serves. */
export interface Assignment {
  readonly line: BasketRequestLine;
  readonly candidate: BasketCandidate;
}

export interface ComposePlanInput {
  readonly assignments: readonly Assignment[];
  readonly unresolved: readonly BasketUnresolvedLine[];
  readonly currency: CurrencyCode;
}

/**
 * Compose the plan.
 *
 * Merchants are emitted in sorted key order and lines within a merchant in
 * sorted line-id order, so two solves that pick the same offers emit
 * byte-identical plans — which is what makes {@link BasketPlan.planDigest} a
 * usable tie-break and a usable idempotency handle.
 */
export function composeBasketPlan(input: ComposePlanInput): BasketPlan {
  const lines: BasketPlanLine[] = input.assignments
    .map(({ line, candidate }) => ({
      lineId: line.lineId,
      subjectRef: candidate.subjectRef,
      offerRef: candidate.offerRef,
      ...(candidate.merchantRef === undefined ? {} : { merchantRef: candidate.merchantRef }),
      quantity: line.quantity,
      unitItemPrice: candidate.unitItemPrice,
      lineItemPrice: scaleMoneyFact(candidate.unitItemPrice, line.quantity),
      channel: candidate.channel,
      ...(candidate.conditionGroup === undefined
        ? {}
        : { conditionGroup: candidate.conditionGroup }),
      ...(candidate.relationship === undefined ? {} : { relationship: candidate.relationship }),
    }))
    .sort((left, right) => left.lineId.localeCompare(right.lineId));

  const byMerchant = new Map<string, Assignment[]>();
  for (const assignment of input.assignments) {
    const key = assignment.candidate.merchantKey;
    const bucket = byMerchant.get(key);
    if (bucket === undefined) byMerchant.set(key, [assignment]);
    else bucket.push(assignment);
  }

  const merchants: BasketPlanMerchant[] = [...byMerchant.keys()]
    .sort()
    .map((key) => composeMerchant(byMerchant.get(key) ?? [], input.currency));

  const itemSubtotal = sumTotals(
    merchants.map((merchant) => merchant.itemSubtotal),
    input.currency,
    'item_price',
  );
  const deliveredTotal = composeDeliveredTotal(merchants, itemSubtotal, input.currency);

  let freshness: ComparisonOfferFreshness = 'current';
  let taxInclusion: OfferTaxInclusion | undefined;
  let deliveryMaxDays: number | undefined;
  for (const { candidate } of input.assignments) {
    freshness = coarserFreshness(freshness, candidate.freshness);
    taxInclusion =
      taxInclusion === undefined
        ? candidate.taxInclusion
        : combineTaxInclusion(taxInclusion, candidate.taxInclusion);
    if (candidate.deliveryMaxDays !== undefined) {
      deliveryMaxDays =
        deliveryMaxDays === undefined
          ? candidate.deliveryMaxDays
          : Math.max(deliveryMaxDays, candidate.deliveryMaxDays);
    }
  }

  return {
    planDigest: planDigestOf(input.assignments),
    lines,
    merchants,
    merchantCount: merchants.length,
    coveredLineIds: lines.map((line) => line.lineId),
    unresolved: [...input.unresolved].sort((left, right) =>
      left.lineId.localeCompare(right.lineId),
    ),
    itemSubtotal,
    deliveredTotal,
    currency: input.currency,
    freshness,
    // An EMPTY plan has no tax treatment to report, and `unknown` is the honest
    // answer rather than a default that reads as "no tax".
    taxInclusion: taxInclusion ?? 'unknown',
    ...(deliveryMaxDays === undefined ? {} : { deliveryMaxDays }),
  };
}

/** One merchant's group, with its delivery decided. See the module header. */
function composeMerchant(
  assignments: readonly Assignment[],
  currency: CurrencyCode,
): BasketPlanMerchant {
  const first = assignments[0].candidate;
  const lineIds = assignments.map((assignment) => assignment.line.lineId).sort();

  let itemSubtotal: ComparisonMoneyFact = knownMoney(0, currency);
  for (const assignment of assignments) {
    itemSubtotal = addMoneyFacts(
      itemSubtotal,
      scaleMoneyFact(assignment.candidate.unitItemPrice, assignment.line.quantity),
    );
  }

  const delivery = resolveMerchantDelivery(assignments, itemSubtotal, currency);

  let taxInclusion: OfferTaxInclusion = first.taxInclusion;
  let deliveryMaxDays: number | undefined;
  for (const { candidate } of assignments) {
    taxInclusion = combineTaxInclusion(taxInclusion, candidate.taxInclusion);
    if (candidate.deliveryMaxDays !== undefined) {
      deliveryMaxDays =
        deliveryMaxDays === undefined
          ? candidate.deliveryMaxDays
          : Math.max(deliveryMaxDays, candidate.deliveryMaxDays);
    }
  }

  return {
    ...(first.merchantRef === undefined ? {} : { merchantRef: first.merchantRef }),
    channel: first.channel,
    lineIds,
    itemSubtotal,
    delivery,
    ...(deliveryMaxDays === undefined ? {} : { deliveryMaxDays }),
    taxInclusion,
  };
}

/**
 * What this merchant charges to deliver this group.
 *
 * The three cases from the module header, in order. Note the free-over check
 * runs LAST, on an agreed quote: a threshold read off one of two disagreeing
 * quotes would be picking a shipping policy.
 */
function resolveMerchantDelivery(
  assignments: readonly Assignment[],
  itemSubtotal: ComparisonMoneyFact,
  currency: CurrencyCode,
): ComparisonMoneyFact {
  const quotes = assignments.map((assignment) => assignment.candidate.delivery);
  if (quotes.some((quote) => !hasKnownComparisonMoney(quote))) {
    return { state: 'unknown', reason: 'not_published' };
  }

  const amounts = new Set(
    quotes.map((quote) => (hasKnownComparisonMoney(quote) ? quote.amount.amount : -1)),
  );
  const thresholds = new Set(
    assignments.map((assignment) =>
      hasKnownComparisonMoney(assignment.candidate.deliveryFreeOver)
        ? assignment.candidate.deliveryFreeOver.amount.amount
        : -1,
    ),
  );
  if (amounts.size > 1 || thresholds.size > 1) {
    // Two shipping policies observed from one merchant. Mercaria does not know
    // which applies to a combined order, and picking one would be inventing it.
    return { state: 'unknown', reason: 'component_missing' };
  }

  const [amount] = [...amounts];
  const [threshold] = [...thresholds];
  if (
    threshold >= 0 &&
    hasKnownComparisonMoney(itemSubtotal) &&
    itemSubtotal.amount.amount >= threshold
  ) {
    return knownMoney(0, currency);
  }
  return knownMoney(amount, currency);
}

/**
 * The plan's delivered total: items plus every merchant's delivery.
 *
 * Unknown the moment ANY component is, and the unknown branch names which —
 * `tax_inclusion` included, because a total whose tax treatment nobody knows is
 * not a total a shopper can compare against a checkout page. The known FLOOR is
 * carried beside it so a surface can say "at least 210.40 EUR, plus delivery
 * from two merchants" instead of saying nothing.
 */
function composeDeliveredTotal(
  merchants: readonly BasketPlanMerchant[],
  itemSubtotal: BasketTotal,
  currency: CurrencyCode,
): BasketTotal {
  const missing: BasketCostComponent[] = [];
  let running: ComparisonMoneyFact = hasKnownPlanTotal(itemSubtotal)
    ? knownMoney(itemSubtotal.amount.amount, currency)
    : knownMoney(itemSubtotal.knownFloor.amount, currency);
  if (!hasKnownPlanTotal(itemSubtotal)) missing.push('item_price');

  for (const merchant of merchants) {
    if (!hasKnownComparisonMoney(merchant.delivery)) {
      if (!missing.includes('delivery_cost')) missing.push('delivery_cost');
      continue;
    }
    running = addMoneyFacts(running, merchant.delivery);
  }

  let taxInclusion: OfferTaxInclusion | undefined;
  for (const merchant of merchants) {
    taxInclusion =
      taxInclusion === undefined
        ? merchant.taxInclusion
        : combineTaxInclusion(taxInclusion, merchant.taxInclusion);
  }
  if (taxInclusion !== 'inclusive') missing.push('tax_inclusion');

  if (missing.length === 0 && hasKnownComparisonMoney(running)) {
    return { state: 'known', amount: running.amount, rendered: running.rendered };
  }

  const floor = hasKnownComparisonMoney(running) ? running.amount : { amount: 0, currency };
  return {
    state: 'unknown',
    missing,
    knownFloor: floor,
    renderedFloor: renderMoney(floor),
  };
}

/** Add a set of money facts into ONE total, naming the component when one is absent. */
function sumTotals(
  facts: readonly ComparisonMoneyFact[],
  currency: CurrencyCode,
  component: BasketCostComponent,
): BasketTotal {
  let running: ComparisonMoneyFact = knownMoney(0, currency);
  let complete = true;
  for (const fact of facts) {
    if (!hasKnownComparisonMoney(fact)) {
      complete = false;
      continue;
    }
    running = addMoneyFacts(running, fact);
  }
  if (complete && hasKnownComparisonMoney(running)) {
    return { state: 'known', amount: running.amount, rendered: running.rendered };
  }
  const floor = hasKnownComparisonMoney(running) ? running.amount : { amount: 0, currency };
  return {
    state: 'unknown',
    missing: [component],
    knownFloor: floor,
    renderedFloor: renderMoney(floor),
  };
}

/**
 * A plan's identity, from its CONTENT.
 *
 * `sha256` over the sorted `lineId:offerId:quantity` triples. Content-addressed
 * rather than sequential, so two solves that select the same offers produce the
 * same digest whatever order they explored the search space in — which is what
 * lets the digest be the last tie-break between two genuinely different plans
 * of equal cost, in place of "whichever the loop reached first".
 */
export function planDigestOf(assignments: readonly Assignment[]): string {
  const body = assignments
    .map(
      ({ line, candidate }) =>
        `${line.lineId}:${candidate.offerId}:${String(line.quantity)}`,
    )
    .sort()
    .join('|');
  return createHash('sha256').update(body).digest('hex');
}
