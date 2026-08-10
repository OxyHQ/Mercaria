/**
 * Guest checkout from an individual (P2P) seller — the POLICY vocabulary (#112).
 *
 * ADR 0003 D18 and ADR 0006 G18 excluded P2P from guest checkout at launch and
 * assigned the evidence gate to #112. #112's recorded outcome is **no-go**
 * (`docs/guest-p2p/2026-08-10-guest-p2p-checkout-decision.md`), so nothing here
 * enables anything. What it adds is the part the ADRs deferred: the eligibility
 * criteria written down as a CLOSED vocabulary, each one evaluable or explicitly
 * not, so a future approval is a policy publication rather than an invention.
 *
 * ## Why the criteria are a type and not a checklist in a document
 *
 * A document cannot fail a build. The two tuples below are the seller and
 * listing criteria from #112 one-to-one, and the backend's registry
 * (`services/guest-p2p/policy.ts`) must carry an entry for every member —
 * a census test fails otherwise, so a criterion cannot be added to the policy
 * and silently never evaluated, and one cannot be evaluated without appearing
 * in the published policy.
 *
 * ## The prohibitions are VALUES, disjoint from the criteria
 *
 * {@link GUEST_P2P_FORBIDDEN_CRITERIA} names the ten inputs that may NEVER make
 * a P2P group guest-eligible — a public buyer identity, a reusable handle, a
 * reputation score Mercaria computed about a guest, a card fingerprint, paid
 * placement, a ranking penalty for guest status, an auto-created Oxy account.
 * The house device (`RETAIL_FORBIDDEN_COMPONENT_KINDS`,
 * `SEARCH_FORBIDDEN_RELEVANCE_SIGNALS`): two DISJOINT unions, gated by a test,
 * so a plausible-looking future addition fails the build instead of being
 * reviewed on its wording.
 *
 * ## Three outcomes, and two of the three BLOCK
 *
 * `satisfied` is the only one that admits. `refused` is a fact Mercaria can
 * state; `unevaluable` is Mercaria not holding the input — never a soft yes,
 * never imputed, and never averaged away. Which of the two a criterion lands on
 * is information for an operator, not for a buyer: a refusal that reaches a
 * client is ONE reason code for every criterion, so a client cannot vary one
 * input at a time and read out the switchboard.
 */

/**
 * Whether a P2P seller may sell to a guest — #112 "Seller eligibility", in the
 * issue's own order.
 *
 * The names are Mercaria's rather than the issue's prose, but the mapping is
 * one-to-one and the registry entry for each cites the sentence it implements.
 */
export const GUEST_P2P_SELLER_CRITERIA = [
  /** 1. Stripe connected-account and payout readiness (ADR 0001 D9). */
  'stripe_payout_ready',
  /** 2. Required Oxy identity state — the #92 visibility verdict. */
  'oxy_identity_state',
  /** 3. Sufficient Trust or transaction history under a transparent policy. */
  'trust_or_transaction_history',
  /** 4. No active moderation or risk restriction. */
  'no_active_restriction',
  /** 5. Supported market, currency and fulfilment method. */
  'market_currency_fulfilment_supported',
  /** 6. Category allowed for guest P2P. */
  'category_permitted',
  /** 7. Condition evidence complete (#90). */
  'condition_evidence_complete',
  /** 8. Return, cancellation and dispute policy accepted. */
  'policies_accepted',
  /** 9. Messaging availability — the seller can answer the buyer. */
  'messaging_available',
  /** 10. No required buyer capability that exists only for authenticated Oxy users. */
  'no_oxy_only_buyer_capability',
] as const;

/** One of {@link GUEST_P2P_SELLER_CRITERIA}. */
export type GuestP2PSellerCriterion = (typeof GUEST_P2P_SELLER_CRITERIA)[number];

/**
 * Whether one listing may be bought by a guest — #112 "Listing and category
 * eligibility", in the issue's own order.
 */
export const GUEST_P2P_LISTING_CRITERIA = [
  /** 1. Fixed-price listings only. */
  'fixed_price_only',
  /** 2. Shipping only or pickup only, based on measured safety (#93 owns pickup). */
  'fulfilment_method_permitted',
  /** 3. Low-value caps. */
  'value_within_cap',
  /** 4. Exclusion of regulated, age-restricted, high-counterfeit or high-fraud categories. */
  'category_not_excluded',
  /** 5. Required actual-item photos (#90 evidence, seller-owned provenance). */
  'actual_item_photos_present',
  /** 6. Required normalized condition and defects (#90). */
  'normalized_condition_and_defects',
  /** 7. No negotiation or offer messaging initially. */
  'no_negotiation_or_offers',
  /** 8. Quantity one. */
  'quantity_one',
  /** 9. No international P2P at first. */
  'domestic_only',
  /** 10. No mixed store and P2P payment unless #43 supports the liability model. */
  'no_mixed_store_and_p2p_payment',
] as const;

/** One of {@link GUEST_P2P_LISTING_CRITERIA}. */
export type GuestP2PListingCriterion = (typeof GUEST_P2P_LISTING_CRITERIA)[number];

/** Every criterion the guest-P2P policy may consider, seller and listing alike. */
export const GUEST_P2P_CRITERIA = [
  ...GUEST_P2P_SELLER_CRITERIA,
  ...GUEST_P2P_LISTING_CRITERIA,
] as const;

/** One of {@link GUEST_P2P_CRITERIA}. */
export type GuestP2PCriterion = (typeof GUEST_P2P_CRITERIA)[number];

/**
 * Inputs that may NEVER decide guest-P2P eligibility.
 *
 * DISJOINT from {@link GUEST_P2P_CRITERIA} by a test, so this is a prohibition
 * the compiler and the build hold rather than a paragraph somebody has to
 * remember. Each member is one of #112's identity, communication or ranking
 * rules stated as the thing it forbids:
 *
 * - the first five are #112 "Identity and communication design" 1–3 and 8, plus
 *   ADR 0003 I2 (email, card fingerprint and device traits are not credentials
 *   and not correlation keys);
 * - `seller_paid_placement` and `guest_status_ranking_penalty` are #112 seller
 *   eligibility's closing sentence — guest status may not worsen a seller's
 *   organic ranking, and eligibility may not be bought;
 * - `auto_created_oxy_account` is #112 default state 5 and ADR 0003's
 *   no-synthetic-Oxy-users rule: eligibility may not be manufactured by turning
 *   the buyer into an account holder behind their back;
 * - `seller_direct_contact_exchange` is identity rule 4 — the seller may not
 *   open off-platform contact from the buyer's address, so "we can email each
 *   other" can never be the reason a sale is permitted;
 * - `seller_self_attestation` is the residual: a seller declaring themselves
 *   ready is not evidence, and every criterion above cites a record.
 */
export const GUEST_P2P_FORBIDDEN_CRITERIA = [
  'buyer_public_identity',
  'reusable_buyer_handle',
  'guest_trust_score',
  'buyer_email_domain',
  'buyer_card_fingerprint',
  'seller_paid_placement',
  'guest_status_ranking_penalty',
  'auto_created_oxy_account',
  'seller_direct_contact_exchange',
  'seller_self_attestation',
] as const;

/** One of {@link GUEST_P2P_FORBIDDEN_CRITERIA}. */
export type GuestP2PForbiddenCriterion = (typeof GUEST_P2P_FORBIDDEN_CRITERIA)[number];

/**
 * Who would supply an input, or a capability, this policy does not hold.
 *
 * A CLOSED set rather than free text, so "who would close this" is answerable
 * by a reader with no context and cannot decay into a sentence. Three members
 * are open issues in this repository; three are not, and naming those honestly
 * is better than attributing a service outage, an unconfigured rail or a seller
 * who has not onboarded to an issue that would not fix any of them.
 *
 * Every member is REACHABLE — something in `policy.ts` or `facts.ts` produces
 * it. #43 (the payment-liability ADR, decided) and #111 (the guest rollout) are
 * deliberately absent: both are named in the decision document because they
 * shape the outcome, and neither owes this policy an INPUT it could evaluate,
 * so a member for either would be a value nothing can return.
 */
export const GUEST_P2P_MISSING_INPUT_OWNERS = [
  /** Merchant/seller activation for guest checkout, and the P2P policy-acceptance surface. */
  '#85',
  /** Location-aware inventory, nearby discovery and pickup — every meetup fact. */
  '#93',
  /** Buyer post-purchase requests: the P2P refund path and the P2P seller's own surface. */
  '#110',
  /**
   * Oxy owns the record and it did not answer — an unscored Trust tier, an
   * unreadable profile. Mercaria computes no substitute (#92 reputation rules
   * 3 and 4), so the criterion is unknown rather than failed.
   */
  'oxy',
  /**
   * This deployment supplies nothing to evaluate against — the card rail is
   * off, or the bounded scope names no value for the dimension. Not the
   * seller's doing and not a gap any issue closes.
   */
  'deployment',
  /**
   * The SELLER has not supplied it — no connected account, no priced variant,
   * no seller profile. Kept apart from `deployment` because the remedy is
   * theirs and the criterion that reports it is usually accompanied by one
   * that refuses outright.
   */
  'seller',
] as const;

/** One of {@link GUEST_P2P_MISSING_INPUT_OWNERS}. */
export type GuestP2PMissingInputOwner = (typeof GUEST_P2P_MISSING_INPUT_OWNERS)[number];

/**
 * How one criterion came out.
 *
 * A STRING discriminant, not `satisfied: boolean` — the backend compiles with
 * `strict: false`, where TypeScript does not narrow a union on a boolean
 * literal, so a boolean discriminant leaves every consumer holding the whole
 * union (the #68 finding, re-hit by #110).
 *
 * `unevaluable` carries the owner and NO value property, so "we do not know"
 * cannot be read as a number, a yes or a no without writing the coercion out
 * loud. `refused` carries no detail at all: a per-criterion sentence is what a
 * buyer-facing switchboard is made of, and an operator reads the criterion
 * NAME, which is already here.
 */
export type GuestP2PCriterionOutcome =
  | { readonly criterion: GuestP2PCriterion; readonly outcome: 'satisfied' }
  | { readonly criterion: GuestP2PCriterion; readonly outcome: 'refused' }
  | {
      readonly criterion: GuestP2PCriterion;
      readonly outcome: 'unevaluable';
      readonly owner: GuestP2PMissingInputOwner;
    };

/**
 * The verdict over a whole group, three-valued.
 *
 * The `getRetailEligibility` shape and the same severity rule: `ineligible`
 * beats `unknown` beats `eligible`, and neither of the first two may check out.
 * They are kept apart because they route differently — `unknown` is a gap in
 * Mercaria's information and names who owes it, `ineligible` is a decision
 * Mercaria made about a real record.
 */
export const GUEST_P2P_VERDICTS = ['eligible', 'ineligible', 'unknown'] as const;

/** One of {@link GUEST_P2P_VERDICTS}. */
export type GuestP2PVerdict = (typeof GUEST_P2P_VERDICTS)[number];

/**
 * One evaluated subject: a seller group's listing, with every criterion's
 * outcome and the verdict derived from them.
 *
 * Carries no buyer field of any kind — no session, no contact, no order — and
 * the operator surface that serves it opens from a LISTING id. "Show me what
 * this guest tried to buy" is not a question this shape can answer.
 */
export interface GuestP2PEligibility {
  readonly listingId: string;
  readonly sellerKey: string;
  readonly policyVersion: string;
  readonly verdict: GuestP2PVerdict;
  readonly criteria: readonly GuestP2PCriterionOutcome[];
}

/**
 * Why a criterion is not simply computed from data.
 *
 * Four states, and only one of them admits without reading anything:
 *
 * - `evaluated` — computed from a record. May still come out `unevaluable` when
 *   the record is absent (an unread Oxy Trust tier, a pickup destination #93
 *   owns), which is the not-applicable branch that BLOCKS rather than passing.
 * - `input_missing` — Mercaria holds no input at all; outcome `unevaluable`.
 * - `capability_missing` — Mercaria has established the capability does not
 *   exist, so the criterion is not merely unknown but false; outcome `refused`.
 * - `nothing_to_restrict` — the restriction is vacuous because the capability
 *   it restricts does not exist in this product; outcome `satisfied`, with the
 *   reason stated so it is re-derived if the capability ever ships.
 */
export type GuestP2PCriterionAvailability =
  | { readonly state: 'evaluated' }
  | { readonly state: 'input_missing'; readonly owner: GuestP2PMissingInputOwner }
  | { readonly state: 'capability_missing'; readonly owner: GuestP2PMissingInputOwner }
  | { readonly state: 'nothing_to_restrict'; readonly reason: string };

/** One criterion as the published policy describes it. */
export interface GuestP2PPublishedCriterion {
  readonly criterion: GuestP2PCriterion;
  readonly kind: 'seller' | 'listing';
  /** The #112 sentence this criterion implements. */
  readonly requirement: string;
  readonly availability: GuestP2PCriterionAvailability;
}

/**
 * The bounded scope a pilot WOULD run under, published so it is reviewable
 * before anybody is asked to approve it.
 *
 * Values, not toggles: nothing in this shape can be flipped at runtime, because
 * it is rendered from a code constant. #112 "Expansion requires a new recorded
 * review, not automatic percentage rollout" is that property — widening the
 * scope is a commit with an author and a date, not a configuration change.
 */
export interface GuestP2PBoundedScope {
  readonly markets: readonly string[];
  readonly currencies: readonly string[];
  readonly fulfilmentMethods: readonly string[];
  readonly permittedCategorySlugs: readonly string[];
  readonly excludedCategorySlugs: readonly string[];
  readonly maxLineValueMinorUnits: number;
  readonly maxLineValueCurrency: string;
  readonly maxQuantityPerLine: number;
  readonly minEvidentialPhotos: number;
  readonly minCompletedSales: number;
  readonly permittedTrustTiers: readonly string[];
}

/**
 * What `/internal/guest-commerce/p2p/policy` answers.
 *
 * `authorized` is deliberately absent from every shape in this module: the
 * authorization state is the backend's
 * (`services/guest-p2p/authorization.ts`), it has no member meaning yes, and
 * publishing a field a client could read as "it is on" would be the dormant
 * switch #105 refused to ship.
 */
export interface GuestP2PPolicyPublication {
  readonly policyVersion: string;
  /** The dated decision this policy is published under. */
  readonly decision: {
    readonly documentPath: string;
    readonly date: string;
    readonly outcome: 'no_go' | 'bounded_pilot' | 'go';
  };
  readonly scope: GuestP2PBoundedScope;
  readonly criteria: readonly GuestP2PPublishedCriterion[];
  readonly forbiddenCriteria: readonly GuestP2PForbiddenCriterion[];
}
