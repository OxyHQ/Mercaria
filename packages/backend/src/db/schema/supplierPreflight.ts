/**
 * The live supplier preflight domain (#122, ADR 0004 D4 step 1 / D5 / D9.3):
 * `supplier_sourcing_policies`, `supplier_quotes`,
 * `supplier_quote_shipping_options`, `supplier_reservations`,
 * `supplier_sourcing_attempts`, `supplier_call_leases`,
 * `supplier_preflight_health`, `supplier_preflight_suppressions`.
 *
 * What a supplier says NOW, immediately before Mercaria charges anybody: can
 * this exact item still be procured, at what cost, shipped how, and for how
 * long is that good. #118 records what a catalogue FEED last claimed; this
 * domain records what the supplier ANSWERED to one exact question, and #122
 * acceptance 1 is the whole reason the two are separate tables with separate
 * vocabularies.
 *
 * ## The boundaries this file exists to hold
 *
 * **A reservation is a ROW, and the row cannot exist without the supplier's own
 * commitment.** There is no `reserved` boolean, no `reservation_state` and no
 * reservation column of any kind on `supplier_quotes`. A hold is a
 * `supplier_reservations` row, whose `provider_reservation_id` and
 * `provider_expires_at` are both NOT NULL and whose `declared_capabilities`
 * must CONTAIN `inventory_reservation` — a CHECK. So "the orchestration must
 * not emulate a reservation by naming a local record `reserved` when the
 * supplier has made no commitment" is not a rule a service obeys; there is no
 * row shape in which it could be broken, whether the writer is this domain,
 * #124, a service bug or `psql`.
 *
 * **A quote is not a PurchaseOrder.** Nothing here carries a supplier order id,
 * a submission state or a fulfilment instruction, and `purchase_orders.quote_ref`
 * (#118) already points the other way. The type that would authorize
 * fulfilment lives in `services/supplier-preflight/checkout-contract.ts` and
 * refuses unconditionally.
 *
 * **A quote stores NO address.** `destination_country` and `destination_region`
 * are the coarse pair Mercaria may keep; there is no postal-code, city,
 * recipient, line, phone or email column, so the redaction is the SHAPE — the
 * `purchase_orders` device, taken one step further, because a parcel needs a
 * street and a QUOTE does not. What ties a quote to the destination it was
 * taken for is `request_fingerprint`, an HMAC an auditor recomputes from a
 * destination they already hold. That fingerprint is an exact-match ORACLE, so
 * it is registered in `db/protectedColumns.ts` beside `guest_checkouts.email_hash`
 * and for the same reason.
 *
 * **A raw provider payload is never stored.** `source_record_ref` is a POINTER
 * into the restricted-access source store and is itself protected; every fact
 * this domain keeps is an allow-listed, normalized, closed-set column — the
 * `analytics_events` posture rather than the `payment_provider_events` one,
 * because a preflight answer is composed by an adapter Mercaria wrote.
 *
 * **Unknown is absence, never zero.** Every money on a quote is an
 * `optionalMoney` pair with a completeness CHECK, every window is a nullable
 * ordered pair, and `max_orderable_quantity` is nullable because "the supplier
 * does not report a ceiling" is a different fact from "the ceiling is zero".
 *
 * ## What is deliberately absent
 *
 * - **No `usage_state` column.** `consumed_at`, `released_at`,
 *   `superseded_by_quote_id` and `expires_at` state it completely, so a stored
 *   verdict beside them would be two representations of one fact whose
 *   disagreement lands in a checkout gate. `deriveSupplierQuoteUsage` is the
 *   one derivation — the `retail_cost_quotes` expiry rule.
 * - **No score column on a sourcing attempt.** A stored score is a number
 *   nobody can reproduce; the attempt records the deterministic RANK the policy
 *   version produced and the reason, which is what #122 acceptance 7 asks for.
 * - **No `orders` widening.** `commercial_role` / `seller_type = 'platform'`
 *   land with the code that writes them (#123) — the reasoning `procurement.ts`,
 *   `retailPricing.ts` and `retailEligibility.ts` all record. The quote carries
 *   a plain `order_id` correlation instead.
 * - **No foreign key to `procurement_offers` or the canonical graph.** Offers
 *   refresh in place and canonical entities merge; a quote is evidence of what
 *   was true at one instant and must survive both verbatim — the
 *   `purchase_order_lines` rule.
 *
 * ## Hand-written triggers ride the same migration
 *
 * drizzle-kit does not model triggers, so four enforcement functions are added
 * by hand to this domain's migration (the ledger / fee / retail-pricing
 * precedent): a policy version freezes every economic column once it leaves
 * `draft`; a quote's identity, request and answer columns freeze from birth
 * while its usage timestamps may each move NULL → a value exactly once; a
 * reservation's identity and provider facts freeze from birth with the same
 * one-way exception; and shipping options plus sourcing attempts refuse UPDATE
 * and DELETE outright.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  SUPPLIER_ACCOUNT_ENVIRONMENTS,
  SUPPLIER_ADAPTER_CAPABILITIES,
  SUPPLIER_AVAILABILITY_STATES,
  SUPPLIER_COMPLETE_AVAILABILITY_STATES,
  SUPPLIER_DESTINATION_RESTRICTIONS,
  SUPPLIER_IDENTITY_CONFIRMATIONS,
  SUPPLIER_IMPORT_RESPONSIBILITIES,
  SUPPLIER_PREFLIGHT_BLOCK_REASONS,
  SUPPLIER_PREFLIGHT_EXCEPTION_KINDS,
  SUPPLIER_PREFLIGHT_FAILURE_KINDS,
  SUPPLIER_PREFLIGHT_STATUSES,
  SUPPLIER_PROVIDER_REASON_CODES,
  SUPPLIER_QUOTE_GUARANTEES,
  SUPPLIER_QUOTE_RELEASE_REASONS,
  SUPPLIER_QUOTE_SUPERSEDE_REASONS,
  SUPPLIER_RESERVATION_RELEASE_REASONS,
  SUPPLIER_SHIPPING_BASES,
  SUPPLIER_SOURCING_CRITERIA,
  SUPPLIER_SOURCING_OUTCOMES,
  SUPPLIER_SOURCING_POLICY_STATUSES,
  SUPPLIER_SOURCING_REASONS,
  SUPPLIER_SUPPRESSION_KINDS,
  SUPPLIER_SUPPRESSION_ORIGINS,
  SUPPLIER_SUPPRESSION_SCOPES,
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
import { supplierAccounts, suppliers } from './procurement';

/** Bound on any stored note, reason or redacted error — the `.slice()` at every writer. */
const MAX_NOTE_LENGTH = 2_000;

/** The capability a reservation row must cite to exist at all. */
const RESERVATION_CAPABILITY = 'inventory_reservation';

/** The criterion every sourcing policy version must rank on. */
const REQUIRED_SOURCING_CRITERION = 'total_landed_cost';

/**
 * `supplier_sourcing_policies` — one immutable VERSION of the deterministic
 * policy that decides WHICH supplier sources a retail line (#122 selection 1).
 *
 * The `fee_schedules` / `retail_pricing_policies` mechanism, third instance:
 * versioned by row, one active per key (a partial unique), every economic
 * column frozen once the version leaves `draft` (a trigger). A policy change is
 * a new version, so a selection made last week can be reproduced exactly —
 * which is what #122 acceptance 7 means by "supplier selection and failover are
 * reproducible".
 *
 * ## `ranking_criteria` is an ORDERED subset and cannot hold a commission
 *
 * The column's CHECK is array CONTAINMENT against
 * {@link SUPPLIER_SOURCING_CRITERIA}, which is disjoint from
 * `SUPPLIER_FORBIDDEN_SOURCING_SIGNALS` by a test. So an operator cannot
 * configure "rank by affiliate commission" even by hand-written UPDATE: there
 * is no value in the tuple that means it. A second CHECK requires
 * `total_landed_cost`, because a sourcing policy that ignores what an order
 * costs to fulfil is not a cost-recovery policy at all.
 *
 * ## The health thresholds live here, not in the environment
 *
 * "Automatic suppression when live quote capability is unhealthy beyond policy"
 * (#122 operations 6) needs a policy to be beyond. Putting the window, the
 * sample floor and the failure ceiling on the versioned row means a suppression
 * can state which version's thresholds it was raised under, and changing them
 * is an audited publication rather than a deploy variable nobody can date.
 */
export const supplierSourcingPolicies = pgTable(
  'supplier_sourcing_policies',
  {
    id: generatedId(),
    /** The stable logical id shared by every version (`mercaria-retail-sourcing`). */
    policyKey: text().notNull(),
    /** Monotonic per key, assigned by the operator creating the draft. */
    version: integer().notNull(),
    name: text().notNull(),
    /** The operator-facing statement of what this version approves and why. */
    summary: text().notNull(),
    status: text({ enum: asEnumValues(SUPPLIER_SOURCING_POLICY_STATUSES) })
      .notNull()
      .default('draft'),
    effectiveStart: timestamptz().notNull(),
    /** NULL = open-ended. */
    effectiveEnd: timestamptz(),
    /** The ORDERED criteria this version ranks candidates by. Always includes cost. */
    rankingCriteria: text().array().notNull().default([]),
    /** Adapter capabilities an offer's provider must declare to be selectable at all. */
    requiredCapabilities: text().array().notNull().default([]),
    /** How many suppliers may be tried for one line before the answer is a refusal. */
    maxSourcingAttempts: integer().notNull().default(3),
    /** The share of a checkout group one supplier may take, in basis points. */
    maxSupplierShareBps: integer().notNull().default(10_000),
    /** How long a quote composed under this version may be trusted. */
    quoteTtlSeconds: integer().notNull().default(900),
    /** The per-call deadline. A slower answer is a `timeout`, which is `unknown`. */
    providerTimeoutMs: integer().notNull().default(8_000),
    /** Default provider concurrency, when the account states none. */
    maxProviderConcurrency: integer().notNull().default(4),
    /** Default provider budget per minute, when the account states none. */
    maxProviderCallsPerMinute: integer().notNull().default(120),
    /** How far back the health verdict looks. */
    healthWindowMinutes: integer().notNull().default(15),
    /** Below this many samples the window says nothing and suppresses nothing. */
    healthMinimumSamples: integer().notNull().default(20),
    /** The failure share, in basis points, beyond which the account is suppressed. */
    healthMaxFailureBps: integer().notNull().default(5_000),
    /** How long an automatic health suppression lasts before it lapses. */
    healthSuppressionMinutes: integer().notNull().default(15),
    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text().notNull(),
    /** The operator who activated it — the audit half of "publish a new version". */
    approvedByOxyUserId: text(),
    activatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'supplier_sourcing_policies_status_check',
      t.status,
      SUPPLIER_SOURCING_POLICY_STATUSES,
    ),
    checkEveryElementOf(
      'supplier_sourcing_policies_ranking_criteria_check',
      t.rankingCriteria,
      SUPPLIER_SOURCING_CRITERIA,
    ),
    checkEveryElementOf(
      'supplier_sourcing_policies_required_capabilities_check',
      t.requiredCapabilities,
      SUPPLIER_ADAPTER_CAPABILITIES,
    ),
    check('supplier_sourcing_policies_version_check', sql`${t.version} >= 1`),
    check(
      'supplier_sourcing_policies_key_check',
      sql`${t.policyKey} ~ '^[a-z0-9][a-z0-9-]{1,63}$'`,
    ),
    // A policy that does not rank on what an order costs to fulfil prices
    // nothing — the `retail_pricing_policies` supplier-item device.
    check(
      'supplier_sourcing_policies_cost_criterion_check',
      sql`${sql.raw(`'${REQUIRED_SOURCING_CRITERION}'`)} = any(${t.rankingCriteria})`,
    ),
    // Attempts are BOUNDED (#122 selection 8: "limit attempts and avoid
    // sequentially placing orders at several suppliers").
    check(
      'supplier_sourcing_policies_attempts_check',
      sql`${t.maxSourcingAttempts} between 1 and 5`,
    ),
    check(
      'supplier_sourcing_policies_share_check',
      sql`${t.maxSupplierShareBps} between 1 and 10000`,
    ),
    check(
      'supplier_sourcing_policies_timing_check',
      sql`${t.quoteTtlSeconds} >= 1
          and ${t.providerTimeoutMs} between 100 and 60000
          and ${t.maxProviderConcurrency} >= 1
          and ${t.maxProviderCallsPerMinute} >= 1`,
    ),
    check(
      'supplier_sourcing_policies_health_check',
      sql`${t.healthWindowMinutes} >= 1
          and ${t.healthMinimumSamples} >= 1
          and ${t.healthMaxFailureBps} between 1 and 10000
          and ${t.healthSuppressionMinutes} >= 1`,
    ),
    check(
      'supplier_sourcing_policies_effective_window_check',
      sql`${t.effectiveEnd} is null or ${t.effectiveEnd} > ${t.effectiveStart}`,
    ),
    // Nothing published is anonymous — the `fee_schedules` activation audit.
    check(
      'supplier_sourcing_policies_activation_audit_check',
      sql`${t.status} not in ('active', 'superseded')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    uniqueIndex('supplier_sourcing_policies_key_version_key').on(t.policyKey, t.version),
    // The structural half of "active versions are immutable; publish a new one".
    uniqueIndex('supplier_sourcing_policies_one_active_per_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * `supplier_quotes` — ONE durable, normalized answer from ONE supplier to ONE
 * exact question (#122 "Quote and reservation persistence").
 *
 * ## The completeness CHECKs are the checkout gate, in the database
 *
 * Four constraints together make "unknown availability, a missing required
 * shipping cost or an ambiguous SKU identity cannot pass checkout" a property
 * of the row rather than of the caller:
 *
 *  1. `status = 'complete'` requires an availability in
 *     {@link SUPPLIER_COMPLETE_AVAILABILITY_STATES} (exactly `orderable`), a
 *     `confirmed` identity, a known unit cost, a known shipping cost and a
 *     shipping basis that is not `unknown`.
 *  2. `block_reasons` is non-empty EXACTLY when the status is not `complete` —
 *     both directions, so neither a silent block nor an unexplained one is
 *     storable.
 *  3. `exception_kind` is present EXACTLY when the status is `invalid`, so an
 *     ambiguous provider answer cannot be filed as a mere `partial`.
 *  4. A complete answer cannot carry a destination restriction: a route the
 *     supplier says it will not serve is not a route checkout may use.
 *
 * ## Identity and idempotency
 *
 * `idempotency_key` is UNIQUE, so a repeated preflight converges on ONE row —
 * a retry, a re-submitted checkout, a client that lost the response and two
 * concurrent ECS tasks all land on the same quote. `request_fingerprint` is the
 * keyed digest of the normalized request; the SERVICE defaults the idempotency
 * key to it, so two callers asking the same question with no key of their own
 * converge as well. Neither carries a session, an actor or a buyer id, which is
 * what makes a rotated guest session unable to duplicate a supplier request
 * (#122 concurrency 5).
 *
 * ## Consumption is one-way and scoped to ONE checkout
 *
 * `consumed_at` and `consumed_by_checkout_group_id` are written together, by a
 * compare-and-swap on `consumed_at IS NULL`, and a trigger refuses value →
 * value. A quote taken by one checkout therefore cannot be attached to another
 * (#122 concurrency 3) — refused by the database rather than by a branch that a
 * concurrent request could interleave around. A CHECK additionally forbids a
 * consumption naming a group other than the one the request declared.
 */
export const supplierQuotes = pgTable(
  'supplier_quotes',
  {
    id: generatedId(),
    /** The caller's key, defaulted to the request fingerprint. PROTECTED. */
    idempotencyKey: text().notNull(),
    /** HMAC-SHA-256 over the normalized request, including the destination. PROTECTED. */
    requestFingerprint: text().notNull(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** Snapshotted from the account: a `test` quote can never fund a live order. */
    environment: text({ enum: asEnumValues(SUPPLIER_ACCOUNT_ENVIRONMENTS) }).notNull(),
    /** The adapter slug that answered — a machine identifier, never a display name. */
    provider: text().notNull(),
    /**
     * What the adapter DECLARED it could do at the moment it answered. A
     * snapshot, so a capability added or withdrawn later cannot rewrite what a
     * historical answer was entitled to claim.
     */
    declaredCapabilities: text().array().notNull().default([]),
    /** SNAPSHOT provenance — deliberately no foreign key; offers refresh in place. */
    procurementOfferId: text(),
    /** SNAPSHOT provenance — deliberately no foreign key; canonical entities merge. */
    canonicalProductId: text(),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    canonicalVariantId: text(),
    /** The supplier's SKU as quoted — frozen. */
    supplierSku: text().notNull(),
    quantity: integer().notNull(),
    /** The checkout group the question belonged to — correlation, no foreign key. */
    checkoutGroupId: text(),
    /** The customer order, once one exists (#123) — correlation, no foreign key. */
    orderId: text(),
    /** The currency the answer is denominated in. Every amount below is in it. */
    requestedCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** ISO-3166-1 alpha-2. The coarse half of what a quote may keep. */
    destinationCountry: text().notNull(),
    /** A coarse administrative region. There is deliberately no finer column. */
    destinationRegion: text(),

    // --- The normalized answer (#122 "Preflight response", items 1–16) -------

    identityConfirmation: text({ enum: asEnumValues(SUPPLIER_IDENTITY_CONFIRMATIONS) }).notNull(),
    availability: text({ enum: asEnumValues(SUPPLIER_AVAILABILITY_STATES) }).notNull(),
    /** NULL = the supplier reports no ceiling — a different fact from zero. */
    maxOrderableQuantity: integer(),
    minimumOrderQuantity: integer(),
    packSize: integer(),
    /** The wholesale unit cost the supplier quoted. Absent = unknown, never zero. */
    ...optionalMoney('unitCost'),
    ...optionalMoney('supplierFees'),
    /** The cost of the SELECTED service. Absent = unknown, and unknown blocks. */
    ...optionalMoney('shippingCost'),
    shippingBasis: text({ enum: asEnumValues(SUPPLIER_SHIPPING_BASES) }).notNull(),
    selectedShippingServiceCode: text(),
    handlingDaysMin: integer(),
    handlingDaysMax: integer(),
    dispatchDaysMin: integer(),
    dispatchDaysMax: integer(),
    deliveryDaysMin: integer(),
    deliveryDaysMax: integer(),
    ...optionalMoney('tax'),
    ...optionalMoney('duty'),
    importResponsibility: text({ enum: asEnumValues(SUPPLIER_IMPORT_RESPONSIBILITIES) }),
    fulfilmentOriginCountry: text(),
    /** Closed reason codes only — never the provider's own free text. */
    destinationRestrictions: text().array().notNull().default([]),
    providerQuoteReference: text(),
    priceGuarantee: text({ enum: asEnumValues(SUPPLIER_QUOTE_GUARANTEES) }).notNull(),
    stockGuarantee: text({ enum: asEnumValues(SUPPLIER_QUOTE_GUARANTEES) }).notNull(),
    providerReasonCodes: text().array().notNull().default([]),
    /** A POINTER into the restricted-access source store. Never a payload. PROTECTED. */
    sourceRecordRef: text(),

    status: text({ enum: asEnumValues(SUPPLIER_PREFLIGHT_STATUSES) }).notNull(),
    /** Sorted, deduped, and non-empty exactly when the status is not `complete`. */
    blockReasons: text().array().notNull().default([]),
    /** Present exactly when the status is `invalid` — an operator has to look. */
    exceptionKind: text({ enum: asEnumValues(SUPPLIER_PREFLIGHT_EXCEPTION_KINDS) }),

    // --- The versions this answer was taken under (#122 quote field 8) ------

    /** The sourcing policy VERSION that selected this supplier. */
    sourcingPolicyId: text().references(() => supplierSourcingPolicies.id, {
      onDelete: 'restrict',
    }),
    sourcingPolicyKey: text(),
    sourcingPolicyVersion: integer(),
    /** The #120 pricing policy the CALLER stated. A snapshot name, not a constraint. */
    pricingPolicyKey: text(),
    pricingPolicyVersion: integer(),
    /** The #121 eligibility policy the CALLER stated. */
    eligibilityPolicyKey: text(),
    eligibilityPolicyVersion: integer(),

    // --- Validity and usage (#122 quote field 7) ----------------------------

    requestedAt: timestamptz().notNull(),
    quotedAt: timestamptz().notNull(),
    /** The validity deadline. NOT a retention one — these rows are evidence. */
    expiresAt: timestamptz().notNull(),
    consumedAt: timestamptz(),
    consumedByCheckoutGroupId: text(),
    releasedAt: timestamptz(),
    releaseReason: text({ enum: asEnumValues(SUPPLIER_QUOTE_RELEASE_REASONS) }),
    supersededByQuoteId: text().references((): AnyPgColumn => supplierQuotes.id, {
      onDelete: 'restrict',
    }),
    supersedeReason: text({ enum: asEnumValues(SUPPLIER_QUOTE_SUPERSEDE_REASONS) }),

    // --- Failure and retry state (#122 quote field 10) ----------------------

    attempts: integer().notNull().default(1),
    lastFailureKind: text({ enum: asEnumValues(SUPPLIER_PREFLIGHT_FAILURE_KINDS) }),
    lastFailureAt: timestamptz(),
    /** Redacted and bounded at the call site — never a provider message verbatim. */
    lastFailureMessage: text(),
    /** How long the provider took. NULL = the call never completed. */
    latencyMs: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('supplier_quotes_environment_check', t.environment, SUPPLIER_ACCOUNT_ENVIRONMENTS),
    checkOneOf(
      'supplier_quotes_identity_check',
      t.identityConfirmation,
      SUPPLIER_IDENTITY_CONFIRMATIONS,
    ),
    checkOneOf('supplier_quotes_availability_check', t.availability, SUPPLIER_AVAILABILITY_STATES),
    checkOneOf('supplier_quotes_shipping_basis_check', t.shippingBasis, SUPPLIER_SHIPPING_BASES),
    checkOneOf(
      'supplier_quotes_import_responsibility_check',
      t.importResponsibility,
      SUPPLIER_IMPORT_RESPONSIBILITIES,
    ),
    checkOneOf('supplier_quotes_price_guarantee_check', t.priceGuarantee, SUPPLIER_QUOTE_GUARANTEES),
    checkOneOf('supplier_quotes_stock_guarantee_check', t.stockGuarantee, SUPPLIER_QUOTE_GUARANTEES),
    checkOneOf('supplier_quotes_status_check', t.status, SUPPLIER_PREFLIGHT_STATUSES),
    checkOneOf(
      'supplier_quotes_exception_kind_check',
      t.exceptionKind,
      SUPPLIER_PREFLIGHT_EXCEPTION_KINDS,
    ),
    checkOneOf(
      'supplier_quotes_release_reason_check',
      t.releaseReason,
      SUPPLIER_QUOTE_RELEASE_REASONS,
    ),
    checkOneOf(
      'supplier_quotes_supersede_reason_check',
      t.supersedeReason,
      SUPPLIER_QUOTE_SUPERSEDE_REASONS,
    ),
    checkOneOf(
      'supplier_quotes_last_failure_kind_check',
      t.lastFailureKind,
      SUPPLIER_PREFLIGHT_FAILURE_KINDS,
    ),
    checkEveryElementOf(
      'supplier_quotes_declared_capabilities_check',
      t.declaredCapabilities,
      SUPPLIER_ADAPTER_CAPABILITIES,
    ),
    checkEveryElementOf(
      'supplier_quotes_destination_restrictions_check',
      t.destinationRestrictions,
      SUPPLIER_DESTINATION_RESTRICTIONS,
    ),
    checkEveryElementOf(
      'supplier_quotes_provider_reason_codes_check',
      t.providerReasonCodes,
      SUPPLIER_PROVIDER_REASON_CODES,
    ),
    checkEveryElementOf(
      'supplier_quotes_block_reasons_check',
      t.blockReasons,
      SUPPLIER_PREFLIGHT_BLOCK_REASONS,
    ),
    ...currencyChecks('supplier_quotes', [
      t.requestedCurrency,
      t.unitCostCurrency,
      t.supplierFeesCurrency,
      t.shippingCostCurrency,
      t.taxCurrency,
      t.dutyCurrency,
    ]),
    check('supplier_quotes_idempotency_key_check', sql`length(btrim(${t.idempotencyKey})) > 0`),
    check('supplier_quotes_fingerprint_check', sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$'`),
    check('supplier_quotes_provider_check', sql`${t.provider} ~ '^[a-z0-9][a-z0-9_-]*$'`),
    check('supplier_quotes_supplier_sku_check', sql`length(${t.supplierSku}) > 0`),
    check('supplier_quotes_quantity_check', sql`${t.quantity} > 0`),
    check(
      'supplier_quotes_destination_shape_check',
      sql`${t.destinationCountry} ~ '^[A-Z]{2}$'
          and (${t.fulfilmentOriginCountry} is null or ${t.fulfilmentOriginCountry} ~ '^[A-Z]{2}$')`,
    ),
    // Each money is a complete pair or absent, and non-negative when present.
    check(
      'supplier_quotes_money_completeness_check',
      sql`num_nonnulls(${t.unitCostAmount}, ${t.unitCostCurrency}) in (0, 2)
          and num_nonnulls(${t.supplierFeesAmount}, ${t.supplierFeesCurrency}) in (0, 2)
          and num_nonnulls(${t.shippingCostAmount}, ${t.shippingCostCurrency}) in (0, 2)
          and num_nonnulls(${t.taxAmount}, ${t.taxCurrency}) in (0, 2)
          and num_nonnulls(${t.dutyAmount}, ${t.dutyCurrency}) in (0, 2)`,
    ),
    check(
      'supplier_quotes_money_amounts_check',
      sql`coalesce(${t.unitCostAmount}, 0) >= 0
          and coalesce(${t.supplierFeesAmount}, 0) >= 0
          and coalesce(${t.shippingCostAmount}, 0) >= 0
          and coalesce(${t.taxAmount}, 0) >= 0
          and coalesce(${t.dutyAmount}, 0) >= 0`,
    ),
    // ONE currency per answer: an amount denominated in something the buyer did
    // not ask for is not an answer to this question.
    check(
      'supplier_quotes_currency_coherence_check',
      sql`coalesce(${t.unitCostCurrency}, ${t.requestedCurrency}) = ${t.requestedCurrency}
          and coalesce(${t.supplierFeesCurrency}, ${t.requestedCurrency}) = ${t.requestedCurrency}
          and coalesce(${t.shippingCostCurrency}, ${t.requestedCurrency}) = ${t.requestedCurrency}
          and coalesce(${t.taxCurrency}, ${t.requestedCurrency}) = ${t.requestedCurrency}
          and coalesce(${t.dutyCurrency}, ${t.requestedCurrency}) = ${t.requestedCurrency}`,
    ),
    // Each window is a complete, ordered pair or absent — the
    // `procurement_offers` shape, three times.
    check(
      'supplier_quotes_windows_check',
      sql`num_nonnulls(${t.handlingDaysMin}, ${t.handlingDaysMax}) in (0, 2)
          and (${t.handlingDaysMin} is null
               or (${t.handlingDaysMin} >= 0 and ${t.handlingDaysMax} >= ${t.handlingDaysMin}))
          and num_nonnulls(${t.dispatchDaysMin}, ${t.dispatchDaysMax}) in (0, 2)
          and (${t.dispatchDaysMin} is null
               or (${t.dispatchDaysMin} >= 0 and ${t.dispatchDaysMax} >= ${t.dispatchDaysMin}))
          and num_nonnulls(${t.deliveryDaysMin}, ${t.deliveryDaysMax}) in (0, 2)
          and (${t.deliveryDaysMin} is null
               or (${t.deliveryDaysMin} >= 0 and ${t.deliveryDaysMax} >= ${t.deliveryDaysMin}))`,
    ),
    check(
      'supplier_quotes_quantity_bounds_check',
      sql`(${t.maxOrderableQuantity} is null or ${t.maxOrderableQuantity} >= 0)
          and (${t.minimumOrderQuantity} is null or ${t.minimumOrderQuantity} >= 1)
          and (${t.packSize} is null or ${t.packSize} >= 1)`,
    ),
    // THE checkout gate, in the database. A `complete` answer has an orderable
    // availability, a confirmed identity, a known unit cost, a known shipping
    // cost on a known basis, and no destination restriction.
    check(
      'supplier_quotes_complete_requirements_check',
      sql`${t.status} <> 'complete'
          or (${t.availability} in (${sql.raw(inList(SUPPLIER_COMPLETE_AVAILABILITY_STATES))})
              and ${t.identityConfirmation} = 'confirmed'
              and ${t.unitCostAmount} is not null
              and ${t.shippingCostAmount} is not null
              and ${t.shippingBasis} <> 'unknown'
              and ${t.selectedShippingServiceCode} is not null
              and cardinality(${t.destinationRestrictions}) = 0)`,
    ),
    // A complete answer explains nothing; anything else explains itself.
    check(
      'supplier_quotes_block_reason_presence_check',
      sql`(${t.status} = 'complete') = (cardinality(${t.blockReasons}) = 0)`,
    ),
    // An ambiguous provider answer is an EXCEPTION, and only an exception
    // carries one — so a service bug cannot file one silently as a `partial`.
    check(
      'supplier_quotes_exception_presence_check',
      sql`(${t.status} = 'invalid') = (${t.exceptionKind} is not null)`,
    ),
    // A sourcing policy is named by id AND by snapshot, or by neither.
    check(
      'supplier_quotes_sourcing_policy_check',
      sql`num_nonnulls(${t.sourcingPolicyId}, ${t.sourcingPolicyKey}, ${t.sourcingPolicyVersion}) in (0, 3)
          and (${t.sourcingPolicyVersion} is null or ${t.sourcingPolicyVersion} >= 1)`,
    ),
    check(
      'supplier_quotes_pricing_policy_check',
      sql`num_nonnulls(${t.pricingPolicyKey}, ${t.pricingPolicyVersion}) in (0, 2)
          and num_nonnulls(${t.eligibilityPolicyKey}, ${t.eligibilityPolicyVersion}) in (0, 2)`,
    ),
    check(
      'supplier_quotes_validity_window_check',
      sql`${t.expiresAt} > ${t.quotedAt} and ${t.quotedAt} >= ${t.requestedAt}`,
    ),
    // A consumption is a time AND the checkout that took it, together — and it
    // can only ever be the group the request itself declared.
    check(
      'supplier_quotes_consumption_check',
      sql`num_nonnulls(${t.consumedAt}, ${t.consumedByCheckoutGroupId}) in (0, 2)
          and (${t.consumedByCheckoutGroupId} is null
               or ${t.checkoutGroupId} is null
               or ${t.consumedByCheckoutGroupId} = ${t.checkoutGroupId})`,
    ),
    check(
      'supplier_quotes_release_check',
      sql`num_nonnulls(${t.releasedAt}, ${t.releaseReason}) in (0, 2)`,
    ),
    // Consumed and released are mutually exclusive terminal facts: a quote that
    // funded an order was not handed back, and one handed back funded nothing.
    check(
      'supplier_quotes_usage_exclusivity_check',
      sql`num_nonnulls(${t.consumedAt}, ${t.releasedAt}) <= 1`,
    ),
    check(
      'supplier_quotes_supersede_check',
      sql`num_nonnulls(${t.supersededByQuoteId}, ${t.supersedeReason}) in (0, 2)
          and (${t.supersededByQuoteId} is null or ${t.supersededByQuoteId} <> ${t.id})`,
    ),
    check(
      'supplier_quotes_failure_check',
      sql`${t.attempts} >= 1
          and (${t.latencyMs} is null or ${t.latencyMs} >= 0)
          and num_nonnulls(${t.lastFailureKind}, ${t.lastFailureAt}) in (0, 2)
          and (${t.lastFailureMessage} is null
               or length(${t.lastFailureMessage}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})`,
    ),
    // THE idempotency constraint: a repeat converges on this row rather than
    // asking the supplier a second time.
    uniqueIndex('supplier_quotes_idempotency_key_key').on(t.idempotencyKey),
    // "Which usable quote covers this offer into this market" — the #123
    // checkout read and the re-preflight read, one index.
    index('supplier_quotes_offer_market_idx')
      .on(t.procurementOfferId, t.destinationCountry, t.expiresAt)
      .where(sql`${t.status} = 'complete' and ${t.consumedAt} is null`),
    index('supplier_quotes_checkout_group_idx')
      .on(t.checkoutGroupId, t.createdAt)
      .where(sql`${t.checkoutGroupId} is not null`),
    index('supplier_quotes_order_idx')
      .on(t.orderId)
      .where(sql`${t.orderId} is not null`),
    index('supplier_quotes_account_idx').on(t.supplierAccountId, t.createdAt),
    // The operator exception queue: answers a person still has to look at.
    index('supplier_quotes_exception_idx')
      .on(t.createdAt)
      .where(sql`${t.exceptionKind} is not null`),
    // The release sweep: open quotes past their deadline, soonest first.
    index('supplier_quotes_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.consumedAt} is null and ${t.releasedAt} is null`),
  ],
);

/**
 * `supplier_quote_shipping_options` — the services the supplier actually
 * offered for this destination (#122 response item 6).
 *
 * A child table and not an array or a `jsonb` blob: which services a quote has
 * is data, the shape of one is entirely known, and every amount in this schema
 * is a real money pair. Append-only from birth (a trigger refuses UPDATE and
 * DELETE), because the option set is part of the frozen answer — re-quoting
 * produces a NEW quote, never an edited one.
 *
 * `cost` is NOT NULL, deliberately: an option whose price the supplier did not
 * state is not an option, and recording it with a zero would be
 * `assumed_zero_shipping` wearing a row. Such a service simply does not appear,
 * and if none appears the quote's shipping basis is `unknown`, which blocks.
 */
export const supplierQuoteShippingOptions = pgTable(
  'supplier_quote_shipping_options',
  {
    id: generatedId(),
    /** `restrict`: quotes are evidence and undeletable; an option is part of one. */
    quoteId: text()
      .notNull()
      .references(() => supplierQuotes.id, { onDelete: 'restrict' }),
    /** The provider's own service code — their key space, never a Mercaria key. */
    serviceCode: text().notNull(),
    carrier: text(),
    serviceName: text(),
    ...money('cost'),
    basis: text({ enum: asEnumValues(SUPPLIER_SHIPPING_BASES) }).notNull(),
    deliveryDaysMin: integer(),
    deliveryDaysMax: integer(),
    /** Whether the supplier HELD this price, or merely observed it. */
    guaranteed: boolean().notNull().default(false),
    position: integer().notNull().default(0),
    /** No `updated_at` — the row is append-only with its quote. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'supplier_quote_shipping_options_basis_check',
      t.basis,
      SUPPLIER_SHIPPING_BASES,
    ),
    ...currencyChecks('supplier_quote_shipping_options', [t.costCurrency]),
    check(
      'supplier_quote_shipping_options_service_code_check',
      sql`length(btrim(${t.serviceCode})) > 0`,
    ),
    check('supplier_quote_shipping_options_cost_check', sql`${t.costAmount} >= 0`),
    // An option whose basis is `unknown` is not an option — that value belongs
    // to the QUOTE, saying no service could be priced at all.
    check('supplier_quote_shipping_options_known_basis_check', sql`${t.basis} <> 'unknown'`),
    check(
      'supplier_quote_shipping_options_window_check',
      sql`num_nonnulls(${t.deliveryDaysMin}, ${t.deliveryDaysMax}) in (0, 2)
          and (${t.deliveryDaysMin} is null
               or (${t.deliveryDaysMin} >= 0 and ${t.deliveryDaysMax} >= ${t.deliveryDaysMin}))`,
    ),
    // One row per service per quote: a redelivered answer converges.
    uniqueIndex('supplier_quote_shipping_options_quote_service_key').on(t.quoteId, t.serviceCode),
    index('supplier_quote_shipping_options_quote_idx').on(t.quoteId, t.position),
  ],
);

/**
 * `supplier_reservations` — a hold the SUPPLIER actually made (#122 acceptance
 * 3).
 *
 * ## The absence of a row is the absence of a commitment
 *
 * This is the load-bearing table of the domain, and what makes it load-bearing
 * is what it REQUIRES rather than what it holds. `provider_reservation_id` and
 * `provider_expires_at` are both NOT NULL, and `declared_capabilities` must
 * contain `inventory_reservation` — so a row can only exist where a supplier
 * that declared the capability answered with its own id and its own deadline.
 * There is no `reserved` flag on the quote to set instead, and no default this
 * table could take. A supplier without reservation support has no row, and
 * every reader sees exactly that.
 *
 * ## Single use is a compare-and-swap, not a check
 *
 * `UNIQUE(quote_id)` gives one reservation per quote;
 * `UNIQUE(supplier_account_id, provider_reservation_id)` stops two Mercaria
 * rows claiming one supplier hold. Consumption is an UPDATE whose predicate is
 * `consumed_at IS NULL`, so two concurrent checkouts cannot both consume it —
 * the loser sees zero rows updated and is told, rather than both proceeding
 * (#122 concurrency 2). Release is the same shape on `released_at`, which is
 * what makes releasing twice converge instead of failing (#122 concurrency 9).
 */
export const supplierReservations = pgTable(
  'supplier_reservations',
  {
    id: generatedId(),
    quoteId: text()
      .notNull()
      .references(() => supplierQuotes.id, { onDelete: 'restrict' }),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    procurementOfferId: text(),
    /**
     * The SUPPLIER's own reservation id. NOT NULL, and that is the point: this
     * value can only come from a supplier that made a commitment.
     */
    providerReservationId: text().notNull(),
    /**
     * What the adapter declared when it made this hold. CHECKed to contain
     * `inventory_reservation`, so a reservation by an adapter that never
     * claimed the capability has no row shape at all.
     */
    declaredCapabilities: text().array().notNull(),
    supplierSku: text().notNull(),
    quantity: integer().notNull(),
    reservedAt: timestamptz().notNull(),
    /** The SUPPLIER's own deadline. NOT NULL — a hold with no end is not a hold. */
    providerExpiresAt: timestamptz().notNull(),
    /** Whether consuming it spends it. Suppliers differ; the default is the safe one. */
    singleUse: boolean().notNull().default(true),
    consumedAt: timestamptz(),
    consumedByCheckoutGroupId: text(),
    consumedOrderId: text(),
    releasedAt: timestamptz(),
    releaseReason: text({ enum: asEnumValues(SUPPLIER_RESERVATION_RELEASE_REASONS) }),
    /** Bounded retries on the release call — a lapse is not a leak, but it is noise. */
    releaseAttempts: integer().notNull().default(0),
    lastReleaseError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'supplier_reservations_release_reason_check',
      t.releaseReason,
      SUPPLIER_RESERVATION_RELEASE_REASONS,
    ),
    checkEveryElementOf(
      'supplier_reservations_declared_capabilities_check',
      t.declaredCapabilities,
      SUPPLIER_ADAPTER_CAPABILITIES,
    ),
    // THE honesty constraint. A reservation row that did not declare the
    // capability is unrepresentable, whoever the writer is.
    check(
      'supplier_reservations_capability_declared_check',
      sql`${sql.raw(`'${RESERVATION_CAPABILITY}'`)} = any(${t.declaredCapabilities})`,
    ),
    check(
      'supplier_reservations_provider_id_check',
      sql`length(btrim(${t.providerReservationId})) > 0`,
    ),
    check('supplier_reservations_supplier_sku_check', sql`length(${t.supplierSku}) > 0`),
    check('supplier_reservations_quantity_check', sql`${t.quantity} > 0`),
    check(
      'supplier_reservations_window_check',
      sql`${t.providerExpiresAt} > ${t.reservedAt}`,
    ),
    // A consumption names the checkout that spent it; a release names its cause.
    check(
      'supplier_reservations_consumption_check',
      sql`num_nonnulls(${t.consumedAt}, ${t.consumedByCheckoutGroupId}) in (0, 2)`,
    ),
    check(
      'supplier_reservations_release_shape_check',
      sql`num_nonnulls(${t.releasedAt}, ${t.releaseReason}) in (0, 2)
          and ${t.releaseAttempts} >= 0
          and (${t.lastReleaseError} is null
               or length(${t.lastReleaseError}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})`,
    ),
    // Consumed and released are mutually exclusive: a hold that funded an order
    // was not handed back, and one handed back funded nothing.
    check(
      'supplier_reservations_usage_exclusivity_check',
      sql`num_nonnulls(${t.consumedAt}, ${t.releasedAt}) <= 1`,
    ),
    uniqueIndex('supplier_reservations_quote_key').on(t.quoteId),
    // One Mercaria row per supplier hold. Scoped to the account because
    // platforms mint ids per account, the `purchase_orders` reasoning.
    uniqueIndex('supplier_reservations_provider_key').on(
      t.supplierAccountId,
      t.providerReservationId,
    ),
    // The release sweep: live holds past their supplier deadline, soonest first.
    index('supplier_reservations_expiry_idx')
      .on(t.providerExpiresAt)
      .where(sql`${t.consumedAt} is null and ${t.releasedAt} is null`),
    index('supplier_reservations_account_idx').on(t.supplierAccountId, t.reservedAt),
  ],
);

/**
 * `supplier_sourcing_attempts` — every source that was tried, and why it ended
 * the way it did (#122 selection 7).
 *
 * Append-only (a trigger refuses UPDATE and DELETE; no `updated_at` — the
 * absence is the contract, the `order_status_history` shape). The record exists
 * so a selection can be RE-READ rather than re-derived: a candidate that was
 * skipped for a concentration limit and one that was skipped because its
 * provider timed out look identical from the outcome alone, and only one of
 * them is a supplier problem.
 *
 * `UNIQUE(request_fingerprint, sequence)` makes a replayed sourcing run
 * converge on the rows it already wrote rather than doubling the trail — the
 * `moderation_events` claim shape, applied to an audit.
 */
export const supplierSourcingAttempts = pgTable(
  'supplier_sourcing_attempts',
  {
    id: generatedId(),
    /** The keyed digest of the request being sourced. PROTECTED. */
    requestFingerprint: text().notNull(),
    /** 0-based position in the attempt order this run actually took. */
    sequence: integer().notNull(),
    /** The checkout group, when the run had one — correlation, no foreign key. */
    checkoutGroupId: text(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    procurementOfferId: text(),
    /** The policy VERSION that produced this order, by id and by snapshot name. */
    sourcingPolicyId: text().references(() => supplierSourcingPolicies.id, {
      onDelete: 'restrict',
    }),
    sourcingPolicyKey: text(),
    sourcingPolicyVersion: integer(),
    /**
     * The deterministic RANK the policy gave this candidate. There is
     * deliberately no `score`: a stored score is a number nobody can reproduce,
     * while a rank plus the policy version plus the candidate facts can be.
     */
    rank: integer(),
    outcome: text({ enum: asEnumValues(SUPPLIER_SOURCING_OUTCOMES) }).notNull(),
    reason: text({ enum: asEnumValues(SUPPLIER_SOURCING_REASONS) }).notNull(),
    /** The quote this attempt produced, when it produced one. */
    quoteId: text().references(() => supplierQuotes.id, { onDelete: 'restrict' }),
    at: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('supplier_sourcing_attempts_outcome_check', t.outcome, SUPPLIER_SOURCING_OUTCOMES),
    checkOneOf('supplier_sourcing_attempts_reason_check', t.reason, SUPPLIER_SOURCING_REASONS),
    check(
      'supplier_sourcing_attempts_fingerprint_check',
      sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'supplier_sourcing_attempts_sequence_check',
      sql`${t.sequence} >= 0 and (${t.rank} is null or ${t.rank} >= 0)`,
    ),
    check(
      'supplier_sourcing_attempts_policy_check',
      sql`num_nonnulls(${t.sourcingPolicyId}, ${t.sourcingPolicyKey}, ${t.sourcingPolicyVersion}) in (0, 3)`,
    ),
    // A SELECTED attempt produced the quote it selected. Anything else did not
    // select anything, so it has no quote to name.
    check(
      'supplier_sourcing_attempts_selected_quote_check',
      sql`(${t.outcome} = 'selected') = (${t.quoteId} is not null)`,
    ),
    uniqueIndex('supplier_sourcing_attempts_request_sequence_key').on(
      t.requestFingerprint,
      t.sequence,
    ),
    index('supplier_sourcing_attempts_checkout_group_idx')
      .on(t.checkoutGroupId, t.at)
      .where(sql`${t.checkoutGroupId} is not null`),
    index('supplier_sourcing_attempts_account_idx').on(t.supplierAccountId, t.at),
  ],
);

/**
 * `supplier_call_leases` — the SHARED, cross-task bound on how hard Mercaria
 * may hit one supplier (#122 concurrency 6).
 *
 * ## Why Postgres and not a per-process token bucket
 *
 * "How many calls per minute may this supplier account receive, across every
 * ECS task" is not a question an in-process limiter can answer — it answers a
 * different one per task and their sum is whatever the task count happens to
 * be. That is the `merchant_claim_rate_limits` reasoning (#83), applied to an
 * outbound provider instead of an inbound caller.
 *
 * ## One row per (account, slot), and the budget rides the slot
 *
 * There are `maxConcurrency` slot rows per account. A caller claims a free one
 * with `FOR UPDATE SKIP LOCKED`, which makes CONCURRENCY exact — a slot is a
 * row lock, so it cannot be taken twice. The per-minute budget is carried on
 * the SAME row as this slot's equal share of the account's allowance, which
 * makes the RATE bound exact too, because a single row's counter is serialized
 * by its own lock.
 *
 * The trade is stated rather than hidden: an uneven arrival pattern can leave
 * one slot's share unused while another is exhausted, so the limiter can
 * under-admit. That errs toward not exceeding the provider's published limit,
 * which is the direction a supplier's rate limiter punishes. The alternative —
 * one shared counter plus separate lease rows — is exact in both dimensions and
 * needs two tables to be exact in either; this shape needs one.
 *
 * A lease is reclaimable: `lease_until` in the past means the holder died, and
 * the next claimant takes it. The owner check on release is what stops a task
 * that lost its lease from freeing somebody else's — the `payment_outboxes`
 * lease contract, verbatim.
 */
export const supplierCallLeases = pgTable(
  'supplier_call_leases',
  {
    id: generatedId(),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'cascade' }),
    /** 0-based concurrency slot. The row count IS the concurrency bound. */
    slot: integer().notNull(),
    /** The claiming process. NULL = free. */
    leaseOwner: text(),
    /** When the claim lapses and another task may reclaim it. */
    leaseUntil: timestamptz(),
    /** The start of the minute this slot's counter is counting. */
    windowStart: timestamptz().notNull(),
    /** Calls this slot has started inside `window_start`. */
    callsInWindow: integer().notNull().default(0),
    /** This slot's share of the account's per-minute allowance, snapshotted. */
    windowAllowance: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('supplier_call_leases_slot_check', sql`${t.slot} >= 0`),
    // A lease is an owner AND a deadline, together. Half of one is a slot no
    // task can prove it holds and no sweep can safely reclaim.
    check(
      'supplier_call_leases_lease_shape_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
    check(
      'supplier_call_leases_window_check',
      sql`${t.callsInWindow} >= 0 and ${t.windowAllowance} >= 1
          and ${t.callsInWindow} <= ${t.windowAllowance}`,
    ),
    uniqueIndex('supplier_call_leases_account_slot_key').on(t.supplierAccountId, t.slot),
    // The claim: this account's free slots.
    index('supplier_call_leases_account_free_idx').on(t.supplierAccountId, t.leaseUntil),
  ],
);

/**
 * `supplier_preflight_health` — how one supplier account has actually been
 * answering (#122 operations 1–2).
 *
 * One row per account, holding a ROLLING window rather than an event log: the
 * question this table exists to answer is "is this provider healthy enough to
 * quote against right now", and an events table would make that a scan on the
 * checkout path. The individual outcomes are on `supplier_quotes` already.
 *
 * ## The counters must SUM, and that is a CHECK
 *
 * `attempts = successes + failures` — equality, never `<=`. A window whose
 * counters do not reconcile is one where something was dropped, and a health
 * verdict computed from a lossy window is exactly the report that says it went
 * fine (the `catalog_backfill_runs` vacuity floor, #60, applied to a provider).
 * `timeouts` and `rate_limited` are subsets of `failures`, so they are bounded
 * by it rather than added to the total twice.
 */
export const supplierPreflightHealth = pgTable(
  'supplier_preflight_health',
  {
    id: generatedId(),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'cascade' }),
    /** The start of the rolling window these counters describe. */
    windowStart: timestamptz().notNull(),
    attempts: bigint({ mode: 'number' }).notNull().default(0),
    successes: bigint({ mode: 'number' }).notNull().default(0),
    failures: bigint({ mode: 'number' }).notNull().default(0),
    /** A subset of `failures` — the one that means `unknown`, not `unavailable`. */
    timeouts: bigint({ mode: 'number' }).notNull().default(0),
    /** A subset of `failures` — Mercaria's own budget, not the supplier's fault. */
    rateLimited: bigint({ mode: 'number' }).notNull().default(0),
    /** Summed latency and its sample count — a mean without storing a mean. */
    latencyMsTotal: bigint({ mode: 'number' }).notNull().default(0),
    latencySamples: bigint({ mode: 'number' }).notNull().default(0),
    /** How many failures in a row. Reset by any success. */
    consecutiveFailures: integer().notNull().default(0),
    lastSuccessAt: timestamptz(),
    lastFailureAt: timestamptz(),
    lastFailureKind: text({ enum: asEnumValues(SUPPLIER_PREFLIGHT_FAILURE_KINDS) }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'supplier_preflight_health_last_failure_kind_check',
      t.lastFailureKind,
      SUPPLIER_PREFLIGHT_FAILURE_KINDS,
    ),
    // The vacuity floor: a window that dropped an outcome cannot be stored.
    check(
      'supplier_preflight_health_counters_total_check',
      sql`${t.attempts} = ${t.successes} + ${t.failures}`,
    ),
    check(
      'supplier_preflight_health_counters_bounds_check',
      sql`${t.successes} >= 0 and ${t.failures} >= 0
          and ${t.timeouts} between 0 and ${t.failures}
          and ${t.rateLimited} between 0 and ${t.failures}
          and ${t.latencyMsTotal} >= 0
          and ${t.latencySamples} between 0 and ${t.attempts}
          and ${t.consecutiveFailures} >= 0`,
    ),
    check(
      'supplier_preflight_health_failure_shape_check',
      sql`num_nonnulls(${t.lastFailureAt}, ${t.lastFailureKind}) in (0, 2)`,
    ),
    uniqueIndex('supplier_preflight_health_account_key').on(t.supplierAccountId),
  ],
);

/**
 * `supplier_preflight_suppressions` — the supplier and market kill switches,
 * and the automatic health stop (#122 operations 4 and 6).
 *
 * The `retail_suppressions` shape (#121), in the domain that owns supply
 * OPERATIONS rather than product compliance, and deliberately not that table: a
 * recall says an item is unsafe to sell, this says a route cannot currently be
 * quoted. Reading a provider outage as a compliance stop would put a safety
 * vocabulary on an incident, and lifting it would then require a compliance
 * operator during an outage.
 *
 * ## An automatic suppression can only ever be a health one
 *
 * `origin = 'automatic_health'` is CHECK-restricted to
 * `kind = 'health_degraded'` and to a NULL raiser, and every other kind
 * requires an operator id. So the loop that watches health cannot file a
 * `kill_switch` — the power an operator holds stays an operator's, and the
 * automatic stop stays visibly automatic in the trail.
 *
 * ## One live suppression per subject, so two reactions converge
 *
 * A partial unique on the generated `suppression_key` `WHERE lifted_at IS NULL`.
 * Two operators reacting to one incident, or the health loop racing an
 * operator, land on one row rather than two — the `retail_suppressions`
 * mechanism and its reasoning verbatim.
 */
export const supplierPreflightSuppressions = pgTable(
  'supplier_preflight_suppressions',
  {
    id: generatedId(),
    scope: text({ enum: asEnumValues(SUPPLIER_SUPPRESSION_SCOPES) }).notNull(),
    /** Present exactly for the two supplier-bearing scopes. */
    supplierId: text().references(() => suppliers.id, { onDelete: 'restrict' }),
    /** Present exactly for the two account-bearing scopes. */
    supplierAccountId: text().references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** ISO-3166-1 alpha-2. Present exactly for the two market-bearing scopes. */
    marketCountry: text(),
    kind: text({ enum: asEnumValues(SUPPLIER_SUPPRESSION_KINDS) }).notNull(),
    origin: text({ enum: asEnumValues(SUPPLIER_SUPPRESSION_ORIGINS) }).notNull(),
    /** Mandatory: a stop with no stated cause cannot be reviewed or lifted safely. */
    reason: text().notNull(),
    /** The sourcing policy version whose thresholds an automatic stop was raised under. */
    sourcingPolicyId: text().references(() => supplierSourcingPolicies.id, {
      onDelete: 'restrict',
    }),
    /** An Oxy account id — no foreign key. NULL only for an automatic health stop. */
    raisedByOxyUserId: text(),
    effectiveFrom: timestamptz().notNull(),
    /** NULL = until lifted. An automatic stop always sets one, so it lapses on its own. */
    expiresAt: timestamptz(),
    liftedAt: timestamptz(),
    /** An Oxy account id — no foreign key. NULL when the lift was automatic. */
    liftedByOxyUserId: text(),
    liftReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The one-live-per-subject key, GENERATED so no write path can supply one
     * that disagrees with the scope it claims. `coalesce` and `||` are both
     * IMMUTABLE, which a stored generated column requires; `|` appears in no
     * uuid v7, ObjectId hex or ISO country code, so two subjects cannot render
     * to one key.
     */
    suppressionKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`"scope" || '|' || coalesce("supplier_id", '') || '|' ||
            coalesce("supplier_account_id", '') || '|' || coalesce("market_country", '') || '|' || "kind"`,
      ),
  },
  (t) => [
    checkOneOf('supplier_preflight_suppressions_scope_check', t.scope, SUPPLIER_SUPPRESSION_SCOPES),
    checkOneOf('supplier_preflight_suppressions_kind_check', t.kind, SUPPLIER_SUPPRESSION_KINDS),
    checkOneOf(
      'supplier_preflight_suppressions_origin_check',
      t.origin,
      SUPPLIER_SUPPRESSION_ORIGINS,
    ),
    // The scope DETERMINES which subject columns are present — all four
    // combinations, so a `market` stop cannot secretly name an account.
    check(
      'supplier_preflight_suppressions_scope_shape_check',
      sql`case ${t.scope}
            when 'supplier' then ${t.supplierId} is not null
                                 and ${t.supplierAccountId} is null
                                 and ${t.marketCountry} is null
            when 'supplier_account' then ${t.supplierAccountId} is not null
                                 and ${t.supplierId} is null
                                 and ${t.marketCountry} is null
            when 'market' then ${t.marketCountry} is not null
                                 and ${t.supplierId} is null
                                 and ${t.supplierAccountId} is null
            when 'supplier_account_market' then ${t.supplierAccountId} is not null
                                 and ${t.marketCountry} is not null
                                 and ${t.supplierId} is null
            else false
          end`,
    ),
    check(
      'supplier_preflight_suppressions_market_shape_check',
      sql`${t.marketCountry} is null or ${t.marketCountry} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'supplier_preflight_suppressions_reason_check',
      sql`length(btrim(${t.reason})) between 1 and ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // An automatic stop is a HEALTH stop, raised by nobody, citing the policy
    // whose thresholds it applied, and it lapses on its own. Everything else is
    // an operator's act and carries their id.
    check(
      'supplier_preflight_suppressions_origin_shape_check',
      sql`case ${t.origin}
            when 'automatic_health' then ${t.kind} = 'health_degraded'
                                       and ${t.raisedByOxyUserId} is null
                                       and ${t.sourcingPolicyId} is not null
                                       and ${t.expiresAt} is not null
            else ${t.raisedByOxyUserId} is not null
          end`,
    ),
    check(
      'supplier_preflight_suppressions_window_check',
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.effectiveFrom}`,
    ),
    // A lift is a time AND its explanation, together — and an operator's lift
    // names the operator. An automatic lapse names nobody, by design.
    check(
      'supplier_preflight_suppressions_lift_check',
      sql`num_nonnulls(${t.liftedAt}, ${t.liftReason}) in (0, 2)
          and (${t.liftedByOxyUserId} is null or ${t.liftedAt} is not null)
          and (${t.liftReason} is null
               or length(btrim(${t.liftReason})) <= ${sql.raw(String(MAX_NOTE_LENGTH))})`,
    ),
    // ONE live stop per subject and kind, so two reactions to one incident
    // converge instead of stacking.
    uniqueIndex('supplier_preflight_suppressions_live_key')
      .on(t.suppressionKey)
      .where(sql`${t.liftedAt} is null`),
    index('supplier_preflight_suppressions_account_idx')
      .on(t.supplierAccountId)
      .where(sql`${t.liftedAt} is null and ${t.supplierAccountId} is not null`),
    index('supplier_preflight_suppressions_market_idx')
      .on(t.marketCountry)
      .where(sql`${t.liftedAt} is null and ${t.marketCountry} is not null`),
    index('supplier_preflight_suppressions_raised_idx').on(t.effectiveFrom),
  ],
);
