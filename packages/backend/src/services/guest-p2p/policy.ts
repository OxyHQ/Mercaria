/**
 * The guest-P2P eligibility policy: the criteria, what each one needs, and the
 * bounded scope a pilot would run under (#112).
 *
 * Pure data and pure functions. No database, no configuration, no clock — the
 * policy is what Mercaria has DECIDED, and `facts.ts` is what Mercaria can
 * observe. Keeping them in two files is what makes the whole policy readable in
 * one sitting and testable without a server.
 *
 * ## The registry must cover the vocabulary exactly
 *
 * `guest-p2p-policy.test.ts` walks {@link GUEST_P2P_CRITERIA} and asserts an
 * entry here for every member, and no entry for anything else — the
 * `merge-plan-census` device. A criterion cannot be published without being
 * evaluated, and cannot be evaluated without being published.
 *
 * ## The bounded scope is a CODE CONSTANT
 *
 * `MATCH_POLICY_KEY`, `CATALOG_BACKFILL_MAPPING_VERSION` and the retail pricing
 * policy key, for the same reason: the scope of a pilot is a published policy
 * somebody signed, not an incident lever. A table would let an operator widen a
 * value ceiling at 3am; an environment variable would let a deployment widen it
 * with no author and no date. Widening it here is a commit, which is #112's
 * "expansion requires a new recorded review, not automatic percentage
 * rollout".
 *
 * The values below are the LAUNCH COHORT #112 asks for, written down so the
 * decision can be reviewed against something concrete. They authorize nothing:
 * `authorization.ts` has no member meaning yes.
 */

import {
  GUEST_P2P_CRITERIA,
  GUEST_P2P_LISTING_CRITERIA,
  GUEST_P2P_SELLER_CRITERIA,
  type GuestP2PBoundedScope,
  type GuestP2PCriterion,
  type GuestP2PCriterionAvailability,
  type GuestP2PPublishedCriterion,
} from '@mercaria/shared-types';

/**
 * The policy's version.
 *
 * Every evaluation carries it, so a trace read next month says which rules
 * produced it. It moves whenever a criterion's availability or the bounded
 * scope below changes — the two things that alter what an evaluation means.
 */
export const GUEST_P2P_POLICY_VERSION = 'guest-p2p-2026-08-10';

/**
 * The scope a bounded pilot would run inside.
 *
 * One market, one currency, one fulfilment method, a low value ceiling, an
 * allow-list of categories and an exclusion list on top of it — #112's "Pilot
 * plan" 2–5 as values. The two category lists are BOTH present and both
 * consulted: an allow-list answers "is this in the cohort", an exclusion list
 * answers "is this a category no cohort may ever contain", and collapsing them
 * would let widening the first silently re-admit the second.
 *
 * `maxLineValueCurrency` exists because a cap without a currency is not a cap.
 * This domain performs no FX (a listing priced in another currency is
 * `unevaluable` rather than converted), so the ceiling and the price it bounds
 * are always the same unit.
 */
export const GUEST_P2P_BOUNDED_SCOPE: GuestP2PBoundedScope = {
  /** ADR 0001 D8's first market, and the only one this decision considers. */
  markets: ['ES'],
  /** The presentment currency the card rail already supports there. */
  currencies: ['EUR'],
  /** Shipping only. Pickup is #93's and fails closed everywhere else too. */
  fulfilmentMethods: ['standard'],
  /**
   * Deliberately EMPTY, and empty means NOTHING is permitted — the
   * `catalog_source_policies` grant semantics, not the
   * `CHECKOUT_DESTINATION_COUNTRIES` unrestricted-when-empty one. A cohort
   * whose categories nobody has chosen admits no listing, which is the correct
   * state for a policy under a no-go decision.
   */
  permittedCategorySlugs: [],
  /**
   * Categories no guest-P2P cohort may contain, whatever the allow-list says
   * (#112 listing eligibility 4). Slugs, matched against a listing's own slug
   * and every ancestor's, so excluding a parent excludes its subtree.
   */
  excludedCategorySlugs: [
    'alcohol',
    'tobacco',
    'vapes',
    'weapons',
    'knives',
    'ammunition',
    'adult',
    'medicines',
    'supplements',
    'medical-devices',
    'live-animals',
    'gift-cards',
    'tickets',
    'digital-goods',
    'currency',
    'precious-metals',
    'jewellery',
    'watches',
    'luxury-bags',
    'sneakers',
    'mobile-phones',
    'graphics-cards',
    'car-parts',
    'chemicals',
    'batteries',
    'drones',
    'car-keys',
    'locksmith-tools',
  ],
  /** €50.00, in EUR minor units. */
  maxLineValueMinorUnits: 5_000,
  maxLineValueCurrency: 'EUR',
  maxQuantityPerLine: 1,
  /** #112 listing eligibility 5: the buyer must see the actual item. */
  minEvidentialPhotos: 3,
  /** #112 seller eligibility 3, the transaction-history half. */
  minCompletedSales: 5,
  /**
   * #112 seller eligibility 3, the Trust half. Named tiers rather than a score
   * threshold: Mercaria reads Oxy Trust's verdict and computes none of its own
   * (#92 reputation rules 3 and 4), and a numeric bar here would be a second
   * reputation model.
   */
  permittedTrustTiers: ['trusted', 'established'],
};

/** What one criterion requires, and where its answer comes from. */
interface GuestP2PCriterionEntry {
  readonly kind: 'seller' | 'listing';
  /** The #112 sentence this criterion implements, quoted closely enough to find. */
  readonly requirement: string;
  readonly availability: GuestP2PCriterionAvailability;
}

/**
 * Every criterion, with the sentence it implements and where its answer comes
 * from.
 *
 * The `availability` field is the honest part. THREE criteria cannot be answered
 * from anything Mercaria holds, and each names the issue that owes it rather
 * than being quietly dropped or quietly passed. `policies_accepted` was a
 * fourth until #85 shipped the P2P acceptance surface; it is now `evaluated`
 * and still blocks a seller who has not accepted:
 *
 * - `messaging_available` — #110's post-purchase threads exist and the SELLER
 *   half is store-scoped (`requireStorePermission` on every merchant route), so
 *   a P2P seller has no surface on which to answer a buyer. Not merely unknown:
 *   established as absent, which is why the outcome is `refused`.
 * - `no_oxy_only_buyer_capability` — `refund.service.process` is scoped to a
 *   store and `/admin/stores/:storeId/orders/:id/refunds` is the only route
 *   that reaches it, so a P2P order has NO refund path for any actor
 *   (`services/buyer-requests/refund-bridge.ts`, which names the gap). A guest
 *   who could buy from a person could pay and never be refunded.
 * - `no_negotiation_or_offers` — Mercaria implements no negotiation, no
 *   counter-offer and no buyer-proposed price; `checkoutSchema` is `.strict()`
 *   and refuses `amount`, `currency`, `paid` and `paymentStatus` alike
 *   (`checkout-schema.test.ts`). The restriction has nothing to restrict, which
 *   is `nothing_to_restrict` and NOT a criterion somebody satisfied.
 *
 * `fulfilment_method_permitted` was a FIFTH, landing on `unevaluable` for a
 * pickup destination because #93 owned every meetup fact and there was nothing
 * to check a collection against. #93 SHIPPED, and the outcome moved to
 * `refused`: a collection from an individual has no publication and cannot
 * acquire one, so the honest answer is now "no" rather than "we cannot tell"
 * (`eligibility.ts` states it at the branch). Both block, so no checkout
 * changed — what changed is what an operator trace says.
 *
 * With #85 and #93 both landed, NO criterion is `unevaluable` by its
 * availability any more. The only route left is an unknown FACT — a rail that
 * is off, an Oxy Trust tier nobody scored, a seller with no profile row — and
 * `facts.ts` names the party who would supply each. That is the shape a verdict
 * of `unknown` describes today.
 */
const GUEST_P2P_CRITERION_REGISTRY: Readonly<Record<GuestP2PCriterion, GuestP2PCriterionEntry>> = {
  stripe_payout_ready: {
    kind: 'seller',
    requirement: 'Stripe connected-account and payout readiness.',
    availability: { state: 'evaluated' },
  },
  oxy_identity_state: {
    kind: 'seller',
    requirement: 'Required Oxy identity state.',
    availability: { state: 'evaluated' },
  },
  trust_or_transaction_history: {
    kind: 'seller',
    requirement: 'Sufficient Trust or transaction history under a transparent policy.',
    availability: { state: 'evaluated' },
  },
  no_active_restriction: {
    kind: 'seller',
    requirement: 'No active moderation or risk restriction.',
    availability: { state: 'evaluated' },
  },
  market_currency_fulfilment_supported: {
    kind: 'seller',
    requirement: 'Supported market, currency and fulfilment method.',
    availability: { state: 'evaluated' },
  },
  category_permitted: {
    kind: 'seller',
    requirement: 'Category allowed for guest P2P.',
    availability: { state: 'evaluated' },
  },
  condition_evidence_complete: {
    kind: 'seller',
    requirement: 'Condition evidence complete.',
    availability: { state: 'evaluated' },
  },
  policies_accepted: {
    kind: 'seller',
    requirement: 'Return, cancellation and dispute policy accepted.',
    // CLOSED by #85. The acceptance surface is `POST /seller/activation/policies`
    // and the row is `merchant_activation_policy_acceptances` with
    // `owner_type = 'user'` — a person selling a bicycle has no store, which is
    // exactly why #88 recorded this as #85's rather than widening its own
    // store-scoped acceptance. An unaccepted policy still BLOCKS; what changed
    // is that the seller can now do something about it.
    availability: { state: 'evaluated' },
  },
  messaging_available: {
    kind: 'seller',
    requirement: 'Messaging availability.',
    availability: { state: 'capability_missing', owner: '#110' },
  },
  no_oxy_only_buyer_capability: {
    kind: 'seller',
    requirement:
      'No required buyer capability that exists only for authenticated Oxy users.',
    availability: { state: 'capability_missing', owner: '#110' },
  },
  fixed_price_only: {
    kind: 'listing',
    requirement: 'Fixed-price listings only.',
    availability: { state: 'evaluated' },
  },
  fulfilment_method_permitted: {
    kind: 'listing',
    requirement: 'Shipping only or pickup only, based on measured safety.',
    availability: { state: 'evaluated' },
  },
  value_within_cap: {
    kind: 'listing',
    requirement: 'Low-value caps.',
    availability: { state: 'evaluated' },
  },
  category_not_excluded: {
    kind: 'listing',
    requirement:
      'Exclusion of regulated, age-restricted, high-counterfeit or high-fraud categories.',
    availability: { state: 'evaluated' },
  },
  actual_item_photos_present: {
    kind: 'listing',
    requirement: 'Required actual-item photos.',
    availability: { state: 'evaluated' },
  },
  normalized_condition_and_defects: {
    kind: 'listing',
    requirement: 'Required normalized condition and defects.',
    availability: { state: 'evaluated' },
  },
  no_negotiation_or_offers: {
    kind: 'listing',
    requirement: 'No negotiation or offer messaging initially.',
    availability: {
      state: 'nothing_to_restrict',
      reason:
        'Mercaria implements no negotiation, counter-offer or buyer-proposed price; ' +
        'checkoutSchema is .strict() and refuses every money field.',
    },
  },
  quantity_one: {
    kind: 'listing',
    requirement: 'Quantity one.',
    availability: { state: 'evaluated' },
  },
  domestic_only: {
    kind: 'listing',
    requirement: 'No international P2P at first.',
    availability: { state: 'evaluated' },
  },
  no_mixed_store_and_p2p_payment: {
    kind: 'listing',
    requirement:
      'No mixed store and P2P payment unless #43 supports the liability model clearly.',
    availability: { state: 'evaluated' },
  },
};

/** One criterion's registry entry. */
export function guestP2PCriterionEntry(criterion: GuestP2PCriterion): GuestP2PCriterionEntry {
  return GUEST_P2P_CRITERION_REGISTRY[criterion];
}

/**
 * The whole policy, in the published order: seller criteria first, then
 * listing criteria, each in #112's own numbering.
 *
 * Built from the two tuples rather than from the registry's key order, because
 * object key order is not a contract and an operator reading this against the
 * issue should be able to go line by line.
 */
export function publishedGuestP2PCriteria(): readonly GuestP2PPublishedCriterion[] {
  return [...GUEST_P2P_SELLER_CRITERIA, ...GUEST_P2P_LISTING_CRITERIA].map((criterion) => {
    const entry = GUEST_P2P_CRITERION_REGISTRY[criterion];
    return {
      criterion,
      kind: entry.kind,
      requirement: entry.requirement,
      availability: entry.availability,
    };
  });
}

/** Every criterion in the registry, for the census test. */
export function registeredGuestP2PCriteria(): readonly GuestP2PCriterion[] {
  return Object.keys(GUEST_P2P_CRITERION_REGISTRY) as GuestP2PCriterion[];
}

/**
 * Whether a listing's own slug or any ancestor's is in a policy list.
 *
 * `listings.category_slugs` is the category's slug plus every ancestor's,
 * denormalized by the catalogue for exactly this kind of question, so a policy
 * naming a parent covers its whole subtree with no traversal here.
 */
export function categorySlugsIntersect(
  slugs: readonly string[],
  policyList: readonly string[],
): boolean {
  if (policyList.length === 0 || slugs.length === 0) return false;
  const wanted = new Set(policyList);
  return slugs.some((slug) => wanted.has(slug));
}

/** Every criterion the vocabulary defines, in published order. */
export const GUEST_P2P_ALL_CRITERIA: readonly GuestP2PCriterion[] = GUEST_P2P_CRITERIA;
