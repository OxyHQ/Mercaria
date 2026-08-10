/**
 * Zero-profit cost reconciliation for `mercaria_retail` (#128, ADR 0004
 * D7/D8).
 *
 * #120 composes a cost-only customer amount and classifies a variance; #123
 * observes an actual and writes it down; this is where the actuals from every
 * source are gathered, the equation is evaluated, and the answer is BOOKED.
 *
 * ## This file replaces realized-margin reporting with cost reconciliation
 *
 * The expected item margin on a retail order is zero, so there is no margin to
 * report and nothing here computes one. A positive difference between what the
 * buyer paid and what the order finally cost is the BUYER's money and can only
 * become {@link RetailAccountingComponent} `customer_adjustment_payable`; a
 * negative one is Mercaria's loss and can only become
 * `mercaria_absorbed_variance`. There is no third destination, in this file or
 * in the schema it types.
 *
 * ## The prohibition is a TYPE, in the house style
 *
 * {@link RETAIL_ACCOUNTING_COMPONENTS} (the twelve #128 requires to be
 * represented separately) and {@link RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS}
 * (the fourteen that may never exist) are DISJOINT unions, exactly as #120's
 * cost components and #121's resale evidence are. The allowed tuple renders the
 * `retail_reconciliation_components.component` CHECK; the forbidden tuple is
 * never stored anywhere and exists so a refusal can name what a caller reached
 * for — an operator publishing a policy with `marginTargetBps` is told it is a
 * `planned_margin`, not that they made a typo.
 *
 * ## The tolerance is tiny, CURRENCY-AWARE and versioned, and it is not a bucket
 *
 * {@link RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR} is derived from
 * `CURRENCY_PRECISION`, so "five cents" means the same thing in EUR, in JPY
 * (which has no minor unit at all) and in FAIR (which has eight decimals). A
 * single minor-unit number shared across currencies would be five hundredths of
 * a euro and five hundred-millionths of a FAIR — the same integer describing two
 * unrelated quantities. The bound is a CHECK rendered from this map, so widening
 * it is a schema change under review rather than a configuration value.
 *
 * And {@link RETAIL_ADJUSTMENT_FINALITY_DISPOSITIONS} has no member meaning
 * "keep it": an adjustment Mercaria retained at finality would be exactly the
 * profit bucket this whole issue forbids, so the disposition that would express
 * it has no representation.
 */

import type { CurrencyCode, FxRateSnapshot, Money } from './money';
import { CURRENCY_PRECISION } from './money';

/* -------------------------------------------------------------------------- */
/*  The twelve separately represented accounting components                    */
/* -------------------------------------------------------------------------- */

/**
 * The TWELVE components #128 requires a retail order's money to be represented
 * as, separately, in the order's applicable currencies.
 *
 * Separately is the operative word: each one reconciles against its own
 * evidence, so folding supplier handling into the item cost, or the provider fee
 * into "other", destroys the only thing that makes a variance explicable.
 *
 *  1. `customer_charge` — what the buyer paid and the provider cleared.
 *  2. `supplier_item_cost` — the payable or paid procurement cost of the goods.
 *  3. `supplier_handling_cost` — mandatory handling / pick-pack.
 *  4. `fulfilment_shipping_cost` — shipping and other direct fulfilment cost.
 *  5. `tax_duty_liability` — customer tax, VAT, customs and duty.
 *  6. `provider_processing_cost` — the ACTUAL attributable payment-processing
 *     and FX cost, trued to the provider's own balance transaction.
 *  7. `mercaria_promotion_subsidy` — the promotion Mercaria funded, which is
 *     why the equation's customer term is "before explicit Mercaria subsidy".
 *  8. `customer_refund` — money returned to the buyer.
 *  9. `supplier_credit` — supplier refunds and credit notes.
 * 10. `customer_adjustment_payable` — owed back for a material positive
 *     variance. An OUTPUT of the equation, never an input.
 * 11. `mercaria_absorbed_variance` — final cost above the locked amount. Also
 *     an output.
 * 12. `dispute_movement` — chargeback principal and fee movements.
 */
export type RetailAccountingComponent =
  | 'customer_charge'
  | 'supplier_item_cost'
  | 'supplier_handling_cost'
  | 'fulfilment_shipping_cost'
  | 'tax_duty_liability'
  | 'provider_processing_cost'
  | 'mercaria_promotion_subsidy'
  | 'customer_refund'
  | 'supplier_credit'
  | 'customer_adjustment_payable'
  | 'mercaria_absorbed_variance'
  | 'dispute_movement';

/** {@link RetailAccountingComponent} as the tuple the columns and CHECKs read. */
export const RETAIL_ACCOUNTING_COMPONENTS: readonly RetailAccountingComponent[] = [
  'customer_charge',
  'supplier_item_cost',
  'supplier_handling_cost',
  'fulfilment_shipping_cost',
  'tax_duty_liability',
  'provider_processing_cost',
  'mercaria_promotion_subsidy',
  'customer_refund',
  'supplier_credit',
  'customer_adjustment_payable',
  'mercaria_absorbed_variance',
  'dispute_movement',
];

/**
 * The FOURTEEN components that may never exist for `mercaria_retail`.
 *
 * Disjoint from {@link RETAIL_ACCOUNTING_COMPONENTS} by construction, and
 * asserted so by a test. Nothing stores one — no column, no DTO field and no
 * policy option accepts one — so the union exists purely so a refusal can name
 * the exact prohibited thing rather than answering "unrecognized field".
 *
 * Read the list as the ways a zero-profit sale could quietly grow a profit: a
 * planned one (`planned_margin`, `item_profit`), a measured one
 * (`realized_margin`, `gross_profit`), one made of residue
 * (`rounding_profit`, `tolerance_retention`), one made of somebody else's money
 * (`unclaimed_adjustment_revenue`, `breakage_revenue`, `supplier_credit_revenue`,
 * `variance_revenue`), and one made by attaching the sale to another domain's
 * economics (`referral_margin_base`, `paid_placement_revenue`).
 */
export type RetailForbiddenAccountingComponent =
  | 'retail_margin_revenue'
  | 'retail_markup_revenue'
  | 'gross_profit'
  | 'net_profit'
  | 'planned_margin'
  | 'realized_margin'
  | 'item_profit'
  | 'rounding_profit'
  | 'tolerance_retention'
  | 'variance_revenue'
  | 'unclaimed_adjustment_revenue'
  | 'supplier_credit_revenue'
  | 'breakage_revenue'
  | 'referral_margin_base';

/** {@link RetailForbiddenAccountingComponent} as a tuple, for exhaustive iteration. */
export const RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS: readonly RetailForbiddenAccountingComponent[] =
  [
    'retail_margin_revenue',
    'retail_markup_revenue',
    'gross_profit',
    'net_profit',
    'planned_margin',
    'realized_margin',
    'item_profit',
    'rounding_profit',
    'tolerance_retention',
    'variance_revenue',
    'unclaimed_adjustment_revenue',
    'supplier_credit_revenue',
    'breakage_revenue',
    'referral_margin_base',
  ];

/**
 * Why each forbidden component can never exist, used verbatim in the refusal so
 * the answer explains the policy rather than citing a schema.
 */
export const RETAIL_FORBIDDEN_ACCOUNTING_COMPONENT_LABELS: Record<
  RetailForbiddenAccountingComponent,
  string
> = {
  retail_margin_revenue:
    'a retail margin revenue account — ADR 0004 D7 leaves no account in which a retail margin could accumulate, and adding one is what the zero-profit proof exists to prevent',
  retail_markup_revenue:
    'a retail markup revenue account — markup on a `mercaria_retail` order is zero by construction (#120), so there is nothing for it to hold',
  gross_profit:
    'a gross-profit figure — retail is cost recovery; the difference between the customer amount and the final attributable cost is COST VARIANCE and belongs to the buyer or to Mercaria as a loss',
  net_profit: 'a net-profit figure — the same, after the same costs; see `gross_profit`',
  planned_margin:
    'a planned margin — the planned item margin on a retail order is zero, so there is no target to record',
  realized_margin:
    'a realized margin — #128 replaces realized-margin reporting with cost reconciliation outright; the number would be variance under a name that invites keeping it',
  item_profit:
    'a per-item profit — retail sells at documented cost; a profit component has no account to land in',
  rounding_profit:
    'rounding residue kept as income — the tolerance bounds AUTOMATION, never classification, and residue is variance like any other difference',
  tolerance_retention:
    'variance retained because it fell inside the tolerance — the tolerance is a threshold for acting, not a licence to keep',
  variance_revenue:
    'positive cost variance recognized as revenue — a surplus is the customer’s and can only reach `customer_adjustment_payable`',
  unclaimed_adjustment_revenue:
    'an unclaimed customer adjustment recognized as income — an adjustment nobody collected is still owed; the finality dispositions have no member meaning "keep it"',
  supplier_credit_revenue:
    'a supplier credit recognized as retail revenue — a credit reduces the final attributable cost, which is what may create a customer adjustment (#128 supplier-credit rule 5)',
  breakage_revenue:
    'breakage — money owed to buyers who never collected it is not income at any horizon',
  referral_margin_base:
    'a margin base for referral rewards — `mercaria_retail` produces none, and a referral reward can neither consume positive cost variance nor delay a customer adjustment (#128 referral boundary)',
};

/**
 * Which side of the zero-profit equation a component enters.
 *
 * A separate map rather than a sign on the row, because the SIGN is a property
 * of the component's meaning and not of the amount somebody recorded. Every
 * stored amount is a non-negative magnitude; a signed column would let a
 * supplier credit be written as a negative cost by one writer and a positive
 * recovery by another, and both would balance.
 *
 *  - `customer_inflow` — money the buyer paid in.
 *  - `customer_outflow` — money returned to the buyer, however it went back.
 *  - `mercaria_funded` — the part of the customer amount Mercaria itself paid,
 *    which is why the equation's customer term is "before subsidy".
 *  - `attributable_cost` — a term of the final attributable cost.
 *  - `cost_recovery` — money that came BACK against a cost, reducing it.
 *  - `variance_disposition` — an OUTPUT of the equation. Neither side reads it,
 *    which is what stops a disposition being fed back in as if it were a cost.
 */
export type RetailComponentRole =
  | 'customer_inflow'
  | 'customer_outflow'
  | 'mercaria_funded'
  | 'attributable_cost'
  | 'cost_recovery'
  | 'variance_disposition';

/** {@link RetailComponentRole} for each of the twelve. Exhaustive by the `Record`. */
export const RETAIL_COMPONENT_ROLES: Record<RetailAccountingComponent, RetailComponentRole> = {
  customer_charge: 'customer_inflow',
  supplier_item_cost: 'attributable_cost',
  supplier_handling_cost: 'attributable_cost',
  fulfilment_shipping_cost: 'attributable_cost',
  tax_duty_liability: 'attributable_cost',
  provider_processing_cost: 'attributable_cost',
  mercaria_promotion_subsidy: 'mercaria_funded',
  customer_refund: 'customer_outflow',
  supplier_credit: 'cost_recovery',
  customer_adjustment_payable: 'variance_disposition',
  mercaria_absorbed_variance: 'variance_disposition',
  dispute_movement: 'customer_outflow',
};

/* -------------------------------------------------------------------------- */
/*  Evidence                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The authoritative records a reconciliation may be built from (#128
 * "Reconciliation sources").
 *
 * A closed set, and the closure is the enforcement of "never infer final cost
 * from the current catalog price after the order": there is no
 * `catalog_price` member, no `procurement_offer` member and no
 * `current_supplier_quote` member, so a live price has no evidence shape to
 * arrive in. The gatherer reads only frozen records, and a scanned gate fails
 * the build if this domain learns to import a catalogue read.
 */
export type RetailReconciliationEvidenceKind =
  | 'stripe_payment'
  | 'stripe_processing_fee'
  | 'stripe_refund'
  | 'stripe_dispute'
  | 'purchase_order'
  | 'supplier_invoice'
  | 'supplier_credit_note'
  | 'fulfilment_charge'
  | 'tax_duty_record'
  | 'retail_cost_quote'
  | 'promotion_subsidy'
  | 'customer_refund_record';

/** {@link RetailReconciliationEvidenceKind} as the tuple the columns and CHECKs read. */
export const RETAIL_RECONCILIATION_EVIDENCE_KINDS: readonly RetailReconciliationEvidenceKind[] = [
  'stripe_payment',
  'stripe_processing_fee',
  'stripe_refund',
  'stripe_dispute',
  'purchase_order',
  'supplier_invoice',
  'supplier_credit_note',
  'fulfilment_charge',
  'tax_duty_record',
  'retail_cost_quote',
  'promotion_subsidy',
  'customer_refund_record',
];

/* -------------------------------------------------------------------------- */
/*  The verdict                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether a reconciliation had everything it needed.
 *
 * TWO values and a biconditional CHECK against the outcome column, so an
 * incomplete reconciliation has no outcome at all. #128 acceptance 7: missing
 * evidence creates an operator exception instead of a fabricated zero cost — and
 * the way a fabricated zero arrives is a component nobody could evidence being
 * summed as 0 into an otherwise confident total.
 */
export type RetailReconciliationCompleteness = 'complete' | 'missing_evidence';

/** {@link RetailReconciliationCompleteness} as the tuple the columns and CHECKs read. */
export const RETAIL_RECONCILIATION_COMPLETENESS_STATES: readonly RetailReconciliationCompleteness[] =
  ['complete', 'missing_evidence'];

/**
 * The FOUR interpretations of a cost variance (#128 "Zero-profit reconciliation
 * equation").
 *
 * `cost_recovered_exactly` and `within_rounding_tolerance` are kept apart
 * deliberately, where #120's three-valued {@link
 * import('./retail-pricing').RetailVarianceDisposition} folds them together:
 * "orders reconciled exactly to cost" is #128's first metric, and a metric that
 * counted rounded-off orders as exact would report a precision the reconciliation
 * does not have.
 *
 * There is no fifth member, and in particular none meaning "recognized". A
 * variance that has been booked is still one of these four; what changed is the
 * ledger, not the classification.
 */
export type RetailReconciliationOutcome =
  | 'cost_recovered_exactly'
  | 'within_rounding_tolerance'
  | 'customer_adjustment_required'
  | 'mercaria_absorbed';

/** {@link RetailReconciliationOutcome} as the tuple the columns and CHECKs read. */
export const RETAIL_RECONCILIATION_OUTCOMES: readonly RetailReconciliationOutcome[] = [
  'cost_recovered_exactly',
  'within_rounding_tolerance',
  'customer_adjustment_required',
  'mercaria_absorbed',
];

/**
 * Why a reconciliation could not be completed. Named rather than free text
 * because each routes to a different remedy, and every one of them is an
 * operator exception rather than an assumed zero.
 */
export type RetailReconciliationExceptionKind =
  | 'missing_supplier_invoice'
  | 'missing_provider_fee'
  | 'missing_tax_determination'
  | 'missing_cost_quote'
  | 'missing_customer_refund_record'
  | 'unlinked_supplier_credit'
  | 'duplicate_supplier_charge'
  | 'duplicate_customer_credit'
  | 'currency_unconvertible'
  | 'adjustment_refund_failed'
  | 'absorbed_variance_over_threshold'
  | 'recurring_quote_inaccuracy';

/** {@link RetailReconciliationExceptionKind} as the tuple the columns and CHECKs read. */
export const RETAIL_RECONCILIATION_EXCEPTION_KINDS: readonly RetailReconciliationExceptionKind[] = [
  'missing_supplier_invoice',
  'missing_provider_fee',
  'missing_tax_determination',
  'missing_cost_quote',
  'missing_customer_refund_record',
  'unlinked_supplier_credit',
  'duplicate_supplier_charge',
  'duplicate_customer_credit',
  'currency_unconvertible',
  'adjustment_refund_failed',
  'absorbed_variance_over_threshold',
  'recurring_quote_inaccuracy',
];

/**
 * The exception kinds that BLOCK a verdict, as opposed to reporting one.
 *
 * A subset rather than a second list: `absorbed_variance_over_threshold` and
 * `recurring_quote_inaccuracy` are raised ABOUT a completed reconciliation and
 * must not make it incomplete, while every `missing_*` kind means a term of the
 * equation has no evidence and summing it as zero is the fabrication acceptance
 * 7 forbids.
 */
export const RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS: readonly RetailReconciliationExceptionKind[] =
  [
    'missing_supplier_invoice',
    'missing_provider_fee',
    'missing_tax_determination',
    'missing_cost_quote',
    'missing_customer_refund_record',
    'unlinked_supplier_credit',
    'currency_unconvertible',
  ];

/* -------------------------------------------------------------------------- */
/*  The customer adjustment                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How a positive variance actually reaches the buyer.
 *
 *  - `provider_refund` — a partial refund down the original rail, which #128
 *    item 3 prefers wherever it is supported and accountingly correct.
 *  - `recorded_payable` — the obligation stands and the money has not moved
 *    (item 4). It is a real, operator-visible state with a reason and a retry
 *    path, never a quiet write-off.
 */
export type RetailAdjustmentMethod = 'provider_refund' | 'recorded_payable';

/** {@link RetailAdjustmentMethod} as the tuple the columns and CHECKs read. */
export const RETAIL_ADJUSTMENT_METHODS: readonly RetailAdjustmentMethod[] = [
  'provider_refund',
  'recorded_payable',
];

/**
 * Where one customer adjustment stands.
 *
 * `refund_failed` is terminal for the ATTEMPT and not for the obligation: the
 * amount is still owed, the row stays open, and the retry drives the same
 * idempotent refund path. Collapsing it into `payable_recorded` would lose the
 * distinction between "we have not tried" and "we tried and the rail refused",
 * which are the two states an operator has to tell apart.
 */
export type RetailAdjustmentState =
  | 'owed'
  | 'refund_committed'
  | 'refund_settled'
  | 'refund_failed'
  | 'payable_recorded'
  | 'closed_at_finality';

/** {@link RetailAdjustmentState} as the tuple the columns and CHECKs read. */
export const RETAIL_ADJUSTMENT_STATES: readonly RetailAdjustmentState[] = [
  'owed',
  'refund_committed',
  'refund_settled',
  'refund_failed',
  'payable_recorded',
  'closed_at_finality',
];

/**
 * Why an adjustment could not be refunded automatically (#128 item 4's
 * "operator-visible reason").
 *
 * Several codes rather than one, unlike a buyer-facing refusal: this surface is
 * behind an operator allow-list and its whole purpose is to say what to do next.
 * The house rule that a refusal spanning several conditions gets ONE reason code
 * defends against a CLIENT reading out a switchboard by varying inputs, and
 * there is no client here to do that.
 */
export type RetailAdjustmentBlockReason =
  | 'provider_refund_unavailable'
  | 'payment_not_settled'
  | 'dispute_open'
  | 'below_automation_threshold'
  | 'prior_adjustment_exhausts_charge'
  | 'currency_unconvertible';

/** {@link RetailAdjustmentBlockReason} as the tuple the columns and CHECKs read. */
export const RETAIL_ADJUSTMENT_BLOCK_REASONS: readonly RetailAdjustmentBlockReason[] = [
  'provider_refund_unavailable',
  'payment_not_settled',
  'dispute_open',
  'below_automation_threshold',
  'prior_adjustment_exhausts_charge',
  'currency_unconvertible',
];

/**
 * What happens at finality to an adjustment the buyer never received.
 *
 * TWO members, and the absent third is the point: there is no `retain`, no
 * `recognize_as_income` and no `write_off_to_revenue`, because an adjustment
 * Mercaria kept would be the profit bucket ADR 0004 D7 leaves no account for.
 * `keep_open` is the honest alternative to keeping the money — the obligation
 * simply does not expire.
 */
export type RetailAdjustmentFinalityDisposition = 'refund_remaining' | 'keep_open';

/** {@link RetailAdjustmentFinalityDisposition} as the tuple the columns and CHECKs read. */
export const RETAIL_ADJUSTMENT_FINALITY_DISPOSITIONS: readonly RetailAdjustmentFinalityDisposition[] =
  ['refund_remaining', 'keep_open'];

/* -------------------------------------------------------------------------- */
/*  Supplier credits                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What one supplier credit MEANS for the customer side (#128 "Supplier credits
 * and returns").
 *
 *  - `return_linked` — it accompanies a customer return. It reconciles against
 *    the return/refund lifecycle and does NOT reduce an already-promised
 *    customer refund (rule 2). Both movements are represented, so the variance
 *    is unchanged by the pair.
 *  - `cost_reduction` — unrelated to a customer return, and it lowers the final
 *    attributable cost of the sale. Under the zero-profit policy that is exactly
 *    what may create a customer adjustment (rule 3).
 *  - `unattributable` — Mercaria cannot say which sale it belongs to. It is
 *    recorded and raises `unlinked_supplier_credit`; guessing would either
 *    invent a customer adjustment or hide one.
 */
export type RetailSupplierCreditClassification =
  | 'return_linked'
  | 'cost_reduction'
  | 'unattributable';

/** {@link RetailSupplierCreditClassification} as the tuple the columns and CHECKs read. */
export const RETAIL_SUPPLIER_CREDIT_CLASSIFICATIONS: readonly RetailSupplierCreditClassification[] =
  ['return_linked', 'cost_reduction', 'unattributable'];

/* -------------------------------------------------------------------------- */
/*  Policy versions and tolerances                                             */
/* -------------------------------------------------------------------------- */

/** A reconciliation policy version's lifecycle — the `fee_schedules` shape. */
export type RetailReconciliationPolicyStatus = 'draft' | 'active' | 'superseded' | 'retired';

/** {@link RetailReconciliationPolicyStatus} as the tuple the columns and CHECKs read. */
export const RETAIL_RECONCILIATION_POLICY_STATUSES: readonly RetailReconciliationPolicyStatus[] = [
  'draft',
  'active',
  'superseded',
  'retired',
];

/**
 * How many roundings of a two-decimal currency the tolerance may cover, at most.
 *
 * Five, matching `RETAIL_MAX_ROUNDING_TOLERANCE_MINOR` in `./retail-pricing`,
 * because the two bound the same physical thing at two stages and a different
 * ceiling at each would mean a difference #120 refused to hide could be hidden
 * here.
 */
export const RETAIL_RECONCILIATION_MAX_TOLERANCE_UNITS = 5;

/**
 * `10^(precision − 2)`, floored at 1 — how many of a currency's minor units
 * make up one hundredth of a major unit.
 *
 * The whole of "currency-aware". One euro cent is one EUR minor unit and
 * 1,000,000 FAIR minor units, and a tolerance expressed as a bare integer would
 * be five hundredths of a euro and five hundred-millionths of a FAIR — the same
 * number describing two unrelated quantities, with the FAIR one so small that
 * every conversion residue would read as material variance.
 *
 * JPY has no minor unit at all (`CURRENCY_PRECISION.JPY === 0`), so the floor of
 * 1 makes the scale one yen: the smallest amount that currency can express, and
 * the only honest answer for it.
 */
function centEquivalentMinorUnits(currency: CurrencyCode): number {
  return Math.max(1, 10 ** Math.max(0, CURRENCY_PRECISION[currency] - 2));
}

/**
 * The largest rounding tolerance a policy version may configure, PER CURRENCY.
 *
 * Rendered into the `retail_reconciliation_tolerances` CHECK from this map, so
 * the bound holds against `psql`, a backfill and a service bug alike. Raising it
 * is a schema change under review, which is what stops "a tiny rounding
 * tolerance" from being widened into a place to keep material variance.
 */
export const RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR: Readonly<Record<CurrencyCode, number>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(CURRENCY_PRECISION) as CurrencyCode[]).map((currency) => [
        currency,
        RETAIL_RECONCILIATION_MAX_TOLERANCE_UNITS * centEquivalentMinorUnits(currency),
      ]),
    ) as Record<CurrencyCode, number>,
  );

/**
 * The tolerance a policy version gets if it names none for a currency: ONE
 * hundredth of a major unit, which is exactly what a single half-even rounding
 * can produce.
 */
export const RETAIL_RECONCILIATION_DEFAULT_TOLERANCE_MINOR: Readonly<
  Record<CurrencyCode, number>
> = Object.freeze(
  Object.fromEntries(
    (Object.keys(CURRENCY_PRECISION) as CurrencyCode[]).map((currency) => [
      currency,
      centEquivalentMinorUnits(currency),
    ]),
  ) as Record<CurrencyCode, number>,
);

/**
 * ADR 0004 D8.2's materiality threshold for AUTOMATIC adjustment — 1.00 EUR
 * equivalent per order — expressed per currency as one major unit.
 *
 * It bounds automation and never classification: a sub-threshold surplus is
 * still recorded as an adjustment, still owed, and still refundable on request.
 * What it decides is whether Mercaria calls the rail without being asked.
 */
export const RETAIL_ADJUSTMENT_DEFAULT_AUTOMATION_FLOOR_MINOR: Readonly<
  Record<CurrencyCode, number>
> = Object.freeze(
  Object.fromEntries(
    (Object.keys(CURRENCY_PRECISION) as CurrencyCode[]).map((currency) => [
      currency,
      10 ** CURRENCY_PRECISION[currency],
    ]),
  ) as Record<CurrencyCode, number>,
);

/**
 * The largest automation floor a policy version may configure — one HUNDRED
 * major units, per currency.
 *
 * A ceiling rather than an open number, because the floor decides when Mercaria
 * refunds a surplus without being asked, and a version that set it to a
 * thousand euros would leave "we return what we over-charged automatically"
 * true of no real order while still reading as configured. It is deliberately
 * far looser than the ROUNDING tolerance's bound: this one only delays a
 * refund a buyer can still request, where that one decides whether a difference
 * is acknowledged at all.
 */
export const RETAIL_ADJUSTMENT_MAX_AUTOMATION_FLOOR_MINOR: Readonly<Record<CurrencyCode, number>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(CURRENCY_PRECISION) as CurrencyCode[]).map((currency) => [
        currency,
        100 * 10 ** CURRENCY_PRECISION[currency],
      ]),
    ) as Record<CurrencyCode, number>,
  );

/** ADR 0004 D8.6's operational ceiling on an order's cost reconciliation. */
export const RETAIL_RECONCILIATION_FINALITY_CEILING_DAYS = 180;

/* -------------------------------------------------------------------------- */
/*  Ledger recognition                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The SIX movements #128 books, each claimed before it is booked.
 *
 * They are ADR 0004 D7's table minus the two rows other issues already own (a
 * retail charge is `chargeSucceeded`'s, a compensating refund is #49's) and
 * minus the two the ledger deliberately does not express — see below.
 *
 * ## The claim is what makes a repeat a no-op
 *
 * `ledger_transactions` has no natural key a second booking would collide with,
 * and the append-only trigger means a duplicate can never be cleaned up. So
 * every posting is preceded by an `INSERT … ON CONFLICT DO NOTHING … RETURNING`
 * on `retail_ledger_recognitions`, whose empty-versus-one-row result IS the
 * "already booked" answer — the moderation-event device, in the one domain where
 * getting it wrong duplicates money rather than a notification. The claim and
 * the posting commit in ONE transaction, so a crash between them is not a state.
 *
 * ## What is NOT here, and why each absence is deliberate
 *
 * **A negative variance books nothing.** Mercaria absorbing a shortfall is not a
 * movement: the costs were booked as `procurement_expense` when they were
 * incurred, and the absorption is visible as ADR 0004 D7 proof 2's strict
 * inequality between recovery and cost. A posting for it would be an entry
 * against itself.
 *
 * **A tax or duty liability books nothing.** The chart of accounts has no tax
 * account, and #128 does not add one: representing the component separately is
 * what this issue asks for, and deciding where destination VAT sits in
 * Mercaria's books is an OSS-reporting decision with its own owner. The customer
 * tax is inside the charge already credited to `retail_cost_recovery`.
 */
export type RetailLedgerRecognitionKind =
  | 'prefund_top_up'
  | 'procurement_settled'
  | 'direct_fulfilment_cost'
  | 'supplier_credit'
  | 'variance_recognized'
  | 'adjustment_refunded';

/** {@link RetailLedgerRecognitionKind} as the tuple the columns and CHECKs read. */
export const RETAIL_LEDGER_RECOGNITION_KINDS: readonly RetailLedgerRecognitionKind[] = [
  'prefund_top_up',
  'procurement_settled',
  'direct_fulfilment_cost',
  'supplier_credit',
  'variance_recognized',
  'adjustment_refunded',
];

/* -------------------------------------------------------------------------- */
/*  Metrics                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The TEN metrics #128 tracks.
 *
 * Read the ABSENCES: there is no gross margin, no profit, no take rate and no
 * contribution. #128 says so in words ("do not publish gross margin or profit as
 * a target metric for `mercaria_retail`; expected planned margin is zero"), and
 * this tuple is what makes it a value a test can run — the metric surface 404s a
 * key that is not in it, so a margin figure has no key to be served under.
 */
export type RetailReconciliationMetricKey =
  | 'orders_reconciled_exactly'
  | 'positive_adjustment_variance'
  | 'negative_absorbed_variance'
  | 'quote_to_invoice_variance'
  | 'supplier_credit_latency'
  | 'missing_evidence'
  | 'duplicate_charge_or_credit'
  | 'adjustment_refund_success'
  | 'cost_quote_accuracy_percentile'
  | 'mercaria_subsidy_spend';

/** {@link RetailReconciliationMetricKey} as the tuple the read surface reads. */
export const RETAIL_RECONCILIATION_METRIC_KEYS: readonly RetailReconciliationMetricKey[] = [
  'orders_reconciled_exactly',
  'positive_adjustment_variance',
  'negative_absorbed_variance',
  'quote_to_invoice_variance',
  'supplier_credit_latency',
  'missing_evidence',
  'duplicate_charge_or_credit',
  'adjustment_refund_success',
  'cost_quote_accuracy_percentile',
  'mercaria_subsidy_spend',
];

/**
 * Field names that may never appear in anything this domain emits.
 *
 * The prohibition as a VALUE, walked at RUNTIME over a real emitted projection
 * as well as scanned statically — the `SELLER_PROFILE_FORBIDDEN_FIELDS` and
 * `PRICE_HISTORY_FORBIDDEN_DTO_FIELDS` device. A static scan sees the fields
 * somebody wrote; the walk sees the fields the code actually produced.
 */
export const RETAIL_RECONCILIATION_FORBIDDEN_DTO_FIELDS: readonly string[] = [
  'margin',
  'marginBps',
  'marginMinor',
  'grossMargin',
  'grossProfit',
  'netProfit',
  'profit',
  'profitMinor',
  'markup',
  'markupBps',
  'markupMinor',
  'takeRate',
  'contributionMargin',
  'realizedMargin',
];

/* -------------------------------------------------------------------------- */
/*  Operator surface                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The writes the reconciliation operator surface offers — a CLOSED set, each
 * driving a path that already exists and is already idempotent.
 *
 * There is deliberately no "set this variance", no "waive this adjustment", no
 * "override this cost" and no delete. Every member below is a TRIGGER for
 * machinery the sweep runs on its own, so the surface adds a button and no new
 * way to move money.
 */
export type RetailReconciliationOperatorAction =
  | 'reconcile_order'
  | 'retry_adjustment_refund'
  | 'resolve_exception';

/** {@link RetailReconciliationOperatorAction} as the tuple the columns and CHECKs read. */
export const RETAIL_RECONCILIATION_OPERATOR_ACTIONS: readonly RetailReconciliationOperatorAction[] =
  ['reconcile_order', 'retry_adjustment_refund', 'resolve_exception'];

/**
 * What one operator attempt did. `refused` is a first-class outcome and is
 * AUDITED like the others — an attempt the surface declined is exactly what an
 * incident review needs to see.
 */
export type RetailReconciliationOperatorOutcome = 'applied' | 'no_op' | 'refused';

/** {@link RetailReconciliationOperatorOutcome} as the tuple the columns and CHECKs read. */
export const RETAIL_RECONCILIATION_OPERATOR_OUTCOMES: readonly RetailReconciliationOperatorOutcome[] =
  ['applied', 'no_op', 'refused'];

/* -------------------------------------------------------------------------- */
/*  Projections                                                                */
/* -------------------------------------------------------------------------- */

/** One component of one reconciliation, with its own currencies intact. */
export interface RetailReconciliationComponentView {
  component: RetailAccountingComponent;
  role: RetailComponentRole;
  /** The amount as the SOURCE stated it, in the source's own currency. */
  sourceAmount: Money;
  /** The same amount in the reconciliation's accounting currency. */
  accountingAmount: Money;
  /** The exact conversion — present exactly when the two currencies differ. */
  fxSnapshot?: FxRateSnapshot;
  /** How many evidence records contributed to this figure. */
  evidenceCount: number;
}

/** One evidence record a reconciliation consumed, for the correlation trail. */
export interface RetailReconciliationEvidenceView {
  kind: RetailReconciliationEvidenceKind;
  /** The durable id of the record — a Mercaria id, or a provider's own reference. */
  reference: string;
  observedAt: string;
  amount?: Money;
}

/** One open or resolved reconciliation exception. */
export interface RetailReconciliationExceptionView {
  id: string;
  kind: RetailReconciliationExceptionKind;
  orderId: string;
  detail: string;
  raisedAt: string;
  resolvedAt?: string;
  resolvedByOxyUserId?: string;
  resolutionReason?: string;
}

/** One customer adjustment, as the operator surface shows it. */
export interface RetailCustomerAdjustmentView {
  id: string;
  orderId: string;
  reconciliationRevision: number;
  amount: Money;
  method: RetailAdjustmentMethod;
  state: RetailAdjustmentState;
  blockReason?: RetailAdjustmentBlockReason;
  /** ADR 0004 D8.7: recorded explicitly rather than hidden as Mercaria margin. */
  nonRefundableProviderCost?: Money;
  refundId?: string;
  notifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One supplier credit and everything it is linked to. */
export interface RetailSupplierCreditView {
  id: string;
  classification: RetailSupplierCreditClassification;
  purchaseOrderId: string;
  /** The supplier's own invoice reference this credit reverses, when it names one. */
  supplierInvoiceReference?: string;
  orderId?: string;
  amount: Money;
  accountingAmount: Money;
  issuedAt: string;
  recordedAt: string;
  /** The ledger transaction that booked it, once #128 has. */
  ledgerTransactionId?: string;
}

/**
 * The whole reconciliation view #128's operator surface exposes — its twelve
 * numbered items, in order.
 *
 * A different TYPE from anything a buyer or a merchant sees, the `MerchantOrder`
 * device: it carries supplier wholesale figures, so a serializer that handed it
 * to a public surface would be handing over the cost of goods. Nothing here is
 * reachable without the procurement operator allow-list.
 */
export interface RetailReconciliationView {
  orderId: string;
  revision: number;
  policyKey: string;
  policyVersion: number;
  completeness: RetailReconciliationCompleteness;
  /** Present EXACTLY when `completeness` is `complete`. */
  outcome?: RetailReconciliationOutcome;
  accountingCurrency: CurrencyCode;
  /** 1. What the buyer paid, and 7. the final attributable cost. */
  customerAmountBeforeSubsidy: Money;
  finalAttributableCost: Money;
  /** 8. `customerAmountBeforeSubsidy − finalAttributableCost`. Signed. */
  costVarianceMinor: number;
  toleranceMinor: number;
  /** 2–7. Every component, separately, with its own currencies. */
  components: RetailReconciliationComponentView[];
  /** 12. The full correlation trail. */
  evidence: RetailReconciliationEvidenceView[];
  /** 5. Supplier credits and refunds. */
  supplierCredits: RetailSupplierCreditView[];
  /** 9. Customer adjustment status. */
  adjustment?: RetailCustomerAdjustmentView;
  /** 11. Missing evidence and mismatch reasons. */
  exceptions: RetailReconciliationExceptionView[];
  computedAt: string;
  finalisedAt?: string;
}
