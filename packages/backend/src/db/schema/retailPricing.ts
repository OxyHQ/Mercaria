/**
 * The zero-margin retail pricing domain (#120, ADR 0004 D3):
 * `retail_pricing_policies`, `retail_cost_quotes`,
 * `retail_cost_quote_components`, `retail_cost_quote_acceptances`.
 *
 * `mercaria_retail` is COST RECOVERY. The buyer pays the documented cost of
 * acquiring and fulfilling the order; Mercaria's planned item profit is zero.
 * Four tables exist so that is a property of the database rather than of
 * whoever writes the next service.
 *
 * ## The boundaries this file exists to hold
 *
 * **Markup is unrepresentable, not defaulted to zero.** There is no
 * `markup_bps`, no `margin_target_bps`, no `min_profit_amount` and no padding
 * column anywhere below — and none may be added.
 * `retail_pricing_policies.absorption_cap_bps` is the ONE basis-point column in
 * the domain and it bounds what Mercaria ABSORBS before cancelling and
 * refunding (ADR 0004 D3); it can only ever cost Mercaria money. The customer
 * total is the exact SUM of the component rows, held by
 * `retail_cost_quotes_total_is_sum_of_components` — a deferred constraint would
 * be the wrong tool (components arrive after the parent), so the sum is
 * asserted by the single writer AND re-derived by the realdb test that tries to
 * smuggle an inflated total past it.
 *
 * **An unknown cost is never zero.** `completeness` and `presentation` are tied
 * to each other by CHECK, and `block_reasons` is non-empty exactly when the
 * quote is not `complete` — so a blocked quote cannot be stored claiming an
 * exact cost-only price, and a complete one cannot be stored with an
 * unexplained block.
 *
 * **A promotion is a Mercaria subsidy, structurally.**
 * `buyer_payable_amount = customer_total_amount - coalesce(subsidy_amount, 0)`
 * is a CHECK, the subsidy is bounded to `[0, customer_total]`, and every
 * component amount is non-negative — so a promotion can never raise the item
 * price to fund itself later, and a "negative supplier cost" has no
 * representation.
 *
 * **Supplier costs stay in their SOURCE currency.** Each component carries the
 * source `Money` and the presentment `Money` as two separate pairs, plus the
 * five-column `FxRateSnapshot` of the conversion between them — present exactly
 * when the currencies differ, and naming whether it was Mercaria's QUOTED rate
 * or the provider's FINAL one. Nothing converts a source price on write.
 *
 * **The acceptance is the checkout LOCK.**
 * `UNIQUE(checkout_group_id, quote_id)` makes an idempotent retry converge on
 * the same locked total; a revised total is a NEW quote and a NEW acceptance
 * naming the one it supersedes. Nothing can raise an accepted amount, because
 * nothing can update an acceptance row at all.
 *
 * ## What is deliberately absent
 *
 * - **No `retail_margin_revenue`, and no column that could hold an item
 *   profit.** ADR 0004 D7's zero-profit proof is that no such account exists;
 *   giving this domain one would defeat it in the one place it is provable.
 * - **No stored variance table.** Classifying a final-versus-locked difference
 *   is pure (`services/retail-pricing/retail-variance.ts`); BOOKING it is
 *   #128's ledger work, and a second durable record of one fact is exactly what
 *   the ledger rules forbid.
 * - **No `orders` widening.** `commercial_role` / `seller_type = 'platform'`
 *   land with the code that writes them (#123), the same reasoning
 *   `procurement.ts` records. The acceptance carries a plain `order_id`
 *   correlation instead.
 * - **No expiry-sweep registration.** A quote's `expires_at` is a VALIDITY
 *   deadline, not a retention one: these rows are the financial evidence #128
 *   reconciles against, so they are retained like `payments` and never swept.
 *
 * ## Hand-written triggers ride the same migration
 *
 * drizzle-kit does not model triggers, so two enforcement functions are added
 * by hand to this domain's migration, the ledger/fee precedent:
 * `retail_pricing_policies` freezes every policy column once the version leaves
 * `draft`; quotes, their components and their acceptances refuse UPDATE and
 * DELETE outright — with ONE narrow, one-way exception, `acceptances.order_id`
 * moving from NULL to a value exactly once, which is what "freeze the accepted
 * quote onto the order" needs without making the record mutable.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  RETAIL_COST_BLOCK_REASONS,
  RETAIL_COST_COMPONENT_KINDS,
  RETAIL_COST_CONFIDENCES,
  RETAIL_FX_BASES,
  RETAIL_MAX_ROUNDING_TOLERANCE_MINOR,
  RETAIL_PRICE_PRESENTATIONS,
  RETAIL_PRICING_POLICY_STATUSES,
  RETAIL_QUOTE_COMPLETENESS_STATES,
  RETAIL_QUOTE_SUPERSEDE_REASONS,
  RETAIL_SUBSIDY_SOURCES,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
  money,
  optionalMoney,
} from './columns';
import { supplierAccounts, supplierAgreements, suppliers } from './procurement';

/** Bound on any stored note, basis or reference — the `.slice()` at every writer. */
const MAX_NOTE_LENGTH = 2_000;

/**
 * `retail_pricing_policies` — one immutable VERSION of the cost-only pricing
 * policy (#120 quote field 15, ADR 0004 D3.7).
 *
 * ## The columns that exist, and the ones that must never
 *
 * `allowed_component_kinds` is the whole policy lever: it names which of the
 * eight direct-cost components a quote composed under this version may include,
 * and its CHECK is array CONTAINMENT against the shared-types tuple, so a kind
 * outside that set cannot be approved even by a hand-written UPDATE. A second
 * CHECK requires `supplier_item`, because a policy that cannot include the item
 * cost prices nothing.
 *
 * `rounding_tolerance_minor` is CHECK-bounded to
 * {@link RETAIL_MAX_ROUNDING_TOLERANCE_MINOR}. That bound is the structural
 * half of "no material variance may be hidden as rounding": widening the
 * tolerance into a hiding place is a schema change under review, not a
 * configuration an operator can make.
 *
 * `absorption_cap_bps` + `absorption_cap_floor` are ADR 0004 D3's
 * operator-configurable cap on what Mercaria absorbs (default: the greater of
 * 10% and 25 EUR). They bound a LOSS. Nothing here can raise a price.
 */
export const retailPricingPolicies = pgTable(
  'retail_pricing_policies',
  {
    id: generatedId(),
    /** The stable logical id shared by every version (`mercaria-retail-cost-only`). */
    policyKey: text().notNull(),
    /** Monotonic per key, assigned by the operator creating the draft. */
    version: integer().notNull(),
    name: text().notNull(),
    /** The operator-facing statement of what this version approves and why. */
    summary: text().notNull(),
    status: text({ enum: asEnumValues(RETAIL_PRICING_POLICY_STATUSES) })
      .notNull()
      .default('draft'),
    /** The policy applies only inside `[effective_start, effective_end)`. */
    effectiveStart: timestamptz().notNull(),
    /** NULL = open-ended. */
    effectiveEnd: timestamptz(),
    /** The approved subset of `RETAIL_COST_COMPONENT_KINDS`. Always includes the item cost. */
    allowedComponentKinds: text().array().notNull().default([]),
    /** ADR 0004 D3.5: the provider's cost may be passed through only when lawful. */
    paymentCostPassthroughEnabled: boolean().notNull().default(false),
    /** The lawful basis and disclosure reference — mandatory when pass-through is on. */
    paymentCostPassthroughBasis: text(),
    /** How much unexpected cost Mercaria absorbs, as basis points of the order total. */
    absorptionCapBps: integer().notNull().default(1_000),
    /** The absorption FLOOR — the cap is the greater of the two (ADR 0004 D3). */
    ...money('absorptionCapFloor'),
    /** The tiny tolerance below which a delta is rounding rather than variance. */
    roundingToleranceMinor: bigint({ mode: 'number' }).notNull().default(1),
    /** How long a quote composed under this version may be trusted. */
    quoteTtlSeconds: integer().notNull().default(900),
    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text().notNull(),
    /** The operator who activated it — the audit half of "publish a new version". */
    approvedByOxyUserId: text(),
    activatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_pricing_policies_status_check', t.status, RETAIL_PRICING_POLICY_STATUSES),
    checkEveryElementOf(
      'retail_pricing_policies_allowed_components_check',
      t.allowedComponentKinds,
      RETAIL_COST_COMPONENT_KINDS,
    ),
    ...currencyChecks('retail_pricing_policies', [t.absorptionCapFloorCurrency]),
    check('retail_pricing_policies_version_check', sql`${t.version} >= 1`),
    check('retail_pricing_policies_key_check', sql`${t.policyKey} ~ '^[a-z0-9][a-z0-9-]{1,63}$'`),
    // A policy that cannot include the item cost prices nothing.
    check(
      'retail_pricing_policies_item_cost_required_check',
      sql`'supplier_item' = any(${t.allowedComponentKinds})`,
    ),
    // Pass-through is a decision WITH its lawful basis, or it is off.
    check(
      'retail_pricing_policies_payment_passthrough_check',
      sql`${t.paymentCostPassthroughEnabled} = (${t.paymentCostPassthroughBasis} is not null)
          and (${t.paymentCostPassthroughBasis} is null
               or length(btrim(${t.paymentCostPassthroughBasis})) between 1 and ${sql.raw(String(MAX_NOTE_LENGTH))})`,
    ),
    // Pass-through is only meaningful when the component itself is approved.
    check(
      'retail_pricing_policies_payment_component_check',
      sql`not ${t.paymentCostPassthroughEnabled}
          or 'payment_processing' = any(${t.allowedComponentKinds})`,
    ),
    // The absorption cap bounds a LOSS, never a price.
    check(
      'retail_pricing_policies_absorption_cap_check',
      sql`${t.absorptionCapBps} between 0 and 10000 and ${t.absorptionCapFloorAmount} >= 0`,
    ),
    // THE structural half of "no material variance may be hidden as rounding".
    check(
      'retail_pricing_policies_rounding_tolerance_check',
      sql`${t.roundingToleranceMinor} between 0 and ${sql.raw(String(RETAIL_MAX_ROUNDING_TOLERANCE_MINOR))}`,
    ),
    check('retail_pricing_policies_quote_ttl_check', sql`${t.quoteTtlSeconds} >= 1`),
    check(
      'retail_pricing_policies_effective_window_check',
      sql`${t.effectiveEnd} is null or ${t.effectiveEnd} > ${t.effectiveStart}`,
    ),
    // Nothing published is anonymous — the `fee_schedules` activation audit.
    check(
      'retail_pricing_policies_activation_audit_check',
      sql`${t.status} not in ('active', 'superseded')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    uniqueIndex('retail_pricing_policies_key_version_key').on(t.policyKey, t.version),
    // The structural half of "active versions are immutable; publish a new one".
    uniqueIndex('retail_pricing_policies_one_active_per_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * `retail_cost_quotes` — ONE immutable cost-only quote (#120 "Cost quote
 * model"). Append-only from birth: the charged amount is a pure function of
 * this row plus its components, and ADR 0004 D4 step 1 requires the composition
 * to be frozen and hash-pinned BEFORE the PaymentIntent exists.
 *
 * ## The policy is named twice, deliberately
 *
 * `policy_id` is a real RESTRICT foreign key (a published version is never
 * deleted), and `policy_key` + `policy_version` are SNAPSHOT names beside it —
 * the `order_fee_snapshots` rule: the record must state what it was priced
 * under even when read apart from the policy row.
 *
 * ## Supplier identity is a foreign key; catalogue identity is a snapshot
 *
 * `supplier_id` / `supplier_account_id` / `agreement_id` are RESTRICT foreign
 * keys, exactly as `purchase_orders` carries them — those rows have lifecycle
 * states rather than deletes, and an unattributable quote is not evidence.
 * `procurement_offer_id` and the two `canonical_*` columns are SNAPSHOT
 * provenance with NO foreign key (the `purchase_order_lines` rule): offers
 * refresh in place and canonical entities merge, and this row must survive it
 * verbatim.
 *
 * ## Why `customer_total` and `buyer_payable` are BOTH stored
 *
 * They are two different facts. `customer_total` is what the order costs — the
 * exact sum of the components, and the figure #128 reconciles against.
 * `buyer_payable` is what the buyer is charged. The CHECK between them makes
 * the subsidy the ONLY thing that can separate the two, which is what "the
 * subsidy is a Mercaria marketing expense, not a supplier underpayment" means
 * mechanically.
 */
export const retailCostQuotes = pgTable(
  'retail_cost_quotes',
  {
    id: generatedId(),
    /** The policy VERSION this quote was composed under — its terms, by reference. */
    policyId: text()
      .notNull()
      .references(() => retailPricingPolicies.id, { onDelete: 'restrict' }),
    /** The same version as a SNAPSHOT name, readable apart from the policy row. */
    policyKey: text().notNull(),
    policyVersion: integer().notNull(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    agreementId: text()
      .notNull()
      .references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    /** SNAPSHOT provenance — deliberately no foreign key; offers refresh in place. */
    procurementOfferId: text(),
    /** SNAPSHOT provenance — deliberately no foreign key; canonical entities merge. */
    canonicalProductId: text(),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    canonicalVariantId: text(),
    /** The supplier's SKU as quoted — frozen. */
    supplierSku: text().notNull(),
    quantity: integer().notNull(),
    /** ISO-3166-1 alpha-2. NULL = no destination context, so no final total is claimed. */
    destinationCountry: text(),
    destinationRegion: text(),
    /** The currency the buyer sees and pays in — every amount below is in it. */
    presentmentCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** The cost-only total: the exact sum of this quote's components. */
    ...money('customerTotal'),
    /** An explicit Mercaria-funded reduction. All four columns present or absent. */
    ...optionalMoney('subsidy'),
    subsidySource: text({ enum: asEnumValues(RETAIL_SUBSIDY_SOURCES) }),
    subsidyBudgetRef: text(),
    /** What the buyer is charged: `customer_total - coalesce(subsidy, 0)`, by CHECK. */
    ...money('buyerPayable'),
    completeness: text({ enum: asEnumValues(RETAIL_QUOTE_COMPLETENESS_STATES) }).notNull(),
    presentation: text({ enum: asEnumValues(RETAIL_PRICE_PRESENTATIONS) }).notNull(),
    /** Sorted, deduped and non-empty exactly when the quote is not `complete`. */
    blockReasons: text().array().notNull().default([]),
    quotedAt: timestamptz().notNull(),
    /** The validity deadline. NOT a retention deadline — these rows are never swept. */
    expiresAt: timestamptz().notNull(),
    /** sha-256 over the canonical composition — the freeze ADR 0004 D10 requires. */
    contentHash: text().notNull(),
    /** The quote this one replaced, when a re-quote produced it. */
    supersedesQuoteId: text().references((): AnyPgColumn => retailCostQuotes.id, {
      onDelete: 'restrict',
    }),
    supersedeReason: text({ enum: asEnumValues(RETAIL_QUOTE_SUPERSEDE_REASONS) }),
    /** The composition time. No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_cost_quotes_completeness_check',
      t.completeness,
      RETAIL_QUOTE_COMPLETENESS_STATES,
    ),
    checkOneOf('retail_cost_quotes_presentation_check', t.presentation, RETAIL_PRICE_PRESENTATIONS),
    checkOneOf('retail_cost_quotes_subsidy_source_check', t.subsidySource, RETAIL_SUBSIDY_SOURCES),
    checkOneOf(
      'retail_cost_quotes_supersede_reason_check',
      t.supersedeReason,
      RETAIL_QUOTE_SUPERSEDE_REASONS,
    ),
    checkEveryElementOf(
      'retail_cost_quotes_block_reasons_check',
      t.blockReasons,
      RETAIL_COST_BLOCK_REASONS,
    ),
    ...currencyChecks('retail_cost_quotes', [
      t.presentmentCurrency,
      t.customerTotalCurrency,
      t.subsidyCurrency,
      t.buyerPayableCurrency,
    ]),
    check('retail_cost_quotes_policy_version_check', sql`${t.policyVersion} >= 1`),
    check('retail_cost_quotes_supplier_sku_check', sql`length(${t.supplierSku}) > 0`),
    check('retail_cost_quotes_quantity_check', sql`${t.quantity} > 0`),
    // ONE presentment currency per quote: every amount is denominated in it.
    check(
      'retail_cost_quotes_currency_coherence_check',
      sql`${t.customerTotalCurrency} = ${t.presentmentCurrency}
          and ${t.buyerPayableCurrency} = ${t.presentmentCurrency}
          and (${t.subsidyCurrency} is null or ${t.subsidyCurrency} = ${t.presentmentCurrency})`,
    ),
    check(
      'retail_cost_quotes_amounts_check',
      sql`${t.customerTotalAmount} >= 0 and ${t.buyerPayableAmount} >= 0`,
    ),
    // A subsidy is an amount, a currency, a source and a named budget, together.
    check(
      'retail_cost_quotes_subsidy_complete_check',
      sql`num_nonnulls(${t.subsidyAmount}, ${t.subsidyCurrency}, ${t.subsidySource}, ${t.subsidyBudgetRef}) in (0, 4)`,
    ),
    // No promotion may raise the item price to fund itself later, and no
    // subsidy may exceed the cost it reduces — both directions, structurally.
    check(
      'retail_cost_quotes_subsidy_bounds_check',
      sql`${t.subsidyAmount} is null
          or (${t.subsidyAmount} >= 0 and ${t.subsidyAmount} <= ${t.customerTotalAmount})`,
    ),
    // The buyer pays cost minus the subsidy. Nothing else can separate the two.
    check(
      'retail_cost_quotes_buyer_payable_check',
      sql`${t.buyerPayableAmount} = ${t.customerTotalAmount} - coalesce(${t.subsidyAmount}, 0)`,
    ),
    // Completeness DETERMINES presentation, both ways. A blocked quote cannot
    // be stored claiming an exact cost-only price.
    check(
      'retail_cost_quotes_presentation_mapping_check',
      sql`(${t.completeness} = 'complete') = (${t.presentation} = 'exact_cost_only')
          and (${t.completeness} = 'awaiting_destination') = (${t.presentation} = 'starting_item_cost')`,
    ),
    // A complete quote explains nothing; anything else explains itself.
    check(
      'retail_cost_quotes_block_reason_presence_check',
      sql`(${t.completeness} = 'complete') = (cardinality(${t.blockReasons}) = 0)`,
    ),
    // An exact cost-only price needs the destination it was priced for.
    check(
      'retail_cost_quotes_complete_needs_destination_check',
      sql`${t.completeness} <> 'complete' or ${t.destinationCountry} is not null`,
    ),
    check(
      'retail_cost_quotes_destination_shape_check',
      sql`(${t.destinationCountry} is null or ${t.destinationCountry} ~ '^[A-Z]{2}$')
          and (${t.destinationRegion} is null or ${t.destinationCountry} is not null)`,
    ),
    check('retail_cost_quotes_validity_window_check', sql`${t.expiresAt} > ${t.quotedAt}`),
    check('retail_cost_quotes_content_hash_check', sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`),
    // A supersession names its predecessor AND its cause, or neither.
    check(
      'retail_cost_quotes_supersede_check',
      sql`num_nonnulls(${t.supersedesQuoteId}, ${t.supersedeReason}) in (0, 2)
          and (${t.supersedesQuoteId} is null or ${t.supersedesQuoteId} <> ${t.id})`,
    ),
    // The audit read: every quote for one offer, newest first.
    index('retail_cost_quotes_offer_idx')
      .on(t.procurementOfferId, t.createdAt)
      .where(sql`${t.procurementOfferId} is not null`),
    index('retail_cost_quotes_supplier_idx').on(t.supplierId, t.createdAt),
    // "Which chargeable quote covers this variant into this market" — the #129
    // presentation read and the #123 checkout read, one index.
    index('retail_cost_quotes_variant_market_idx')
      .on(t.canonicalVariantId, t.destinationCountry, t.expiresAt)
      .where(sql`${t.completeness} = 'complete'`),
    // "What may a page SAY about this variant" — #129's presentation read,
    // which is deliberately NOT restricted to `complete` (a blocked quote is
    // the answer that names its own block reasons) and so cannot use the
    // partial index above. Added because the read otherwise has no index at
    // all, not as a tuning guess: #61's rule is that an index needs a
    // measurement, and the measurement here is that the alternative is a
    // sequential scan of every quote ever composed on every product view.
    index('retail_cost_quotes_variant_presentation_idx').on(t.canonicalVariantId, t.createdAt),
    // Reproducibility: find every quote that composed to one exact content.
    index('retail_cost_quotes_content_hash_idx').on(t.contentHash),
  ],
);

/**
 * `retail_cost_quote_components` — ONE included direct cost, with its whole
 * provenance (#120 "Allowed direct-cost components": modelled separately rather
 * than hidden inside one inflated unit price).
 *
 * A child table and not eight column pairs, and not `jsonb`: which components a
 * quote HAS is data, the shape of one is entirely known, and a quote may carry
 * several `other_direct_fulfilment` rows. `kind`'s CHECK reads the shared-types
 * tuple, so a component named `markup` fails the WRITE.
 *
 * ## The two `Money` pairs are the currency rule, made structural
 *
 * `source_*` is the amount as the SUPPLIER stated it, in the SUPPLIER's own
 * currency — nothing converts a source price on write. `presentment_*` is that
 * figure converted once. The five `fx_rate_*` columns are the exact
 * `FxRateSnapshot` of that conversion, present EXACTLY when the two currencies
 * differ (a CHECK, both directions), so a converted amount can never exist
 * without the rate that produced it, and an identical pair can never carry a
 * spurious one. `fx_basis` says whose rate it was — Mercaria's quote-time rate
 * or the provider's final one — because those can differ and the difference is
 * variance, never profit.
 */
export const retailCostQuoteComponents = pgTable(
  'retail_cost_quote_components',
  {
    id: generatedId(),
    /** `restrict`: quotes are append-only and undeletable; a component is part of one. */
    quoteId: text()
      .notNull()
      .references(() => retailCostQuotes.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(RETAIL_COST_COMPONENT_KINDS) }).notNull(),
    /** What produced this figure — `supplier_quote`, `carrier_tariff`, `tax_engine`, … */
    sourceRef: text().notNull(),
    /** The amount as the SOURCE stated it, in the source's own currency. */
    ...money('source'),
    /** The same amount in the quote's presentment currency. */
    ...money('presentment'),
    // The exact conversion — five columns, complete or absent, the
    // `purchase_orders.fx_rate_*` shape for the same reproducibility reason.
    fxRateFrom: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateTo: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateRate: doublePrecision(),
    fxRateProvider: text(),
    /** An ISO-8601 instant as TEXT — `FxRateSnapshot.asOf` is declared `string`. */
    fxRateAsOf: text(),
    /** Whose rate it was: Mercaria's quote-time rate, or the provider's final one. */
    fxBasis: text({ enum: asEnumValues(RETAIL_FX_BASES) }),
    confidence: text({ enum: asEnumValues(RETAIL_COST_CONFIDENCES) }).notNull(),
    /** When the source was observed saying this — #120 requires an observation time. */
    observedAt: timestamptz().notNull(),
    /** The supplier's own quote id, when the component came from one. */
    supplierQuoteRef: text(),
    /** The observation record this figure was read from. */
    sourceObservationRef: text(),
    /** Where the evidence lives — an invoice line, a tariff table, a determination. */
    evidenceRef: text(),
    description: text(),
    position: integer().notNull().default(0),
    /** No `updated_at` — the row is append-only with its quote. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_cost_quote_components_kind_check',
      t.kind,
      RETAIL_COST_COMPONENT_KINDS,
    ),
    checkOneOf(
      'retail_cost_quote_components_confidence_check',
      t.confidence,
      RETAIL_COST_CONFIDENCES,
    ),
    checkOneOf('retail_cost_quote_components_fx_basis_check', t.fxBasis, RETAIL_FX_BASES),
    ...currencyChecks('retail_cost_quote_components', [
      t.sourceCurrency,
      t.presentmentCurrency,
      t.fxRateFrom,
      t.fxRateTo,
    ]),
    check('retail_cost_quote_components_source_ref_check', sql`length(btrim(${t.sourceRef})) > 0`),
    // Every included cost is non-negative: a "negative supplier cost" — the
    // shape a supplier-funded promotion would take — is unrepresentable.
    check(
      'retail_cost_quote_components_amounts_check',
      sql`${t.sourceAmount} >= 0 and ${t.presentmentAmount} >= 0`,
    ),
    // A conversion exists exactly when the currencies differ, and it names the
    // pair it converted. Both directions, so neither a missing snapshot nor a
    // spurious one is storable.
    check(
      'retail_cost_quote_components_fx_presence_check',
      sql`num_nonnulls(${t.fxRateFrom}, ${t.fxRateTo}, ${t.fxRateRate}, ${t.fxRateProvider}, ${t.fxRateAsOf}) in (0, 5)
          and (${t.sourceCurrency} = ${t.presentmentCurrency}) = (${t.fxRateRate} is null)`,
    ),
    check(
      'retail_cost_quote_components_fx_pair_check',
      sql`${t.fxRateRate} is null
          or (${t.fxRateFrom} = ${t.sourceCurrency}
              and ${t.fxRateTo} = ${t.presentmentCurrency}
              and ${t.fxRateRate} > 0)`,
    ),
    // A rate always says whose it was; an unconverted amount never claims one.
    check(
      'retail_cost_quote_components_fx_basis_presence_check',
      sql`(${t.fxBasis} is not null) = (${t.fxRateRate} is not null)`,
    ),
    // One position per quote — the deterministic order the content hash reads.
    uniqueIndex('retail_cost_quote_components_quote_position_key').on(t.quoteId, t.position),
    index('retail_cost_quote_components_quote_kind_idx').on(t.quoteId, t.kind),
  ],
);

/**
 * `retail_cost_quote_acceptances` — the CHECKOUT LOCK (#120 "Checkout lock").
 *
 * A buyer accepted ONE exact quote for ONE checkout group.
 * `UNIQUE(checkout_group_id, quote_id)` is what makes an idempotent retry
 * return the same locked total rather than re-pricing; a revised total is a NEW
 * quote and a NEW acceptance naming the one it supersedes, which is the only
 * representable way the charged amount changes — and it requires the buyer to
 * accept again, before charge or capture.
 *
 * ## The one-way `order_id`
 *
 * The lock is taken BEFORE the retail order exists (ADR 0004 D4 step 1 freezes
 * the snapshot, then creates the order). So `order_id` starts NULL and the
 * append-only trigger permits exactly one narrow UPDATE: NULL → a value, with
 * every other column unchanged. That is what "freeze the accepted quote onto
 * the order" needs without making a financial record mutable, and it is pinned
 * by a real-database test rather than by review.
 *
 * ## The actor is an Oxy account or a guest session, never both
 *
 * The `referral_attributions` shape (ADR 0003): an Oxy user id or an opaque
 * guest-session ref, held mutually exclusive by CHECK, with exactly one
 * present. Neither carries a foreign key — Oxy owns identity, and a guest
 * session is purged on its own retention clock while this record is retained.
 */
export const retailCostQuoteAcceptances = pgTable(
  'retail_cost_quote_acceptances',
  {
    id: generatedId(),
    quoteId: text()
      .notNull()
      .references(() => retailCostQuotes.id, { onDelete: 'restrict' }),
    /** The checkout group the lock is scoped to — the grouping token, no foreign key. */
    checkoutGroupId: text().notNull(),
    /** Set ONCE, when the retail order exists. Never re-pointed. */
    orderId: text(),
    /** What the buyer accepted — equal to the quote's `buyer_payable` by construction. */
    ...money('acceptedTotal'),
    /** The quote's hash, restated so a tampered read of either row is detectable. */
    quoteContentHash: text().notNull(),
    acceptedAt: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. */
    acceptedByOxyUserId: text(),
    /** An opaque #103 guest-session ref — no foreign key; the session is purged, this is not. */
    acceptedGuestSessionId: text(),
    /** The acceptance this one replaces, after an explicit buyer re-acceptance. */
    supersedesAcceptanceId: text().references((): AnyPgColumn => retailCostQuoteAcceptances.id, {
      onDelete: 'restrict',
    }),
    /** No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('retail_cost_quote_acceptances', [t.acceptedTotalCurrency]),
    check('retail_cost_quote_acceptances_amount_check', sql`${t.acceptedTotalAmount} >= 0`),
    check(
      'retail_cost_quote_acceptances_checkout_group_check',
      sql`length(btrim(${t.checkoutGroupId})) > 0`,
    ),
    check(
      'retail_cost_quote_acceptances_content_hash_check',
      sql`${t.quoteContentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    // Exactly one actor: an acceptance nobody made is not an acceptance, and an
    // acceptance made by two people is not one either.
    check(
      'retail_cost_quote_acceptances_actor_check',
      sql`num_nonnulls(${t.acceptedByOxyUserId}, ${t.acceptedGuestSessionId}) = 1`,
    ),
    check(
      'retail_cost_quote_acceptances_supersede_check',
      sql`${t.supersedesAcceptanceId} is null or ${t.supersedesAcceptanceId} <> ${t.id}`,
    ),
    // THE idempotency constraint: one acceptance per group per quote, so a
    // retry converges on the locked total instead of minting a second lock.
    uniqueIndex('retail_cost_quote_acceptances_group_quote_key').on(t.checkoutGroupId, t.quoteId),
    index('retail_cost_quote_acceptances_quote_idx').on(t.quoteId),
    index('retail_cost_quote_acceptances_order_idx')
      .on(t.orderId)
      .where(sql`${t.orderId} is not null`),
  ],
);
