/**
 * Deciding whether one alert is satisfied — PURE, and the whole of #79's
 * evaluation rules that do not need a database (#79 evaluation 5, 6, 7).
 *
 * Everything impure lives in `evaluation.service.ts`. This module receives the
 * offers #74 already ADMITTED and their facts, and answers with a
 * {@link PriceAlertQualification}.
 *
 * ## What this module can and cannot see, and why that is the design
 *
 * It receives {@link EligibleOffer}s — #74's `selectEligibleOffers` output — and
 * has no way to reach an excluded one. So "expired, quarantined, suppressed or
 * unavailable offers cannot trigger" (#79 evaluation 6) is not a rule checked
 * here; it is a property of the INPUT, decided by the domain that owns it. Every
 * one of those states is an `OfferExclusionReason`, and an excluded offer never
 * reaches this function at all.
 *
 * The same reasoning covers freshness: an offer past its source's own contract
 * is refused by `mayAppearInComparison` inside #74's eligibility, which is why
 * #68 records that "an old price cannot fire a new alert is already true of
 * anything obtained through `mayAppearInComparison`". Re-deriving it here would
 * be a second authority over somebody else's contract.
 *
 * ## Unknown never satisfies anything
 *
 * Three separate places, each of which would otherwise read silence as a yes:
 *
 * - A `known_total` alert is answered from `facts.total`, whose unknown branch
 *   has NO amount — so an offer whose postage nobody published cannot be
 *   compared at all (#79 evaluation 5, acceptance 2).
 * - `availabilityRequirement: 'in_stock'` requires a POSITIVE statement. Most
 *   feeds publish none and #57 records that as `unknown`.
 * - `minimumAvailableQuantity` requires a published quantity. An absent one is
 *   not "enough".
 */

import type {
  ConditionGroup,
  Money,
  Offer,
  OfferComparisonPrice,
  PriceAlertBlockReason,
  PriceAlertCostComponent,
  PriceAlertQualification,
  PriceAlertTriggerQuote,
} from '@mercaria/shared-types';
import type { EligibleOffer } from '@mercaria/shared-types';
import type { PriceAlertRow } from '../../db/priceAlerts/priceAlertRepository.js';

/**
 * One admitted offer, with the projection beside it.
 *
 * Two values rather than one because #74's `EligibleOffer` deliberately carries
 * only an id and the FACTS a scorer may read — it has no merchant, no variant
 * and no pickup state, precisely so a weight cannot reach them. An alert's scope
 * asks about exactly those, so the caller supplies the offer too and the pairing
 * is explicit rather than smuggled into the facts type.
 */
export interface AlertCandidate {
  readonly offer: Offer;
  readonly admitted: EligibleOffer;
  /**
   * The immutable observation behind this offer's current price
   * (`offer_price_snapshots.id`), or absent when there is none.
   *
   * Absent is a real state — a native offer whose convergence recorded no
   * observation because the price was unchanged inside the anchor interval has
   * an OLDER one, and an offer written before #78 has none at all — and it
   * BLOCKS. See {@link PriceAlertQualification}'s `observedPriceVersion`.
   */
  readonly observedPriceVersion?: string;
}

/** Why one candidate is outside an alert's scope. Internal to this module. */
type ScopeMiss =
  | 'variant'
  | 'condition'
  | 'seller'
  | 'merchant'
  | 'storefront'
  | 'availability'
  | 'quantity'
  | 'pickup';

/**
 * Whether one candidate is inside the alert's declared scope.
 *
 * Returns the MISS rather than a boolean so a trace can say which clause
 * excluded an offer, and so this function reads as a list of the issue's model
 * fields rather than as one long conjunction.
 */
function scopeMiss(alert: PriceAlertRow, candidate: AlertCandidate): ScopeMiss | undefined {
  const { offer } = candidate;

  if (alert.canonicalVariantId && offer.canonicalVariantId !== alert.canonicalVariantId) {
    return 'variant';
  }

  if (alert.conditionGroups.length > 0) {
    const group = offer.condition.group;
    // An offer whose source wording did not map has NO group (#90), and a
    // restricted segment is a statement about which segments count. Reading an
    // unmapped offer as matching would tell a buyer watching `used` about an
    // item nobody has classified.
    if (group === undefined) return 'condition';
    if (!(alert.conditionGroups as readonly ConditionGroup[]).includes(group)) return 'condition';
  }

  switch (alert.sellerScope) {
    case 'native_only':
      if (offer.kind !== 'native') return 'seller';
      break;
    case 'external_only':
      if (offer.kind === 'native') return 'seller';
      break;
    case 'official_only':
      // #55's VERIFIED relationship, read through #74's facts and never from a
      // name, a logo or a domain. `undefined` means the question could not be
      // asked at all (the subject resolves to no brand), which is not a yes.
      if (candidate.admitted.facts.relationship !== 'official_channel') return 'seller';
      break;
    case 'any':
      break;
  }

  if (alert.merchantId && offer.merchantId !== alert.merchantId) return 'merchant';
  if (alert.storefrontId && offer.storefrontId !== alert.storefrontId) return 'storefront';

  if (alert.availabilityRequirement === 'in_stock' && offer.availability !== 'in_stock') {
    return 'availability';
  }

  if (alert.minimumAvailableQuantity !== null) {
    const quantity = offer.availableQuantity;
    if (quantity === undefined || quantity < alert.minimumAvailableQuantity) return 'quantity';
  }

  if (alert.requirePickupAvailable && offer.delivery.pickup !== 'available') return 'pickup';

  return undefined;
}

/**
 * The amount this alert's basis compares, in the alert's currency.
 *
 * Both unions are narrowed with `in` and never with a truthiness test on their
 * boolean-literal discriminant. `@mercaria/backend` compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not reliably
 * narrow one — measured here, not assumed: `if (!facts.itemPrice.known)` failed
 * to give the false branch its `reason`. `in` narrowing works under both
 * configurations, which is why every read of #74's cost unions in this domain
 * takes that form.
 */
function basisAmount(
  alert: PriceAlertRow,
  candidate: AlertCandidate,
): { readonly amount: Money } | { readonly missing: PriceAlertBlockReason } {
  const facts = candidate.admitted.facts;

  if (alert.basis === 'item_price') {
    if ('amount' in facts.itemPrice) return { amount: facts.itemPrice.amount };
    return {
      missing:
        facts.itemPrice.reason === 'not_convertible'
          ? 'currency_not_convertible'
          : 'no_offer_in_scope',
    };
  }

  if ('amount' in facts.total) return { amount: facts.total.amount };
  // NAME the half that was missing. "We do not know the shipping" and "we do
  // not know the price" lead a buyer to different next actions, and #74's own
  // `OfferComparisonTotal` keeps them apart for that reason.
  return {
    missing: facts.total.missing.includes('delivery_cost')
      ? 'delivery_cost_unknown'
      : 'no_offer_in_scope',
  };
}

/** The quotes that produced an amount — the identity conversion is NOT one. */
function quotesFor(
  alert: PriceAlertRow,
  candidate: AlertCandidate,
): readonly PriceAlertTriggerQuote[] {
  const facts = candidate.admitted.facts;
  const components: readonly (readonly [PriceAlertCostComponent, OfferComparisonPrice])[] =
    alert.basis === 'known_total'
      ? [
          ['item_price', facts.itemPrice],
          ['delivery_cost', facts.deliveryCost],
        ]
      : [['item_price', facts.itemPrice]];

  const quotes: PriceAlertTriggerQuote[] = [];
  for (const [component, price] of components) {
    // `in`, not `price.known` — see `basisAmount`'s note on `strict: false`.
    if (!('fx' in price)) continue;
    // A same-currency conversion is not a conversion. Storing one would be a row
    // asserting that something happened, and the trigger's own CHECK refuses it.
    if (price.fx.from === price.fx.to) continue;
    quotes.push({ component, snapshot: price.fx });
  }
  return quotes;
}

/**
 * What the best in-scope candidate is, and whether it satisfies the target.
 *
 * The winner is the LOWEST amount, and ties break by offer id — deterministic,
 * so two evaluations of one unchanged set agree. A uuid v7 id is not monotonic
 * within a millisecond, but that is irrelevant here: this is a tie-break for
 * REPRODUCIBILITY and not an ordering that means anything, and the alternative
 * (array order) is what actually varies between runs.
 */
export function qualifyAlert(input: {
  readonly alert: PriceAlertRow;
  readonly candidates: readonly AlertCandidate[];
}): PriceAlertQualification {
  const { alert } = input;

  if (alert.proximityScope !== 'any') {
    // #93 publishes no collection points and #74's `resolvePickupProximity`
    // refuses every request, so an alert scoped this way could never be
    // satisfied. Blocking by NAME is what makes the seam readable in a trace
    // rather than looking like "no offer was cheap enough".
    return { outcome: 'blocked', reasons: ['proximity_scope_unsupported'] };
  }

  const misses = new Set<ScopeMiss>();
  const priced: { candidate: AlertCandidate; amount: Money }[] = [];
  const missingReasons = new Set<PriceAlertBlockReason>();

  for (const candidate of input.candidates) {
    const miss = scopeMiss(alert, candidate);
    if (miss !== undefined) {
      misses.add(miss);
      continue;
    }
    const basis = basisAmount(alert, candidate);
    if ('missing' in basis) {
      missingReasons.add(basis.missing);
      continue;
    }
    if (basis.amount.currency !== alert.targetCurrency) {
      // #74 converted into the comparison currency the caller asked for, so this
      // is unreachable through `evaluatePriceAlerts` — and it is checked anyway,
      // because the alternative to a refusal here is comparing raw minor units
      // across currencies, which is the one arithmetic error money rule 6 exists
      // to make impossible.
      missingReasons.add('currency_not_convertible');
      continue;
    }
    priced.push({ candidate, amount: basis.amount });
  }

  if (priced.length === 0) {
    const reasons: PriceAlertBlockReason[] = [...missingReasons];
    if (reasons.length === 0) {
      reasons.push(
        input.candidates.length === 0
          ? 'no_eligible_offer'
          : misses.size > 0
            ? 'no_offer_in_scope'
            : 'no_eligible_offer',
      );
    }
    return { outcome: 'blocked', reasons };
  }

  priced.sort(
    (left, right) =>
      left.amount.amount - right.amount.amount ||
      left.candidate.offer.id.localeCompare(right.candidate.offer.id),
  );
  const best = priced[0];
  if (!best) return { outcome: 'blocked', reasons: ['no_eligible_offer'] };

  if (best.amount.amount > alert.targetAmount) {
    return {
      outcome: 'blocked',
      reasons: ['above_target'],
      bestInScopeAmount: best.amount,
    };
  }

  const observedPriceVersion = best.candidate.observedPriceVersion;
  if (observedPriceVersion === undefined) {
    // The trigger key names the observed-price version, and the column is NOT
    // NULL. A trigger without one could never recognise its own repeat, so a
    // qualifying price with no immutable observation behind it is a BLOCK — the
    // fail-closed direction, and one an operator can see in the trace.
    return {
      outcome: 'blocked',
      reasons: ['no_observed_price_version'],
      bestInScopeAmount: best.amount,
    };
  }

  const facts = best.candidate.admitted.facts;
  const itemPrice = best.candidate.offer.price;
  if (itemPrice === undefined) {
    // Unreachable through a known amount — #74's `itemPrice` is derived from
    // this very field — and stated so the trigger's NOT NULL native columns
    // cannot be reached with nothing to put in them.
    return {
      outcome: 'blocked',
      reasons: ['no_eligible_offer'],
      bestInScopeAmount: best.amount,
    };
  }

  const delivery = best.candidate.offer.delivery;
  const nativeDelivery =
    alert.basis === 'known_total' && delivery.known ? delivery.cost : undefined;

  return {
    outcome: 'qualified',
    offerId: best.candidate.offer.id,
    canonicalVariantId: best.candidate.offer.canonicalVariantId,
    observedPriceVersion,
    amount: best.amount,
    nativeItemAmount: itemPrice.amount,
    nativeItemCurrency: itemPrice.currency,
    ...(nativeDelivery
      ? {
          nativeDeliveryAmount: nativeDelivery.amount,
          nativeDeliveryCurrency: nativeDelivery.currency,
        }
      : {}),
    quotes: quotesFor(alert, best.candidate),
    ...(facts.conditionGroup ? { conditionGroup: facts.conditionGroup } : {}),
    ...(best.candidate.offer.merchantId ? { merchantId: best.candidate.offer.merchantId } : {}),
    offerKind: best.candidate.offer.kind,
    nativeCheckoutEligible: facts.nativeCheckoutEligible,
  };
}

/**
 * The best in-scope amount an evaluation SAW, whatever it concluded.
 *
 * This is what re-arms a `reset_threshold` alert, and it is deliberately a
 * separate reading from the qualification: an alert re-arms because the market
 * climbed back above the threshold, which is a fact about a price that did NOT
 * qualify. Reading it off the qualification would mean only a qualifying
 * evaluation could ever re-arm one, which is exactly backwards.
 */
export function bestInScopeAmount(
  qualification: PriceAlertQualification,
): Money | undefined {
  return qualification.outcome === 'qualified'
    ? qualification.amount
    : qualification.bestInScopeAmount;
}
