/**
 * The guest-P2P eligibility derivation — pure, and it reads nothing (#112).
 *
 * `getRetailEligibility`'s shape (#121) and its rule: this module imports no
 * repository, no configuration and no clock, and
 * `guest-p2p-isolation.test.ts` fails the build if it starts to. Every input
 * arrives as {@link GuestP2PFacts}, which `facts.ts` builds, so each of the
 * twenty criteria is a table row in a unit test rather than a fixture with a
 * server behind it.
 *
 * ## Absence is never a pass, and it is never a fail either
 *
 * Three outcomes, and the middle one carries the weight. `unevaluable` means
 * Mercaria does not hold the input — an unscored Oxy Trust tier, a listing
 * priced in a currency the cohort does not name, a pickup destination #93 owns.
 * It BLOCKS, and it is kept apart from `refused` because the two route
 * differently: one names somebody who owes an input, the other is a decision
 * Mercaria made about a record it read.
 *
 * ## The asymmetry with #92, stated because it looks like an inconsistency
 *
 * `seller-visibility.ts` lets an ABSENT Oxy Trust signal restrict nothing —
 * withholding on absence would turn a reputation-service outage into a
 * marketplace-wide delisting. Here an absent signal BLOCKS. Both are correct
 * because the fallbacks differ: there, the alternative to showing the seller is
 * hiding them from everyone; here, the alternative to admitting a guest is
 * asking that one buyer to sign in, which costs them a sign-in and costs the
 * seller nothing (the sale is still available to every authenticated buyer).
 * The same reasoning #125 used for an absent supplier balance.
 */

import {
  GUEST_P2P_LISTING_CRITERIA,
  GUEST_P2P_SELLER_CRITERIA,
  type GuestP2PCriterion,
  type GuestP2PCriterionOutcome,
  type GuestP2PEligibility,
  type GuestP2PMissingInputOwner,
  type GuestP2PVerdict,
  type SellerProfileVisibility,
} from '@mercaria/shared-types';
import {
  GUEST_P2P_BOUNDED_SCOPE,
  GUEST_P2P_POLICY_VERSION,
  categorySlugsIntersect,
  guestP2PCriterionEntry,
} from './policy.js';

/**
 * A fact Mercaria either holds or does not.
 *
 * A STRING discriminant (`strict: false` — see `refusal.ts`'s siblings), and
 * the absent branch has NO `value` property, so an unknown cannot be summed,
 * compared or defaulted without the coercion being written out loud.
 */
export type GuestP2PSignal<T> =
  | { readonly known: 'yes'; readonly value: T }
  | { readonly known: 'no'; readonly owner: GuestP2PMissingInputOwner };

/** A known fact. */
export function known<T>(value: T): GuestP2PSignal<T> {
  return { known: 'yes', value };
}

/** A fact Mercaria does not hold, and who would supply it. */
export function unknown<T>(owner: GuestP2PMissingInputOwner): GuestP2PSignal<T> {
  return { known: 'no', owner };
}

/**
 * The checkout dimensions a listing's eligibility depends on but a listing does
 * not carry.
 *
 * Required rather than optional: a caller with no real checkout has to state
 * the context it is asking about, and the operator trace does exactly that with
 * a NAMED constant it echoes back. An optional field would let "we did not say"
 * quietly become "domestic, quantity one, nothing else in the cart".
 */
export interface GuestP2PCheckoutContext {
  /** Units of this listing in the checkout. */
  readonly quantity: number;
  /** Where the goods are going — the resolved destination's ISO-3166 alpha-2. */
  readonly destinationCountry: string;
  /** The presentment currency the buyer is being charged in. */
  readonly presentmentCurrency: string;
  /** The resolved fulfilment kind. `pickup` is #93's and cannot be evaluated. */
  readonly fulfilment: 'shipping' | 'pickup';
  /** The fulfilment method chosen for this seller's group. */
  readonly shippingMethod: string;
  /**
   * Whether this checkout also contains a store or platform seller.
   *
   * #112 listing eligibility 10. A Mercaria checkout opens ONE PaymentIntent
   * per checkout GROUP across every seller in it (ADR 0001 D3/D4), so a mixed
   * cart puts a store's money and an individual's money on one charge. #43
   * (ADR 0001) settled the general liability model and settled it AGAINST this
   * case: separate charges and transfers makes Mercaria responsible for a
   * connected account's negative balance (fact 2), and D7 leaves it eating a
   * reversal an individual cannot cover. Nothing bounds that exposure.
   */
  readonly checkoutContainsNonP2PSeller: boolean;
}

/** Everything the derivation reads. Built by `facts.ts`; never read from here. */
export interface GuestP2PFacts {
  readonly sellerKey: string;
  readonly listingId: string;
  /** ADR 0001 D9's ONE stored verdict. Absent when no rail is configured. */
  readonly payoutReady: GuestP2PSignal<boolean>;
  /** #92's derived verdict for the seller's Oxy account. */
  readonly sellerVisibility: GuestP2PSignal<SellerProfileVisibility>;
  /** Oxy Trust's tier. Mercaria computes none of its own. */
  readonly trustTier: GuestP2PSignal<string>;
  /** Orders this seller has actually completed. */
  readonly completedSales: GuestP2PSignal<number>;
  /** The connected account's country — the seller's market, as Stripe holds it. */
  readonly sellerPayoutCountry: GuestP2PSignal<string>;
  /**
   * Whether this seller has accepted the CURRENT P2P return, cancellation and
   * dispute policy — #85's acceptance surface, which is what closes the one
   * criterion #112 could not evaluate.
   *
   * A `GuestP2PSignal` rather than a bare boolean because "no acceptance row"
   * and "accepted an older version" are both answerable facts while "this
   * deployment publishes no such policy" would not be — and the discipline of
   * this file is that an absent input names its owner rather than defaulting.
   */
  readonly sellerPoliciesAccepted: GuestP2PSignal<boolean>;
  /** `listings.status === 'active'`. */
  readonly listingActive: boolean;
  /** `listings.status === 'restricted'` — what a CrowdSource enforcement writes. */
  readonly listingRestricted: boolean;
  /** The listing's own category slug plus every ancestor's. */
  readonly categorySlugs: readonly string[];
  /** The #90 assertion is a refined one (not `migrated_binary`/`legacy_client_binary`). */
  readonly conditionRefined: boolean;
  /** `listings.condition_acknowledged_at` is set (#90 policy rule 2). */
  readonly conditionAcknowledged: boolean;
  /** Rows in `listing_condition_details` — the disclosed defects and missing parts. */
  readonly conditionDetailCount: number;
  /** Photos in an EVIDENTIAL moderation state (#90). */
  readonly evidentialPhotoCount: number;
  /** The variant's native unit price. Absent when the variant carries none. */
  readonly unitPrice: GuestP2PSignal<{ readonly amount: number; readonly currency: string }>;
  readonly context: GuestP2PCheckoutContext;
}

/**
 * Derive one listing's guest-P2P eligibility.
 *
 * The criteria are evaluated in published order and every one produces exactly
 * one outcome — there is no early return, because an operator needs the whole
 * list to know what it would take, and a short-circuit would make the answer
 * depend on which criterion happens to be first.
 */
export function deriveGuestP2PEligibility(facts: GuestP2PFacts): GuestP2PEligibility {
  const criteria = [...GUEST_P2P_SELLER_CRITERIA, ...GUEST_P2P_LISTING_CRITERIA].map((criterion) =>
    evaluateCriterion(criterion, facts),
  );
  return {
    listingId: facts.listingId,
    sellerKey: facts.sellerKey,
    policyVersion: GUEST_P2P_POLICY_VERSION,
    verdict: deriveVerdict(criteria),
    criteria,
  };
}

/**
 * `ineligible` beats `unknown` beats `eligible` — `deriveRetailCompleteness`'s
 * severity rule, applied to a verdict.
 *
 * An EMPTY criterion list would answer `eligible`, which is why nothing may
 * call this with one: `deriveGuestP2PEligibility` builds the list from the
 * published tuples, and the census test asserts both tuples are non-empty and
 * cover the registry. A vacuity floor on the one function that could otherwise
 * pass by measuring nothing.
 */
function deriveVerdict(criteria: readonly GuestP2PCriterionOutcome[]): GuestP2PVerdict {
  if (criteria.length === 0) {
    throw new Error('A guest-P2P verdict cannot be derived from an empty criterion list');
  }
  if (criteria.some((entry) => entry.outcome === 'refused')) return 'ineligible';
  if (criteria.some((entry) => entry.outcome === 'unevaluable')) return 'unknown';
  return 'eligible';
}

/** `satisfied` or `refused`, from a plain boolean the caller has already decided. */
function verdictOf(criterion: GuestP2PCriterion, satisfied: boolean): GuestP2PCriterionOutcome {
  return satisfied ? { criterion, outcome: 'satisfied' } : { criterion, outcome: 'refused' };
}

/** `unevaluable`, naming who would supply the input. */
function blocked(
  criterion: GuestP2PCriterion,
  owner: GuestP2PMissingInputOwner,
): GuestP2PCriterionOutcome {
  return { criterion, outcome: 'unevaluable', owner };
}

/**
 * One criterion.
 *
 * The registry is consulted FIRST, so a criterion whose input or capability is
 * missing can never be answered from a fact somebody happened to supply — the
 * availability is the policy's statement about the criterion and the facts are
 * only consulted for the ones it marks `evaluated`.
 */
function evaluateCriterion(
  criterion: GuestP2PCriterion,
  facts: GuestP2PFacts,
): GuestP2PCriterionOutcome {
  const { availability } = guestP2PCriterionEntry(criterion);
  switch (availability.state) {
    case 'input_missing':
      return blocked(criterion, availability.owner);
    case 'capability_missing':
      // Established as absent, not merely unknown: the capability does not
      // exist, so the criterion is false rather than unanswered.
      return { criterion, outcome: 'refused' };
    case 'nothing_to_restrict':
      return { criterion, outcome: 'satisfied' };
    case 'evaluated':
      return evaluateFromFacts(criterion, facts);
  }
}

/** The twenty-minus-four criteria a record can answer. */
function evaluateFromFacts(
  criterion: GuestP2PCriterion,
  facts: GuestP2PFacts,
): GuestP2PCriterionOutcome {
  const scope = GUEST_P2P_BOUNDED_SCOPE;
  switch (criterion) {
    case 'stripe_payout_ready':
      // A rail that is off cannot answer whether anybody is ready for it; a
      // rail that is on and reports `false` is a seller who has not finished
      // onboarding, which is a fact.
      return facts.payoutReady.known === 'no'
        ? blocked(criterion, facts.payoutReady.owner)
        : verdictOf(criterion, facts.payoutReady.value);

    case 'oxy_identity_state':
      // Only a fully visible Oxy account. `private` and `restricted` are both
      // refusals and are not distinguished here — #92 keeps them apart for the
      // seller's own page, and repeating the distinction in an eligibility
      // trace would republish Oxy Trust's opinion of somebody who asked to be
      // hidden.
      return facts.sellerVisibility.known === 'no'
        ? blocked(criterion, facts.sellerVisibility.owner)
        : verdictOf(criterion, facts.sellerVisibility.value === 'visible');

    case 'trust_or_transaction_history':
      return evaluateTrustOrHistory(criterion, facts);

    case 'no_active_restriction':
      // `restricted` is what a CrowdSource enforcement writes, and every
      // catalogue read already filters `active`; both are asserted rather than
      // one being inferred from the other, because a future status would
      // otherwise be admitted by silence.
      return verdictOf(criterion, facts.listingActive && !facts.listingRestricted);

    case 'market_currency_fulfilment_supported':
      return evaluateMarketCurrencyFulfilment(criterion, facts);

    case 'category_permitted':
      // An EMPTY allow-list permits NOTHING (the grant semantics, not the
      // unrestricted-when-empty ones) — `categorySlugsIntersect` answers false
      // for an empty policy list, so a cohort whose categories nobody chose
      // admits no listing.
      return verdictOf(
        criterion,
        categorySlugsIntersect(facts.categorySlugs, scope.permittedCategorySlugs),
      );

    case 'condition_evidence_complete':
      // The SELLER half of #90: they acknowledged what was disclosed, at a
      // point in time. A refined key with nobody's acknowledgement behind it is
      // a taxonomy value, not evidence.
      return verdictOf(criterion, facts.conditionAcknowledged);

    case 'fixed_price_only':
      // Mercaria has no auction; what this criterion can actually fail on is a
      // variant with no price at all, which `nativeUnitPrice` refuses at
      // checkout for the same reason.
      return facts.unitPrice.known === 'no'
        ? blocked(criterion, facts.unitPrice.owner)
        : { criterion, outcome: 'satisfied' };

    case 'fulfilment_method_permitted':
      // #93 CLOSED this, and the outcome moved from `unevaluable` to `refused`.
      //
      // #112 wrote it as `unevaluable`/owner #93 because a collection had no
      // publication state, no freshness and no per-location hours anywhere in
      // the schema, so there was nothing to check it against. #93 supplies all
      // three — and supplies them for a STORE's `locations` row. A collection
      // from an individual has no publication and cannot acquire one, and
      // `derivePickupEligibility` refuses a `user` seller for EVERY actor, so
      // the honest answer is now "no" rather than "we cannot tell".
      //
      // Both outcomes block, so no guest checkout changes; what changes is what
      // an operator trace says, and "we cannot tell" would now be false. The
      // fact is stated here rather than imported: this module reads no
      // repository and answers from the criterion's own context, and a P2P
      // group's seller being a person is the whole of what decides it.
      if (facts.context.fulfilment === 'pickup') return { criterion, outcome: 'refused' };
      return verdictOf(criterion, scope.fulfilmentMethods.includes(facts.context.shippingMethod));

    case 'value_within_cap':
      return evaluateValueCap(criterion, facts);

    case 'category_not_excluded':
      return verdictOf(
        criterion,
        !categorySlugsIntersect(facts.categorySlugs, scope.excludedCategorySlugs),
      );

    case 'actual_item_photos_present':
      return verdictOf(criterion, facts.evidentialPhotoCount >= scope.minEvidentialPhotos);

    case 'normalized_condition_and_defects':
      // The LISTING half of #90: a refined key AND at least one disclosed
      // detail. An unrefined assertion (`migrated_binary`, a v1 client's
      // binary) is a coarse value nobody looked at since, and a listing with no
      // detail row has disclosed no defects — which for a used item is a claim,
      // not an absence.
      return verdictOf(criterion, facts.conditionRefined && facts.conditionDetailCount > 0);

    case 'quantity_one':
      return verdictOf(criterion, facts.context.quantity <= scope.maxQuantityPerLine);

    case 'domestic_only':
      return facts.sellerPayoutCountry.known === 'no'
        ? blocked(criterion, facts.sellerPayoutCountry.owner)
        : verdictOf(criterion, facts.sellerPayoutCountry.value === facts.context.destinationCountry);

    case 'policies_accepted':
      // #85 supplies the acceptance; #112 decides what it is worth. An absent
      // acceptance is the SELLER's gap and blocks, which is the same answer the
      // criterion gave before #85 existed — what changed is that a seller can
      // now do something about it.
      return facts.sellerPoliciesAccepted.known === 'no'
        ? blocked(criterion, facts.sellerPoliciesAccepted.owner)
        : verdictOf(criterion, facts.sellerPoliciesAccepted.value);

    case 'no_mixed_store_and_p2p_payment':
      return verdictOf(criterion, !facts.context.checkoutContainsNonP2PSeller);

    default:
      // Unreachable: every `evaluated` criterion has a case above, and
      // `guest-p2p-policy.test.ts` drives all twenty through this function. A
      // throw rather than a default outcome, because a criterion nobody
      // implemented must not read as a pass OR as a refusal somebody decided.
      throw new Error(`No guest-P2P evaluation for criterion ${criterion}`);
  }
}

/**
 * #112 seller eligibility 3: Trust OR transaction history, under a policy that
 * says which.
 *
 * A disjunction, so a seller with a long clean history and no Trust tier is not
 * refused for Oxy's silence, and a newly-scored trusted account is not refused
 * for having sold nothing. It is `unevaluable` only when NEITHER side answers —
 * an unread Trust tier beside an unread order count is the case where Mercaria
 * genuinely knows nothing about this person's record.
 */
function evaluateTrustOrHistory(
  criterion: GuestP2PCriterion,
  facts: GuestP2PFacts,
): GuestP2PCriterionOutcome {
  const scope = GUEST_P2P_BOUNDED_SCOPE;
  const trustSatisfied =
    facts.trustTier.known === 'yes' && scope.permittedTrustTiers.includes(facts.trustTier.value);
  const historySatisfied =
    facts.completedSales.known === 'yes' && facts.completedSales.value >= scope.minCompletedSales;
  if (trustSatisfied || historySatisfied) return { criterion, outcome: 'satisfied' };
  if (facts.trustTier.known === 'no' && facts.completedSales.known === 'no') {
    return blocked(criterion, facts.trustTier.owner);
  }
  return { criterion, outcome: 'refused' };
}

/**
 * #112 seller eligibility 5, all three dimensions at once.
 *
 * ONE criterion rather than three, because #112 states it as one and because
 * splitting it would give a client three inputs to vary where the remedy is the
 * same for all of them. The seller's market is the connected account's country
 * — the only market fact Mercaria holds about a person.
 */
function evaluateMarketCurrencyFulfilment(
  criterion: GuestP2PCriterion,
  facts: GuestP2PFacts,
): GuestP2PCriterionOutcome {
  const scope = GUEST_P2P_BOUNDED_SCOPE;
  if (facts.sellerPayoutCountry.known === 'no') {
    return blocked(criterion, facts.sellerPayoutCountry.owner);
  }
  return verdictOf(
    criterion,
    scope.markets.includes(facts.sellerPayoutCountry.value) &&
      scope.currencies.includes(facts.context.presentmentCurrency) &&
      scope.fulfilmentMethods.includes(facts.context.shippingMethod),
  );
}

/**
 * #112 listing eligibility 3, and the reason this domain does no FX.
 *
 * A ceiling is compared against a price in the SAME currency or not at all.
 * Converting here would put a rate — and therefore a moment in time — inside a
 * safety bound, so a listing that was inside the cap this morning could be
 * outside it this afternoon with nothing about the listing having changed. A
 * price in another currency is `unevaluable`, which blocks, and the cohort's
 * single-currency scope is what makes that a narrow case rather than a wall.
 */
function evaluateValueCap(
  criterion: GuestP2PCriterion,
  facts: GuestP2PFacts,
): GuestP2PCriterionOutcome {
  const scope = GUEST_P2P_BOUNDED_SCOPE;
  if (facts.unitPrice.known === 'no') return blocked(criterion, facts.unitPrice.owner);
  if (facts.unitPrice.value.currency !== scope.maxLineValueCurrency) {
    return blocked(criterion, 'deployment');
  }
  const lineValue = facts.unitPrice.value.amount * facts.context.quantity;
  return verdictOf(criterion, lineValue <= scope.maxLineValueMinorUnits);
}
