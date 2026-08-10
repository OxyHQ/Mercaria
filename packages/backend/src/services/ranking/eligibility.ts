/**
 * `OfferEligibilityService` (#74 §"Separate eligibility from ranking", rules
 * 1–10) — whether an offer may appear at all.
 *
 * PURE, and separate from the ranker in the strongest sense available: the
 * scorer's input type carries no eligibility fact, so no weight can reach one.
 * The failure this separation exists to prevent is specific — a weight changed
 * to make something rank better ALSO making an expired, restricted or suppressed
 * offer visible — and it is a real shape, because the natural single-pass
 * implementation is "score everything, drop anything scoring zero".
 *
 * ## It CONSUMES #57's derivation rather than repeating it
 *
 * Rules 7 and 9 are answered by reading `offer.checkout`, which
 * `deriveNativeCheckoutEligibility` computed at PROJECTION time from the live
 * `listings.status`, the live variant stock and the seller's payment readiness.
 * Re-deriving them here would be a second authority over three tables neither
 * domain owns, and it would be wrong for exactly as long as the two spellings
 * disagreed — which is the window in which a jury has restricted a listing.
 * Nothing in this file reads a listing, a variant or a provider account.
 *
 * ## Unknown never satisfies a filter, and never fails one either
 *
 * Two different treatments, and the difference is what a filter MEANS. A
 * condition filter is a shopper saying "only show me these": an offer whose
 * condition is unknown cannot be shown to satisfy it, so it is excluded. A
 * customer-eligibility statement is a source saying who may buy: `unknown` is
 * the default most feeds publish, so treating it as a restriction would empty
 * every comparison. Both are stated at their rule below rather than left to a
 * reader to infer.
 */

import type {
  ConditionGroup,
  EligibleOffer,
  ItemConditionKey,
  Offer,
  OfferAdmission,
  OfferComparisonExperience,
  OfferCustomerEligibility,
  OfferEligibilitySelection,
  OfferEligibilityVerdict,
  OfferEligibilityRule,
  OfferExclusionReason,
  OfferRankingFacts,
} from '@mercaria/shared-types';
import { mayAppearInComparison, OFFER_ELIGIBILITY_RULES } from '@mercaria/shared-types';

/**
 * Everything the derivation needs that is not on the offer itself.
 *
 * The suppression sets arrive already resolved, one batched read per page, so
 * this module reads no database — the `offer-projection.ts` split, for the same
 * reason: a rule is testable against exact inputs and an exact clock.
 */
export interface OfferEligibilityContext {
  /** The canonical variants this comparison is about (rule 2). */
  readonly canonicalVariantIds: ReadonlySet<string>;
  /** The shopper's market, ISO 3166-1 alpha-2. Absent means no market filter. */
  readonly market?: string;
  /**
   * Customer classes the viewer has established (rule 4).
   *
   * Empty is the ordinary case — a consumer who has proved nothing — and an
   * offer restricted to trade buyers is then excluded. There is deliberately no
   * "assume anyone" mode: a members-only price shown to a non-member is a
   * comparison that cannot be acted on.
   */
  readonly customerClasses: readonly OfferCustomerEligibility[];
  readonly experience: OfferComparisonExperience;
  /** A condition filter, when the shopper set one (rule 6). */
  readonly conditionKeys?: readonly ItemConditionKey[];
  readonly conditionGroups?: readonly ConditionGroup[];
  /** Merchants an operator has suppressed (rule 10). */
  readonly suppressedMerchantIds: ReadonlySet<string>;
  /** Storefronts an operator has suppressed (rule 10). */
  readonly suppressedStorefrontIds: ReadonlySet<string>;
}

/**
 * The rules the derivation ACTUALLY ran, recorded as it runs them.
 *
 * Deliberately NOT `{ rulesEvaluated: OFFER_ELIGIBILITY_RULES }`. That constant
 * form was written first and is VACUOUS: the admission and the ranker's
 * assertion would both read the same tuple, so adding a rule and forgetting to
 * evaluate it would satisfy the check trivially — which is precisely the case
 * the check exists for. Recording each rule at the point it is evaluated makes
 * the two independent, and a rule added to the tuple with no `mark(...)` beside
 * its logic turns the first comparison red.
 */
class EvaluatedRules {
  private readonly seen = new Set<OfferEligibilityRule>();

  mark(rule: OfferEligibilityRule): void {
    this.seen.add(rule);
  }

  admission(): OfferAdmission {
    // The tuple's order, not insertion order, so two verdicts are comparable.
    return { rulesEvaluated: OFFER_ELIGIBILITY_RULES.filter((rule) => this.seen.has(rule)) };
  }
}

/**
 * The customer classes an offer may carry and still be shown to somebody who
 * has proved nothing.
 *
 * `anyone` is the source saying it is open; `unknown` is the source saying
 * nothing, which is what most feeds publish. Reading silence as a restriction
 * would exclude most of the catalogue on the basis of a field nobody filled in.
 */
const OPEN_CUSTOMER_ELIGIBILITIES: readonly OfferCustomerEligibility[] = ['anyone', 'unknown'];

/** Availability values a source POSITIVELY declared unbuyable. */
const DECLARED_UNBUYABLE = new Set(['out_of_stock', 'unavailable']);

/** What one evaluation produced: why it was refused, and what it actually ran. */
export interface OfferEligibilityEvaluation {
  readonly reasons: readonly OfferExclusionReason[];
  readonly admission: OfferAdmission;
}

/**
 * Evaluate every rule against one offer, in the issue's own order.
 *
 * Every reason that applies is returned, not just the first — a seller asking
 * why their offer is missing needs the whole list, and an operator trace that
 * reported one cause at a time would take four round trips to explain an offer
 * that is stale, restricted and suppressed at once. #57's
 * `deriveNativeCheckoutEligibility` makes the same choice for the same reason.
 */
export function evaluateOfferEligibility(
  offer: Offer,
  context: OfferEligibilityContext,
): OfferEligibilityEvaluation {
  const reasons: OfferExclusionReason[] = [];
  const evaluated = new EvaluatedRules();

  // 1 — the offer row itself.
  evaluated.mark('offer_active');
  if (offer.status !== 'active') reasons.push('offer_retired');

  // 2 — it prices the variant this comparison is about.
  evaluated.mark('canonical_variant_match');
  if (!context.canonicalVariantIds.has(offer.canonicalVariantId)) {
    reasons.push('wrong_canonical_variant');
  }

  // 3 — the source's own freshness contract (#68), which is the authority; the
  // stored `stale_at` only ever narrowed the candidate set.
  evaluated.mark('observation_freshness');
  if (!mayAppearInComparison(offer.freshness)) {
    reasons.push(
      offer.freshness.level === 'expired'
        ? 'observation_expired'
        : offer.freshness.level === 'unavailable'
          ? 'observation_unavailable'
          : 'freshness_unknown',
    );
  }

  // 4 — market and customer class. An offer published for no market at all is
  // admitted everywhere: absence of a scope is not a scope excluding anybody.
  evaluated.mark('market_and_customer');
  if (context.market !== undefined && offer.country !== undefined && offer.country !== context.market) {
    reasons.push('market_not_served');
  }
  if (
    !OPEN_CUSTOMER_ELIGIBILITIES.includes(offer.customerEligibility) &&
    !context.customerClasses.includes(offer.customerEligibility)
  ) {
    reasons.push('customer_not_eligible');
  }

  // 5 — availability, against the requested experience. `buy_now` refuses only
  // what a source DECLARED unbuyable; silence is admitted with the signal
  // unknown, which is neither a guess nor a penalty. See
  // `OfferComparisonExperience`.
  evaluated.mark('availability_supported');
  if (DECLARED_UNBUYABLE.has(offer.availability)) {
    if (context.experience === 'buy_now' || offer.availability === 'unavailable') {
      reasons.push('availability_unsupported');
    }
  }

  // 6 — the condition filter. An unknown condition cannot SATISFY a filter, so
  // a filtered comparison excludes it; an unfiltered one keeps it.
  evaluated.mark('condition_filter');
  if (!passesConditionFilter(offer, context)) reasons.push('condition_excluded');

  // 7 and 9 — the native listing, read from #57's live derivation. External
  // offers take no part: their `checkout` is `not_native` by construction, and
  // reading it here would exclude the entire external catalogue.
  //
  // The block reasons are read through an `in` check rather than through
  // `!checkout.eligible`: `@mercaria/backend` compiles without
  // `strictNullChecks`, and MEASURED here, neither the bare truthiness form nor
  // `=== true` narrows a boolean-literal discriminant reached through a property
  // access — `checkout.reasons` was a type error under both. `in` narrows on
  // property PRESENCE, which is independent of the flag.
  evaluated.mark('native_listing_valid');
  evaluated.mark('moderation_restriction');
  const checkout = offer.checkout;
  const blockReasons = 'reasons' in checkout ? checkout.reasons : [];
  if (offer.kind === 'native') {
    for (const blocked of blockReasons) {
      if (blocked === 'listing_restricted') reasons.push('listing_restricted');
      else if (blocked === 'listing_not_active') reasons.push('listing_not_active');
      else if (blocked === 'variant_missing') reasons.push('variant_missing');
      else if (blocked === 'out_of_stock') reasons.push('out_of_stock');
      else if (blocked === 'seller_not_payment_ready') reasons.push('seller_not_payment_ready');
      // `not_native` and `offer_retired` are unreachable here: the first is
      // excluded by the branch above and the second is rule 1's, already
      // recorded. Mapping them again would double-report one fact.
    }
  }

  // 8 — an external offer needs somewhere to send a buyer. An `informational`
  // one deliberately does not: #62 gives that kind to a source whose rights
  // permit displaying a fact and not linking out, and refusing it here would
  // silently drop every such source's whole catalogue.
  evaluated.mark('external_destination');
  if ((offer.kind === 'external' || offer.kind === 'affiliate') && !offer.destinationUrl) {
    reasons.push('destination_missing');
  }

  // 10 — suppression. `merged` is deliberately NOT a suppression: a merged
  // merchant is a tombstone pointing at its winner, so excluding its offers
  // would hide live inventory to hide a redirect.
  evaluated.mark('no_suppression');
  if (offer.merchantId !== undefined && context.suppressedMerchantIds.has(offer.merchantId)) {
    reasons.push('merchant_suppressed');
  }
  if (offer.storefrontId !== undefined && context.suppressedStorefrontIds.has(offer.storefrontId)) {
    reasons.push('storefront_suppressed');
  }
  if (offer.provenance.mayDisplay === false) reasons.push('source_display_withheld');

  return { reasons, admission: evaluated.admission() };
}

/**
 * Whether the offer's condition passes the filter the caller set.
 *
 * Keys and groups are UNIONED, matching `listOffers`' own filter semantics
 * (#90 acceptance 2): a shopper asking for `used_like_new` OR the whole `used`
 * segment means both, not the intersection of them.
 */
function passesConditionFilter(offer: Offer, context: OfferEligibilityContext): boolean {
  const keys = context.conditionKeys ?? [];
  const groups = context.conditionGroups ?? [];
  if (keys.length === 0 && groups.length === 0) return true;
  if (offer.condition.key === 'unknown') return false;
  if (keys.includes(offer.condition.key)) return true;
  return offer.condition.group !== undefined && groups.includes(offer.condition.group);
}

/**
 * Assess one offer and, when it passes, build the candidate the ranker accepts.
 *
 * `buildFacts` is injected rather than called from inside, which is what keeps
 * this module pure and what stops the facts of an EXCLUDED offer being gathered
 * at all — a restricted listing's merchant rating is not a thing this surface
 * should be reading.
 */
export function assessOfferEligibility(
  offer: Offer,
  context: OfferEligibilityContext,
  buildFacts: (offer: Offer) => OfferRankingFacts,
): OfferEligibilityVerdict {
  const { reasons, admission } = evaluateOfferEligibility(offer, context);
  if (reasons.length > 0) {
    return { eligible: false, offerId: offer.id, reasons, admission };
  }
  const admitted: EligibleOffer = {
    offerId: offer.id,
    kind: offer.kind,
    admission,
    facts: buildFacts(offer),
  };
  return { eligible: true, admitted };
}

/**
 * Assess a whole page, keeping the exclusions.
 *
 * The excluded list travels with the result rather than being discarded,
 * because "why is my offer not in this comparison" is the question the whole
 * separation exists to be able to answer — and an operator trace that had to
 * re-run the derivation to find out would be answering a different question
 * from the one the shopper's request produced.
 */
export function selectEligibleOffers(input: {
  readonly offers: readonly Offer[];
  readonly context: OfferEligibilityContext;
  readonly buildFacts: (offer: Offer) => OfferRankingFacts;
}): OfferEligibilitySelection {
  const eligible: EligibleOffer[] = [];
  const excluded: Extract<OfferEligibilityVerdict, { eligible: false }>[] = [];

  for (const offer of input.offers) {
    const verdict = assessOfferEligibility(offer, input.context, input.buildFacts);
    // `=== true` rather than a truthiness test, for the reason
    // `NativeCheckoutEligibility`'s docblock states: without `strictNullChecks`
    // the bare form does not narrow a boolean-literal discriminant reliably, and
    // the failure lands on the OTHER branch — where the union still carries the
    // eligible member and `verdict.reasons` does not exist.
    if (verdict.eligible === true) {
      eligible.push(verdict.admitted);
      continue;
    }
    excluded.push(verdict);
  }

  return { eligible, excluded };
}
