/**
 * Merchant plans, entitlements and optional subscription billing (#89).
 *
 * The vocabulary a plan, an entitlement, a subscription and a grant are written
 * in — declared HERE, once, as `readonly` tuples plus the unions derived from
 * them, so the Postgres CHECKs, the drizzle column types, the request schemas
 * and the resolution service all read the same values.
 *
 * ## The one thing this file exists to make UNREPRESENTABLE
 *
 * A free merchant maintains a catalogue, receives and fulfils orders, issues
 * refunds, reads its own financial records and exports its own data. Issue #89
 * says those "cannot become paid-only", and the way that is held here is not a
 * rule anybody has to remember: {@link MERCHANT_ENTITLEMENT_CAPABILITIES} and
 * {@link MERCHANT_UNGATEABLE_CAPABILITIES} are DISJOINT unions — the
 * `RetailCostComponentKind` device — so `order_management` and `data_export`
 * have NO key an entitlement definition, a plan entitlement or a grant could
 * name. The database CHECK on `entitlement_definitions.capability_key` reads the
 * first tuple; the second exists so the prohibition is a VALUE a test can run
 * and an API can refuse BY NAME rather than as an unrecognised key.
 *
 * ## And the second: a plan never buys standing
 *
 * {@link MERCHANT_PLAN_FORBIDDEN_BENEFITS} names what money may never move —
 * organic rank, search placement, official status, a verified relationship,
 * review visibility, reputation or moderation preference. It is disjoint from
 * the capability tuple by a test, `merchant_subscription_plan` is already in
 * `OFFER_FORBIDDEN_RANKING_SIGNALS` (#74) and in
 * `SEARCH_FORBIDDEN_RELEVANCE_SIGNALS` (#70), and the backend pairs all three
 * with a scanned isolation gate — because a vocabulary alone does not stop an
 * import.
 *
 * ## What is deliberately NOT here
 *
 * There is no field by which a plan selects a marketplace fee schedule. #88's
 * schedule scope is `eligible_seller_type` + `eligible_currency` and NOTHING
 * else, which is what makes guest and authenticated checkouts fee-equivalent
 * structurally; a plan scope would have to be added to THAT domain's schedule
 * table, under its own decision. The initial plan design records the answer —
 * no plan selects a different schedule — and `docs/merchant-plans.md` names the
 * mechanism by which one ever could.
 */

import type { Money } from './money';

/* -------------------------------------------------------------------------- */
/*  Capabilities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every capability key an entitlement may name.
 *
 * Eight, and every one of them names something Mercaria does NOT ship today —
 * which is the point rather than an accident. Issue #89's binding constraint is
 * that this work must not delay free merchant activation "unless a paid feature
 * is actually required", and the way to be sure no existing capability moved
 * behind a paywall is for no existing capability to have a key here at all.
 *
 * Two candidates the issue lists were EVALUATED and NOT ADOPTED, which is what
 * "evaluate rather than automatically include" asks for:
 *
 *  - **Additional staff seats.** Store members are unlimited today, so metering
 *    them is precisely the move the constraint forbids.
 *  - **Additional locations.** Same: `locations` has no cap, and introducing one
 *    would change what an existing free store may do.
 *
 * Both stay possible — a definition row plus a free-baseline decision — and
 * `docs/merchant-plans.md` records why neither was taken now.
 */
export type MerchantEntitlementCapability =
  /** Demand, conversion and search-intent analytics beyond the free store summary. */
  | 'advanced_demand_analytics'
  /** Competitive price positioning for a merchant's own offers. */
  | 'competitive_price_analytics'
  /** Rule-driven automation of catalogue and order operations. */
  | 'automation_rules'
  /** Replenishment forecasting and purchase suggestions over inventory. */
  | 'replenishment_planning'
  /** Merchandising rules beyond manual collections and discounts. */
  | 'advanced_merchandising_rules'
  /** POS capacity beyond one register per location. */
  | 'expanded_pos_registers'
  /** Scheduled, recurring exports and outbound integrations. */
  | 'scheduled_exports'
  /** AI-assisted catalogue operations — gated on #42 being grounded. */
  | 'ai_catalog_assistance';

/** {@link MerchantEntitlementCapability} as the tuple the CHECKs and schemas read. */
export const MERCHANT_ENTITLEMENT_CAPABILITIES: readonly MerchantEntitlementCapability[] = [
  'advanced_demand_analytics',
  'competitive_price_analytics',
  'automation_rules',
  'replenishment_planning',
  'advanced_merchandising_rules',
  'expanded_pos_registers',
  'scheduled_exports',
  'ai_catalog_assistance',
];

/**
 * What a plan may NEVER gate — issue #89's "core safety, payments, refunds, data
 * export and order management cannot become paid-only", as values rather than a
 * paragraph.
 *
 * DISJOINT from {@link MERCHANT_ENTITLEMENT_CAPABILITIES} by a test, and the
 * disjointness is the enforcement: an entitlement can only name a key from that
 * tuple, so nothing below has a row shape. The names exist so a refusal can say
 * WHICH prohibition a caller reached for — "`order_management` can never be
 * gated" leads somewhere, "unrecognized capability" does not.
 */
export type UngateableMerchantCapability =
  /** Claiming or creating a store, and keeping it active. */
  | 'store_activation'
  /** Creating, editing and organising listings and variants. */
  | 'catalog_management'
  /** Publishing eligible offers into the catalogue. */
  | 'offer_publication'
  /** Reading, searching and managing received orders. */
  | 'order_management'
  /** Fulfilling an order and recording its fulfilment. */
  | 'order_fulfilment'
  /** Issuing a refund the merchant is entitled to issue. */
  | 'refund_issuance'
  /** Onboarding to a payment rail and staying payment-ready. */
  | 'payment_onboarding'
  /** The essential sales, payout and fee reports a merchant needs to trade. */
  | 'essential_financial_reports'
  /** Reading the merchant's own payments, fees, transfers and ledger position. */
  | 'financial_record_access'
  /** Exporting the merchant's own data, including data a paid feature created. */
  | 'data_export'
  /** Receiving and answering a buyer's cancellation, return or support request. */
  | 'buyer_support_requests'
  /** Responding to a moderation decision that affects the merchant. */
  | 'moderation_response'
  /** Reading the tax records a merchant is legally obliged to keep. */
  | 'tax_record_access'
  /** Member management, permissions and every account-security action. */
  | 'account_security';

/** {@link UngateableMerchantCapability} as the tuple the refusal path reads. */
export const MERCHANT_UNGATEABLE_CAPABILITIES: readonly UngateableMerchantCapability[] = [
  'store_activation',
  'catalog_management',
  'offer_publication',
  'order_management',
  'order_fulfilment',
  'refund_issuance',
  'payment_onboarding',
  'essential_financial_reports',
  'financial_record_access',
  'data_export',
  'buyer_support_requests',
  'moderation_response',
  'tax_record_access',
  'account_security',
];

/**
 * What a plan may never BUY — issue #89 product policy 3.
 *
 * A separate list from the ungateable capabilities above and not a longer
 * version of it: those are things a merchant already does that a plan must not
 * take away, these are things no amount of money may obtain. Both are disjoint
 * from {@link MERCHANT_ENTITLEMENT_CAPABILITIES}, and the first three members
 * are additionally held by #74's `OFFER_FORBIDDEN_RANKING_SIGNALS` and #70's
 * `SEARCH_FORBIDDEN_RELEVANCE_SIGNALS`, which already name
 * `merchant_subscription_plan` — so a plan has no name a scorer could read even
 * before the isolation gate refuses the import.
 */
export type MerchantPlanForbiddenBenefit =
  | 'organic_rank'
  | 'search_placement'
  | 'sponsored_placement'
  | 'official_status'
  | 'verified_relationship'
  | 'review_visibility'
  | 'rating_boost'
  | 'reputation_score'
  | 'moderation_preference'
  | 'dispute_preference';

/** {@link MerchantPlanForbiddenBenefit} as the tuple the gates read. */
export const MERCHANT_PLAN_FORBIDDEN_BENEFITS: readonly MerchantPlanForbiddenBenefit[] = [
  'organic_rank',
  'search_placement',
  'sponsored_placement',
  'official_status',
  'verified_relationship',
  'review_visibility',
  'rating_boost',
  'reputation_score',
  'moderation_preference',
  'dispute_preference',
];

/**
 * What KIND of limit a capability carries.
 *
 * `flag` has no quantity at all and its `limit_value` must be NULL (a CHECK), so
 * "unlimited" and "off" can never be confused for a capability that is simply
 * present or absent. The two quantified kinds differ in what a counter is keyed
 * on, which is why they are two kinds and not one with a nullable period.
 */
export type EntitlementLimitKind =
  /** Present or absent. No quantity, no counter. */
  | 'flag'
  /** A standing maximum — how many of a thing may EXIST at once. */
  | 'total'
  /** A maximum per billing period, reset by the period key. */
  | 'per_period';

/** {@link EntitlementLimitKind} as the tuple the CHECKs read. */
export const ENTITLEMENT_LIMIT_KINDS: readonly EntitlementLimitKind[] = [
  'flag',
  'total',
  'per_period',
];

/**
 * Where an entitlement may be enforced. ONE member, deliberately.
 *
 * Issue #89 entitlement rule 7: "Existing data created by a paid feature remains
 * exportable and safely readable after downgrade." A one-member union is how
 * that becomes a shape rather than a promise — there is no `read` enforcement
 * point and no `export` one, so a capability that gated reading what a merchant
 * already has cannot be DEFINED, let alone checked. `data_export` and
 * `financial_record_access` sit in {@link MERCHANT_UNGATEABLE_CAPABILITIES} as
 * the second, independent layer over the same rule.
 */
export type EntitlementEnforcementPoint = 'create_or_extend';

/** {@link EntitlementEnforcementPoint} as the tuple the CHECK reads. */
export const ENTITLEMENT_ENFORCEMENT_POINTS: readonly EntitlementEnforcementPoint[] = [
  'create_or_extend',
];

/**
 * Whether the capability a definition names EXISTS in this deployment.
 *
 * `postponed` is issue #89's "Which capabilities are postponed because they do
 * not yet exist", carried as data rather than a note in a document. It is
 * load-bearing: activating a plan version whose entitlements name a postponed
 * definition is REFUSED, which is "do not sell a placeholder plan whose
 * advertised features are not implemented" as a mechanism.
 */
export type EntitlementAvailability = 'available' | 'postponed';

/** {@link EntitlementAvailability} as the tuple the CHECK reads. */
export const ENTITLEMENT_AVAILABILITIES: readonly EntitlementAvailability[] = [
  'available',
  'postponed',
];

/* -------------------------------------------------------------------------- */
/*  Plans                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A plan VERSION's lifecycle — the `fee_schedules` vocabulary, because it is the
 * same mechanism: immutable once active (a trigger), one active per key (a
 * partial unique index), and a policy change is a NEW version.
 */
export type MerchantPlanStatus = 'draft' | 'active' | 'superseded' | 'retired';

/** {@link MerchantPlanStatus} as the tuple the CHECK reads. */
export const MERCHANT_PLAN_STATUSES: readonly MerchantPlanStatus[] = [
  'draft',
  'active',
  'superseded',
  'retired',
];

/**
 * What a plan COSTS, when it costs anything.
 *
 * `free` is a real tier and not the absence of one: a store with no subscription
 * resolves against the active free plan version, so the free plan is what states
 * what a merchant gets for nothing — which today is an EMPTY entitlement set,
 * because everything a free merchant does is ungateable by construction.
 */
export type MerchantPlanTier = 'free' | 'paid';

/** {@link MerchantPlanTier} as the tuple the CHECK reads. */
export const MERCHANT_PLAN_TIERS: readonly MerchantPlanTier[] = ['free', 'paid'];

/** The billing cadences a paid plan may publish a price for. */
export type BillingInterval = 'monthly' | 'annual';

/** {@link BillingInterval} as the tuple the CHECK reads. */
export const BILLING_INTERVALS: readonly BillingInterval[] = ['monthly', 'annual'];

/**
 * The billing rails a merchant subscription can be charged on.
 *
 * A closed set with ONE member, added together with the adapter that can produce
 * a row for it — `PAYMENT_PROVIDER_IDS`' rule, one domain over. It is
 * deliberately a SEPARATE tuple from `PaymentProviderId`: a subscription is
 * charged on Mercaria's own platform account through Stripe Billing, and a
 * marketplace payment is a Connect charge. Sharing a tuple would invite sharing
 * a customer, an account or an id space, which is exactly what acceptance 2
 * forbids.
 */
export type BillingProviderId = 'stripe';

/** {@link BillingProviderId} as the tuple the CHECKs read. */
export const BILLING_PROVIDER_IDS: readonly BillingProviderId[] = ['stripe'];

/* -------------------------------------------------------------------------- */
/*  Subscriptions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where a merchant subscription stands — issue #89 domain model item 7.
 *
 * `cancelled` is spelled the way the ORDER domain spells it, not the way Stripe
 * does (`canceled`). That is a mapping the billing adapter performs and states,
 * which is the same posture every other provider vocabulary gets here: a
 * provider's spelling never becomes Mercaria's.
 *
 * `paused` and `past_due` are genuinely different and neither substitutes for
 * the other. `past_due` is an involuntary state with a GRACE deadline attached;
 * `paused` is a deliberate suspension with no money owed and no deadline
 * running.
 *
 * `expired` is where a `cancelled` subscription lands once its paid period has
 * actually run out. Keeping them apart is what lets "cancel now, keep what you
 * paid for until the period ends" be a real state rather than a comment.
 */
export type MerchantSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'cancelled'
  | 'expired';

/** {@link MerchantSubscriptionStatus} as the tuple the CHECKs read. */
export const MERCHANT_SUBSCRIPTION_STATUSES: readonly MerchantSubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
  'expired',
];

/**
 * The subscription states whose PAID entitlements still apply.
 *
 * Stated as a value rather than as a condition inside the resolver, because it
 * is the sentence issue #89 acceptance 4 is about and it must be readable
 * without following a branch. `past_due` is IN the set — its grace deadline is
 * what removes it, and the deadline is a stored timestamp rather than a status.
 */
export const ENTITLING_SUBSCRIPTION_STATUSES: readonly MerchantSubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
];

/**
 * What happens at the end of the paid period a merchant cancelled during.
 *
 * `at_period_end` is the initial plan design's answer and the only one the
 * merchant surface offers; `immediate` exists because an operator-initiated
 * termination is a different act and recording it as `at_period_end` would
 * misstate when access ended.
 */
export type SubscriptionCancellationBehavior = 'at_period_end' | 'immediate';

/** {@link SubscriptionCancellationBehavior} as the tuple the CHECK reads. */
export const SUBSCRIPTION_CANCELLATION_BEHAVIORS: readonly SubscriptionCancellationBehavior[] = [
  'at_period_end',
  'immediate',
];

/**
 * What one row of the subscription audit trail records — issue #89 domain model
 * item 10, "full audit history".
 *
 * Append-only by trigger. Every state change, every provider event applied and
 * every acceptance appends one; nothing edits one, so "what happened to this
 * subscription" is answered by reading rather than by trusting the current row.
 */
export type MerchantSubscriptionEventKind =
  | 'created'
  | 'terms_accepted'
  | 'trial_started'
  | 'activated'
  | 'invoice_paid'
  | 'payment_failed'
  | 'past_due'
  | 'grace_expired'
  | 'paused'
  | 'resumed'
  | 'plan_changed'
  | 'cancellation_scheduled'
  | 'cancelled'
  | 'expired'
  | 'reconciled';

/** {@link MerchantSubscriptionEventKind} as the tuple the CHECK reads. */
export const MERCHANT_SUBSCRIPTION_EVENT_KINDS: readonly MerchantSubscriptionEventKind[] = [
  'created',
  'terms_accepted',
  'trial_started',
  'activated',
  'invoice_paid',
  'payment_failed',
  'past_due',
  'grace_expired',
  'paused',
  'resumed',
  'plan_changed',
  'cancellation_scheduled',
  'cancelled',
  'expired',
  'reconciled',
];

/* -------------------------------------------------------------------------- */
/*  Grants                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why a capability was granted outside a plan — issue #89 domain model item 5.
 *
 * A grant only ever ADDS. There is no removing grant and none may be added: the
 * capabilities a free merchant relies on are ungateable by construction, so the
 * only thing a negative grant could take away is a paid extra somebody is paying
 * for — and the honest way to do that is to change the plan or end the
 * subscription, both of which are audited.
 */
export type EntitlementGrantReason =
  /** A time-boxed trial Mercaria gave outside a rail trial. */
  | 'trial'
  /** Continuity for a merchant who had the capability before plans existed. */
  | 'migration'
  /** A commercial partnership recorded by an operator. */
  | 'partnership'
  /** An operator-approved exception, with its reason written down. */
  | 'operator_exception'
  /** Compensation for an incident. */
  | 'compensation';

/** {@link EntitlementGrantReason} as the tuple the CHECK reads. */
export const ENTITLEMENT_GRANT_REASONS: readonly EntitlementGrantReason[] = [
  'trial',
  'migration',
  'partnership',
  'operator_exception',
  'compensation',
];

/** Where one effective entitlement came from. */
export type EntitlementSource = 'plan' | 'grant';

/** {@link EntitlementSource} as the tuple the projection reads. */
export const ENTITLEMENT_SOURCES: readonly EntitlementSource[] = ['plan', 'grant'];

/* -------------------------------------------------------------------------- */
/*  Decisions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Why a capability check refused.
 *
 * Named reasons rather than a boolean, because the merchant surface has to be
 * able to EXPLAIN an unavailable feature without a dark pattern (#89 UX 6), and
 * "you have reached this month's limit" and "this is a Pro capability" lead to
 * different screens.
 */
export type EntitlementRefusalReason =
  /** No plan or grant carries the capability. */
  | 'not_entitled'
  /** The capability is entitled and the quantified limit is exhausted. */
  | 'limit_reached'
  /** No definition exists for the key, so nothing can be entitled to it. */
  | 'capability_unknown'
  /** The capability is defined but this deployment has not implemented it. */
  | 'capability_postponed';

/** {@link EntitlementRefusalReason} as the tuple the projection reads. */
export const ENTITLEMENT_REFUSAL_REASONS: readonly EntitlementRefusalReason[] = [
  'not_entitled',
  'limit_reached',
  'capability_unknown',
  'capability_postponed',
];

/**
 * The answer to "may this store do this now".
 *
 * A STRING discriminant, not `granted: boolean`. The backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — so
 * `if (!decision.granted)` would leave the caller holding the whole union
 * (`~/Oxy/AGENTS.md`, the #68 finding). The refused branch has no `remaining`
 * property, so a caller cannot read a quantity off a refusal.
 */
export type EntitlementDecision =
  | {
      readonly outcome: 'granted';
      readonly capability: MerchantEntitlementCapability;
      /** NULL for `flag`, and for a quantified entitlement with no ceiling. */
      readonly limit: number | null;
      /** How much of a quantified limit is left. NULL when there is no limit. */
      readonly remaining: number | null;
    }
  | {
      readonly outcome: 'refused';
      readonly capability: MerchantEntitlementCapability;
      readonly reason: EntitlementRefusalReason;
    };

/* -------------------------------------------------------------------------- */
/*  Projections                                                                */
/* -------------------------------------------------------------------------- */

/** One capability as a merchant sees it — the product copy, never the internals. */
export interface MerchantCapabilityView {
  readonly key: MerchantEntitlementCapability;
  readonly name: string;
  readonly description: string;
  readonly limitKind: EntitlementLimitKind;
  readonly availability: EntitlementAvailability;
}

/** One published price of one plan version, in one currency and cadence. */
export interface MerchantPlanPriceView {
  readonly currency: string;
  readonly interval: BillingInterval;
  readonly unitPrice: Money;
}

/** One capability a plan version includes, with the limit that version sets. */
export interface MerchantPlanCapabilityView {
  readonly key: MerchantEntitlementCapability;
  readonly name: string;
  readonly description: string;
  readonly limitKind: EntitlementLimitKind;
  readonly availability: EntitlementAvailability;
  /** NULL means unlimited for a quantified kind, and nothing for a `flag`. */
  readonly limit: number | null;
}

/**
 * One plan version in the comparison — issue #89 UX 1, "plan comparison with
 * exact current capabilities".
 *
 * `capabilities` lists what THIS version grants and nothing aspirational: a
 * version that could not be activated because one of its capabilities is
 * postponed is not in the catalogue at all, so a merchant never reads a promise
 * the deployment cannot keep.
 */
export interface MerchantPlanCatalogEntry {
  /**
   * The version's own row id — what an upgrade names.
   *
   * A Mercaria id and not a provider one: it authorizes nothing on its own, it
   * points at an IMMUTABLE row, and naming the version rather than the key is
   * what stops an upgrade being applied against a policy that moved while the
   * screen was open.
   */
  readonly planId: string;
  readonly planKey: string;
  readonly version: number;
  readonly tier: MerchantPlanTier;
  readonly name: string;
  readonly summary: string;
  readonly termsVersion: string;
  readonly trialDays: number;
  readonly gracePeriodDays: number;
  readonly prices: readonly MerchantPlanPriceView[];
  readonly capabilities: readonly MerchantPlanCapabilityView[];
}

/** One effective entitlement, and where it came from. */
export interface MerchantEntitlementView {
  readonly capability: MerchantEntitlementCapability;
  readonly limitKind: EntitlementLimitKind;
  /** NULL means unlimited for a quantified kind, and nothing for a `flag`. */
  readonly limit: number | null;
  readonly source: EntitlementSource;
  /** How much of a quantified limit is used in the current period. */
  readonly used: number;
}

/** A merchant's subscription as the dashboard renders it. No provider ids. */
export interface MerchantSubscriptionView {
  readonly status: MerchantSubscriptionStatus;
  readonly planKey: string;
  readonly planVersion: number;
  readonly planName: string;
  readonly interval: BillingInterval | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly trialEndsAt: string | null;
  /** Set while `past_due`: when the paid extras actually stop. */
  readonly graceExpiresAt: string | null;
  readonly cancellationBehavior: SubscriptionCancellationBehavior | null;
  readonly cancelAt: string | null;
  readonly acceptedTermsVersion: string | null;
}

/**
 * Everything the merchant plan screen renders.
 *
 * `billingAvailable` is what the client uses to decide whether to OFFER an
 * upgrade — it may hide or explain, and it can never grant (#89 entitlement
 * rule 4): every capability decision is taken on the server and this projection
 * carries results, not inputs.
 */
export interface MerchantPlanStatusView {
  readonly storeId: string;
  readonly subscription: MerchantSubscriptionView | null;
  /** The plan whose entitlements currently apply — the free plan when unsubscribed. */
  readonly effectivePlanKey: string | null;
  readonly effectivePlanVersion: number | null;
  readonly entitlements: readonly MerchantEntitlementView[];
  /** True when a paid subscription could be started on this deployment. */
  readonly billingAvailable: boolean;
  /** True when a hosted billing portal session can be opened. */
  readonly portalAvailable: boolean;
}

/** What starting a paid subscription hands the client — a URL and nothing else. */
export interface MerchantBillingSessionView {
  /** The provider-hosted page to send the merchant to. */
  readonly url: string;
  /** When the hosted session stops being usable. */
  readonly expiresAt: string | null;
}
