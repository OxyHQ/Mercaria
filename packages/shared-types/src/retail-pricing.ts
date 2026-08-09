/**
 * Zero-margin landed-cost vocabulary for `mercaria_retail` (#120, ADR 0004 D3).
 *
 * Mercaria retail is a COST-RECOVERY channel, not a margin engine: the buyer
 * pays the real documented cost of acquiring and fulfilling the order, and
 * Mercaria's planned item profit is zero. This file is where that policy stops
 * being a sentence and becomes a type system.
 *
 * ## Zero markup is STRUCTURAL here, not a default somebody can change
 *
 * The customer amount is the SUM of the allowed direct-cost components below
 * and nothing else. There is no markup field, no margin target, no profit
 * floor and no padding — not set to zero, ABSENT. `RetailForbiddenComponentKind`
 * enumerates the fourteen things that must never enter a price, and it is
 * deliberately a DIFFERENT union from `RetailCostComponentKind`: the two sets
 * are disjoint by construction, so a forbidden component cannot be typed into a
 * quote, stored in a component row (the column's CHECK reads the allowed tuple)
 * or configured on a policy version (no column exists to hold one).
 *
 * The forbidden union exists so a REFUSAL can name the exact prohibited thing a
 * caller reached for, rather than answering "unknown field" — an operator who
 * tries to configure a 12% markup is told it is `percentage_markup` and why.
 *
 * ## Every component names its provenance
 *
 * ADR 0004 D3 requires each included component to name its source, its
 * currency, its observation time and whether it is quoted, guaranteed,
 * estimated or final. `RetailCostComponent` carries all four, so an amount with
 * no attributable source is unrepresentable rather than merely discouraged.
 *
 * ## An unknown cost is never zero
 *
 * `RetailQuoteCompleteness` fails CLOSED: a material cost that cannot be
 * quoted blocks publication and checkout instead of defaulting to zero, and
 * `RetailPricePresentation` keeps a provisional figure from ever being shown as
 * a guaranteed final total.
 *
 * ## What this file deliberately does NOT declare
 *
 * A `retail_margin_revenue` account, an item-profit figure, or any type that
 * could hold one. `RETAIL_ACCOUNTING_OUTPUTS` is the COMPLETE set of accounting
 * components retail exposes to #123/#128, and there is no member in which a
 * retail item margin could accumulate — which is what ADR 0004 D7's
 * zero-profit proof means mechanically.
 */

import type { CurrencyCode, FxRateSnapshot, Money } from './money';

/**
 * The EIGHT allowed direct-cost components (#120 "Allowed direct-cost
 * components", ADR 0004 D3). Each is modelled separately rather than folded
 * into one inflated unit price, so every figure stays independently
 * attributable to a supplier quote line, a carrier tariff, a tax determination
 * or a provider balance transaction.
 *
 *  - `supplier_item` — the wholesale unit cost, quantity applied.
 *  - `supplier_variant_surcharge` — a variant-specific uplift the SUPPLIER
 *    charges (a size, a finish), never a Mercaria one.
 *  - `supplier_handling` — mandatory handling, pick/pack or per-order fee
 *    stated on the supplier's quote.
 *  - `destination_shipping` — what the supplier or carrier actually charges to
 *    ship to THIS destination.
 *  - `tax_duty` — legally applicable customer taxes, VAT, customs or duties.
 *  - `fx_cost` — the measurable conversion cost on this order, never a padded
 *    "FX buffer".
 *  - `payment_processing` — the provider's own cost, only where genuinely
 *    attributable, lawful to pass through and disclosed (policy-gated).
 *  - `other_direct_fulfilment` — another mandatory, evidenced direct cost that
 *    an ACTIVE policy version names in its allowed set (ADR 0004 D3.7).
 */
export type RetailCostComponentKind =
  | 'supplier_item'
  | 'supplier_variant_surcharge'
  | 'supplier_handling'
  | 'destination_shipping'
  | 'tax_duty'
  | 'fx_cost'
  | 'payment_processing'
  | 'other_direct_fulfilment';

/** {@link RetailCostComponentKind} as the tuple the column types and CHECKs read. */
export const RETAIL_COST_COMPONENT_KINDS: readonly RetailCostComponentKind[] = [
  'supplier_item',
  'supplier_variant_surcharge',
  'supplier_handling',
  'destination_shipping',
  'tax_duty',
  'fx_cost',
  'payment_processing',
  'other_direct_fulfilment',
];

/**
 * The FOURTEEN components the engine must reject or structurally exclude
 * (#120 "Forbidden pricing components", ADR 0004 D3).
 *
 * This union is NOT a set of values anything stores — no column, no DTO field
 * and no policy option accepts one. It exists so the refusal can name what was
 * attempted: `assertNoForbiddenPricingComponent` in the backend maps an
 * offending input key onto one of these and explains why it can never be a
 * customer cost.
 */
export type RetailForbiddenComponentKind =
  | 'percentage_markup'
  | 'percentage_margin_target'
  | 'fixed_profit'
  | 'minimum_gross_profit_floor'
  | 'overhead_allocation'
  | 'expected_support_cost'
  | 'fraud_chargeback_reserve'
  | 'return_defect_reserve'
  | 'referral_commission'
  | 'affiliate_economics'
  | 'merchant_subscription_economics'
  | 'paid_ranking_economics'
  | 'psychological_rounding'
  | 'operator_padding';

/** {@link RetailForbiddenComponentKind} as a tuple, for exhaustive iteration. */
export const RETAIL_FORBIDDEN_COMPONENT_KINDS: readonly RetailForbiddenComponentKind[] = [
  'percentage_markup',
  'percentage_margin_target',
  'fixed_profit',
  'minimum_gross_profit_floor',
  'overhead_allocation',
  'expected_support_cost',
  'fraud_chargeback_reserve',
  'return_defect_reserve',
  'referral_commission',
  'affiliate_economics',
  'merchant_subscription_economics',
  'paid_ranking_economics',
  'psychological_rounding',
  'operator_padding',
];

/**
 * Why each forbidden component can never be a customer cost. Used verbatim in
 * the refusal an operator or an API caller receives, so the answer explains the
 * policy rather than citing a schema.
 */
export const RETAIL_FORBIDDEN_COMPONENT_LABELS: Record<RetailForbiddenComponentKind, string> = {
  percentage_markup:
    'a percentage markup — the retail customer amount is the sum of documented direct costs, with markup zero by construction',
  percentage_margin_target:
    'a percentage margin target — the planned item margin on a retail order is zero, so there is no target to set',
  fixed_profit:
    'a fixed per-order or per-item profit — retail is cost recovery; a profit component has no account to land in',
  minimum_gross_profit_floor:
    'a minimum gross-profit floor — a floor would raise the customer amount above documented cost',
  overhead_allocation:
    'a general platform/company overhead allocation — overhead is not an order-specific direct cost',
  expected_support_cost:
    'an expected support cost — a forecast is not an evidenced direct cost of this order',
  fraud_chargeback_reserve:
    'a fraud or chargeback reserve — a real cost, funded outside the customer amount (ADR 0004 D12.5)',
  return_defect_reserve:
    'an expected return or defect reserve — a real cost, funded outside the customer amount (ADR 0004 D12.5)',
  referral_commission:
    'a referral or ambassador commission — an acquisition expense of Mercaria, invisible to the cost formula (#120 referral boundary)',
  affiliate_economics:
    'affiliate economics — affiliate revenue and expense belong to external_referral, which creates no Mercaria order',
  merchant_subscription_economics:
    'merchant subscription economics — plan economics cannot change what an order costs to fulfil',
  paid_ranking_economics:
    'paid-ranking economics — organic ranking reads buyer-relevant offer facts and never cost or absorbed variance (#74)',
  psychological_rounding:
    'upward psychological rounding — rounding exists only to the presentment currency minor unit, half-even, and its residue is variance, never kept',
  operator_padding:
    'arbitrary operator padding — every included amount must name an evidenced source',
};

/**
 * How firm one component's amount is (ADR 0004 D8.1's four amount classes).
 *
 *  - `quoted` — the supplier or carrier stated it, valid for the quote TTL.
 *  - `guaranteed` — frozen at charge; it may never increase thereafter.
 *  - `estimated` — pending an actual (a provider fee estimated from published
 *    pricing, an FX estimate). Never padded.
 *  - `final` — the actual: an invoice line, a balance transaction, a realized
 *    conversion.
 */
export type RetailCostConfidence = 'quoted' | 'guaranteed' | 'estimated' | 'final';

/** {@link RetailCostConfidence} as the tuple the column types and CHECKs read. */
export const RETAIL_COST_CONFIDENCES: readonly RetailCostConfidence[] = [
  'quoted',
  'guaranteed',
  'estimated',
  'final',
];

/**
 * Which side of the conversion an FX snapshot came from — #120 currency rule 6
 * ("distinguish quoted FX from final provider FX where those can differ").
 *
 *  - `quoted` — Mercaria's own FX service at quote time.
 *  - `provider_final` — the rate the payment provider actually applied,
 *    learned from its balance transaction.
 *
 * The two are recorded, never reconciled into one number here: any difference
 * is COST VARIANCE and enters #128, and it may never become planned profit.
 */
export type RetailFxBasis = 'quoted' | 'provider_final';

/** {@link RetailFxBasis} as the tuple the column types and CHECKs read. */
export const RETAIL_FX_BASES: readonly RetailFxBasis[] = ['quoted', 'provider_final'];

/**
 * What a quote knows about its own costs. Fails CLOSED: only `complete` may be
 * charged, and only `complete` or `awaiting_destination` may be shown at all.
 *
 *  - `complete` — every applicable component is quoted for this destination.
 *  - `awaiting_destination` — the supplier item cost is known but shipping and
 *    tax need destination context. Informational only.
 *  - `blocked_undocumented_cost` — a cost is known to APPLY and the source will
 *    not document it (an undisclosed supplier handling fee). Ineligible.
 *  - `blocked_tax_undetermined` — the market's tax or customs treatment could
 *    not be determined. That market is blocked, never priced at zero tax.
 *  - `blocked_unquotable_cost` — an applicable component simply could not be
 *    quoted (shipping the supplier cannot price, an unavailable FX pair).
 */
export type RetailQuoteCompleteness =
  | 'complete'
  | 'awaiting_destination'
  | 'blocked_undocumented_cost'
  | 'blocked_tax_undetermined'
  | 'blocked_unquotable_cost';

/** {@link RetailQuoteCompleteness} as the tuple the column types and CHECKs read. */
export const RETAIL_QUOTE_COMPLETENESS_STATES: readonly RetailQuoteCompleteness[] = [
  'complete',
  'awaiting_destination',
  'blocked_undocumented_cost',
  'blocked_tax_undetermined',
  'blocked_unquotable_cost',
];

/**
 * Why a quote is not an exact, chargeable cost-only price. A closed set so an
 * operator, an offer surface (#129) and a checkout gate (#123) all read the
 * same vocabulary instead of parsing prose.
 */
export type RetailCostBlockReason =
  | 'destination_unknown'
  | 'shipping_not_quotable'
  | 'undocumented_supplier_fee'
  | 'tax_undetermined'
  | 'market_not_supported'
  | 'supplier_price_unavailable'
  | 'fx_rate_unavailable'
  | 'payment_cost_undetermined'
  | 'component_not_permitted_by_policy'
  | 'policy_missing';

/** {@link RetailCostBlockReason} as the tuple the column types and CHECKs read. */
export const RETAIL_COST_BLOCK_REASONS: readonly RetailCostBlockReason[] = [
  'destination_unknown',
  'shipping_not_quotable',
  'undocumented_supplier_fee',
  'tax_undetermined',
  'market_not_supported',
  'supplier_price_unavailable',
  'fx_rate_unavailable',
  'payment_cost_undetermined',
  'component_not_permitted_by_policy',
  'policy_missing',
];

/**
 * What a public surface may present (#120 "Pricing before checkout").
 *
 *  - `exact_cost_only` — every component is known for this destination.
 *  - `starting_item_cost` — a CLEARLY QUALIFIED starting item cost, because
 *    shipping and tax need destination context. Never a final total.
 *  - `not_purchasable` — a material cost is unknown; nothing is claimed.
 *
 * The mapping from {@link RetailQuoteCompleteness} is one-to-one and enforced
 * by a CHECK on `retail_cost_quotes`, so a blocked quote cannot be stored
 * claiming an exact price.
 */
export type RetailPricePresentation = 'exact_cost_only' | 'starting_item_cost' | 'not_purchasable';

/** {@link RetailPricePresentation} as the tuple the column types and CHECKs read. */
export const RETAIL_PRICE_PRESENTATIONS: readonly RetailPricePresentation[] = [
  'exact_cost_only',
  'starting_item_cost',
  'not_purchasable',
];

/**
 * Who funds a promotion on a retail order. ONE member, deliberately: the
 * subsidy is a Mercaria MARKETING EXPENSE (#120 "Discounts and promotions").
 *
 * A supplier-funded subsidy is unrepresentable, which is the point — it would
 * be a supplier underpayment, and a "negative supplier cost" is refused one
 * layer down by the non-negative CHECK on every component amount.
 */
export type RetailSubsidySource = 'mercaria_marketing_budget';

/** {@link RetailSubsidySource} as the tuple the column types and CHECKs read. */
export const RETAIL_SUBSIDY_SOURCES: readonly RetailSubsidySource[] = ['mercaria_marketing_budget'];

/**
 * Why one quote replaced another. Present exactly when a quote supersedes one,
 * so the re-quote chain states its own cause rather than leaving a reader to
 * diff two rows.
 */
export type RetailQuoteSupersedeReason =
  | 'supplier_cost_changed'
  | 'shipping_quoted'
  | 'tax_determined'
  | 'quote_expired'
  | 'policy_version_changed';

/** {@link RetailQuoteSupersedeReason} as the tuple the column types and CHECKs read. */
export const RETAIL_QUOTE_SUPERSEDE_REASONS: readonly RetailQuoteSupersedeReason[] = [
  'supplier_cost_changed',
  'shipping_quoted',
  'tax_determined',
  'quote_expired',
  'policy_version_changed',
];

/**
 * What a final-versus-locked cost difference IS. The expected margin is always
 * zero, so a difference is COST VARIANCE and never margin performance.
 *
 *  - `within_rounding_tolerance` — at most the policy's tiny minor-unit
 *    tolerance. The delta is still RECORDED, so no material variance can hide
 *    inside it (#120 variance rule 5).
 *  - `customer_adjustment_owed` — actuals came in lower. The surplus is the
 *    customer's and enters #128's adjustment/refund path. It is never revenue.
 *  - `mercaria_absorbed` — actuals came in higher. Mercaria absorbs it; there
 *    is no surcharge path, and none may be built.
 */
export type RetailVarianceDisposition =
  | 'within_rounding_tolerance'
  | 'customer_adjustment_owed'
  | 'mercaria_absorbed';

/** {@link RetailVarianceDisposition} as the tuple the column types and CHECKs read. */
export const RETAIL_VARIANCE_DISPOSITIONS: readonly RetailVarianceDisposition[] = [
  'within_rounding_tolerance',
  'customer_adjustment_owed',
  'mercaria_absorbed',
];

/**
 * The EIGHT accounting components a retail order exposes to #123 and #128
 * (#120 "Ledger / accounting outputs"). This list is COMPLETE.
 *
 * There is no `retail_margin_revenue` and no equivalent item-profit member, so
 * a positive variance has nowhere to be recognized as revenue: it can only land
 * on `customer_adjustment_payable`. That absence is the zero-profit proof at
 * the type level, and a test asserts no member matches a margin/profit shape.
 */
export type RetailAccountingOutput =
  | 'customer_receivable'
  | 'supplier_payable'
  | 'shipping_fulfilment_cost'
  | 'tax_duty_liability'
  | 'provider_fx_cost'
  | 'promotion_subsidy'
  | 'customer_adjustment_payable'
  | 'absorbed_variance';

/** {@link RetailAccountingOutput} as the tuple the column types and CHECKs read. */
export const RETAIL_ACCOUNTING_OUTPUTS: readonly RetailAccountingOutput[] = [
  'customer_receivable',
  'supplier_payable',
  'shipping_fulfilment_cost',
  'tax_duty_liability',
  'provider_fx_cost',
  'promotion_subsidy',
  'customer_adjustment_payable',
  'absorbed_variance',
];

/**
 * The DEFAULT rounding tolerance, in minor units of the presentment currency.
 *
 * One minor unit is exactly what a single half-even rounding can produce, which
 * is why it is the default rather than a number chosen for comfort. A policy
 * version may configure its own within {@link RETAIL_MAX_ROUNDING_TOLERANCE_MINOR},
 * and the delta is recorded whatever the tolerance says — the tolerance bounds
 * AUTOMATION, it never reclassifies a variance out of existence.
 */
export const RETAIL_DEFAULT_ROUNDING_TOLERANCE_MINOR = 1;

/**
 * The largest rounding tolerance a policy version may configure, enforced by a
 * CHECK on `retail_pricing_policies`. It exists so "a tiny rounding tolerance"
 * cannot be widened into a place to hide material variance — raising this bound
 * is a schema change under review, not a configuration change.
 */
export const RETAIL_MAX_ROUNDING_TOLERANCE_MINOR = 5;

/** A retail pricing policy version's lifecycle — the `fee_schedules` shape. */
export type RetailPricingPolicyStatus = 'draft' | 'active' | 'superseded' | 'retired';

/** {@link RetailPricingPolicyStatus} as the tuple the column types and CHECKs read. */
export const RETAIL_PRICING_POLICY_STATUSES: readonly RetailPricingPolicyStatus[] = [
  'draft',
  'active',
  'superseded',
  'retired',
];

/**
 * One versioned retail pricing policy, as the operator surface shows it.
 *
 * Read the FIELDS that are absent as carefully as the ones present: there is no
 * markup, no margin target, no profit floor and no padding. `absorptionCapBps`
 * bounds what Mercaria will ABSORB before cancelling and refunding (ADR 0004
 * D3); it can only ever cost Mercaria money and can never raise a price.
 */
export interface RetailPricingPolicySummary {
  /** The stable logical id shared by every version of one policy. */
  policyKey: string;
  /** Monotonic per key. A policy change is a new version, never an edit. */
  version: number;
  name: string;
  summary: string;
  status: RetailPricingPolicyStatus;
  /** ISO-8601. The policy applies only inside `[effectiveStart, effectiveEnd)`. */
  effectiveStart: string;
  effectiveEnd?: string;
  /**
   * The component kinds this version approves (ADR 0004 D3.7). A subset of
   * {@link RETAIL_COST_COMPONENT_KINDS}, always containing `supplier_item`.
   */
  allowedComponentKinds: RetailCostComponentKind[];
  /** Whether the provider's processing cost may be passed through at all. */
  paymentCostPassthroughEnabled: boolean;
  /** The lawful basis and disclosure reference — required when pass-through is on. */
  paymentCostPassthroughBasis?: string;
  /** How much unexpected cost Mercaria absorbs, as basis points of the order. */
  absorptionCapBps: number;
  /** The absorption floor — the cap is the greater of the two (ADR 0004 D3). */
  absorptionCapFloor: Money;
  /** The tiny minor-unit tolerance below which a delta is rounding, not variance. */
  roundingToleranceMinor: number;
  /** How long a quote composed under this version may be trusted. */
  quoteTtlSeconds: number;
  createdAt: string;
  activatedAt?: string;
}

/** Where in the world a quote was priced FOR. Absent country = no destination context. */
export interface RetailQuoteDestination {
  /** ISO-3166-1 alpha-2, upper-cased. The market whose tax treatment was evaluated. */
  country: string;
  /** A sub-national region, where the tax determination needed one. */
  region?: string;
}

/**
 * ONE direct-cost component of a retail quote, with its whole provenance.
 *
 * `sourceAmount` stays in the SUPPLIER's own currency — nothing converts a
 * source price on write (#120 currency rule 5) — and `presentmentAmount` is
 * that figure converted once, with the exact `fxSnapshot` used, so the
 * conversion is reproducible after the rate has moved.
 */
export interface RetailCostComponent {
  kind: RetailCostComponentKind;
  /** What produced this figure: `supplier_quote`, `carrier_tariff`, `tax_engine`, … */
  sourceRef: string;
  /** The amount as the SOURCE stated it, in the source's own currency. */
  sourceAmount: Money;
  /** The same amount in the buyer's presentment currency. */
  presentmentAmount: Money;
  /** The exact conversion — present exactly when the two currencies differ. */
  fxSnapshot?: FxRateSnapshot;
  /** Whose rate it was: Mercaria's quote-time rate, or the provider's final one. */
  fxBasis?: RetailFxBasis;
  confidence: RetailCostConfidence;
  /** ISO-8601 — when the source was observed saying this. */
  observedAt: string;
  /** The supplier's own quote id, when the component came from one. */
  supplierQuoteRef?: string;
  /** The observation record this figure was read from. */
  sourceObservationRef?: string;
  /** Where the evidence lives (an invoice line, a tariff table, a determination). */
  evidenceRef?: string;
  /** What this is, as a human reads it. */
  description?: string;
}

/** An explicit, Mercaria-funded promotion on a retail order. */
export interface RetailPromotionSubsidy {
  source: RetailSubsidySource;
  /** The named budget the subsidy is drawn from — an explicit source is mandatory. */
  budgetRef: string;
  /** What Mercaria pays on the buyer's behalf, in the presentment currency. */
  amount: Money;
}

/**
 * An immutable retail cost quote — the sixteen facts #120 requires, and the
 * record the charged amount is a pure function of (ADR 0004 D4 step 1).
 *
 * Reproducible after the source has changed: every component carries its own
 * source, currency, observation time and confidence; the policy version is
 * named; and `contentHash` pins the whole composition so a later read can prove
 * it is the same quote that was accepted.
 */
export interface RetailCostQuote {
  id: string;
  /** 1. Supplier and supplier-offer identity. */
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
  procurementOfferId?: string;
  /** 2. Canonical variant (#56's key space — snapshot provenance). */
  canonicalProductId?: string;
  canonicalVariantId?: string;
  supplierSku: string;
  /** 3. How many units this quote prices. */
  quantity: number;
  /** 4. Destination / market scope. Absent = no destination context yet. */
  destination?: RetailQuoteDestination;
  /** 5–10. Every included component, with source, currency, time and confidence. */
  components: RetailCostComponent[];
  /** The currency the buyer sees and pays in. */
  presentmentCurrency: CurrencyCode;
  /** 11. The cost-only customer total — the exact sum of the components. */
  customerTotal: Money;
  /** An explicit Mercaria-funded reduction, when one applies. */
  subsidy?: RetailPromotionSubsidy;
  /** What the buyer actually pays: `customerTotal` minus any subsidy. */
  buyerPayable: Money;
  /** 13. Validity window. */
  quotedAt: string;
  expiresAt: string;
  /** 14. Completeness, and what a public surface may therefore present. */
  completeness: RetailQuoteCompleteness;
  presentation: RetailPricePresentation;
  blockReasons: RetailCostBlockReason[];
  /** 15. The policy version this quote was composed under. */
  policyKey: string;
  policyVersion: number;
  /** 16. The content hash pinning this composition. */
  contentHash: string;
  /** The quote this one replaced, and why, when it replaced one. */
  supersedesQuoteId?: string;
  supersedeReason?: RetailQuoteSupersedeReason;
  createdAt: string;
}

/**
 * The checkout LOCK: a buyer accepted one exact quote for one checkout group.
 *
 * Its uniqueness on `(checkoutGroupId, quoteId)` is what makes an idempotent
 * retry return the SAME locked total. A revised total is a NEW quote and a NEW
 * acceptance naming the one it supersedes — never a mutation, so the charged
 * amount can never silently rise (#120 checkout-lock rule 6).
 */
export interface RetailCostQuoteAcceptance {
  id: string;
  quoteId: string;
  checkoutGroupId: string;
  /** Set once, when the retail order exists. Never re-pointed. */
  orderId?: string;
  /** What the buyer accepted — equal to the quote's `buyerPayable` by CHECK. */
  acceptedTotal: Money;
  /** The quote's hash, restated so a tampered read is detectable. */
  quoteContentHash: string;
  acceptedAt: string;
  supersedesAcceptanceId?: string;
}

/** The completeness gate's verdict — what may be shown, and what may be charged. */
export interface RetailCompletenessVerdict {
  completeness: RetailQuoteCompleteness;
  presentation: RetailPricePresentation;
  /** Sorted and deduped, so two derivations of one situation are byte-identical. */
  blockReasons: RetailCostBlockReason[];
  /** Whether a public surface may show this offer at all. */
  publishable: boolean;
  /** Whether checkout may charge against it. `false` unless everything is known. */
  checkoutEligible: boolean;
}

/**
 * One classified cost difference between the locked customer amount and the
 * actual attributable cost. NEVER a margin figure: `deltaMinor` is recorded
 * whatever the disposition says.
 */
export interface RetailCostVariance {
  /** `actual − locked`, in the presentment currency's minor units. */
  deltaMinor: number;
  currency: CurrencyCode;
  disposition: RetailVarianceDisposition;
  /** The tolerance this classification was made against. */
  toleranceMinor: number;
  /** The audit sentence an operator trace shows. */
  explanation: string;
}

/** One accounting component of a retail order, for #123 and #128. */
export interface RetailAccountingEntry {
  output: RetailAccountingOutput;
  amount: Money;
}
