/**
 * The authorized digital retail domain (#1016, ADR 0011): `digital_supply_terms`,
 * `digital_supplier_capabilities`, `digital_procurement_offers`,
 * `digital_retail_pricing_policies`, `digital_purchase_orders`,
 * `digital_purchase_order_attempts`, `digital_fulfilments`,
 * `digital_fulfilment_artifacts`, `digital_fulfilment_reveals`,
 * `digital_fulfilment_incidents`.
 *
 * Mercaria is the seller; an approved distributor is private procurement
 * infrastructure behind it. This file is the private half of that — nothing in it
 * has a route, a controller or a DTO, and the two projections that cross toward a
 * public surface (`DigitalRetailSourcingSeam`, `DigitalLibraryEntryView`) are
 * types with no cost and no supplier property.
 *
 * ## What this file does NOT redefine, and why that matters
 *
 * **The supplier spine.** `suppliers`, `supplier_accounts` and
 * `supplier_agreements` stay the ONE counterparty record (ADR 0011 D2). A second
 * supplier table would mean a second kill switch, and a kill switch that exists
 * twice is one that gets thrown once — while the credential that a compromise
 * compromises is the one `supplier_accounts.credential_reference` already names.
 * The digital half rides as `digital_supply_terms` (a rider on ONE agreement
 * version) and `digital_supplier_capabilities` (per account × capability, each
 * with its own pause, because an array column cannot carry one).
 *
 * **The physical purchase order.** `purchase_orders` ends at `delivered` through
 * `purchase_order_shipments` and carries a ship-to address. A digital order has
 * all nine address columns NULL (ADR 0010 D8), so a digital PO on that table would
 * need a shipment that never arrives and an address that must not exist.
 *
 * ## The three mechanisms that make procurement exactly-once (ADR 0011 D6)
 *
 * 1. `UNIQUE(idempotency_key)` — and the same key is what the adapter is handed,
 *    so a provider that honours idempotency dedupes on its side too.
 * 2. `digital_purchase_orders_live_line_key`, a partial unique on `order_item_id`
 *    over the NON-terminal statuses. Two live attempts for one order line are
 *    unrepresentable, which is the epic's fallback rule 1 — *never immediately buy
 *    another key after a timeout* — as a database property rather than as an
 *    ordering somebody has to preserve.
 * 3. The compare-and-swap claim in `digitalPurchaseOrderRepository`, which every
 *    transition goes through: `WHERE status = $from`, answering `updated` /
 *    `stale` / `missing`.
 *
 * ## Buyer identity is on the FULFILMENT, never on the purchase order
 *
 * A PO is a B2B record about buying a thing. It names an order and an order line
 * (as plain columns — the `purchase_orders.order_id` precedent, no foreign key, so
 * a procurement record is insertable and readable independently of the commerce
 * record it names) and it carries no `buyer_key`, no name and no address. The
 * buyer appears one table later, on `digital_fulfilments`, which is what the
 * library reads.
 *
 * ## Hand-written triggers ride the same migration
 *
 * drizzle-kit does not model triggers, so five enforcement functions are
 * hand-added to this domain's migration and REAPPLIED after any regeneration:
 * `digital_purchase_order_attempts`, `digital_fulfilment_reveals` and
 * `digital_fulfilment_incidents` history refuse UPDATE and DELETE; a
 * `digital_fulfilment_artifacts` row refuses DELETE outright and freezes its
 * sealed half once written. Nothing here is ever deleted (ADR 0011 D11) — this is
 * the evidence a chargeback over a used key is answered from.
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
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  DIGITAL_ARTIFACT_REDEMPTION_STATES,
  DIGITAL_ARTIFACT_SOURCES,
  DIGITAL_ARTIFACT_STATES,
  DIGITAL_FULFILMENT_CAPABILITIES,
  DIGITAL_FULFILMENT_INCIDENT_KINDS,
  DIGITAL_FULFILMENT_INCIDENT_STATES,
  DIGITAL_FULFILMENT_STATUSES,
  DIGITAL_PROCUREMENT_ERROR_KINDS,
  DIGITAL_PROCUREMENT_MAPPING_STATUSES,
  DIGITAL_PROCUREMENT_OFFER_STATUSES,
  DIGITAL_PURCHASE_ORDER_LIVE_STATUSES,
  DIGITAL_PURCHASE_ORDER_STATUSES,
  DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES,
  DIGITAL_RETAIL_PRODUCT_CLASSES,
  DIGITAL_RETAIL_ROUNDING_MODES,
  DIGITAL_RETAIL_TAX_CLASSES,
  DIGITAL_REVEAL_ACTOR_KINDS,
  DIGITAL_SUPPLIER_API_CAPABILITIES,
  DIGITAL_SUPPLIER_CAPABILITY_STATES,
  DIGITAL_SUPPLY_PROVENANCES,
  OPERATOR_RAISED_INCIDENT_KINDS,
  PROCUREMENT_AVAILABILITY_STATES,
  PROCUREMENT_PROVENANCES,
  RETAIL_PRICING_POLICY_STATUSES,
  SECRET_BEARING_FULFILMENT_CAPABILITIES,
} from '@mercaria/shared-types';
import { inList } from '@oxy.so/db';
import {
  CURRENCY_CODE_VALUES,
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  money,
  optionalMoney,
} from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { supplierAccounts, supplierAgreements, suppliers } from './procurement';

/**
 * A lower-case machine slug: a platform (`pc`), an activation ecosystem
 * (`steam`), an edition (`standard`).
 *
 * Shape-checked rather than a closed tuple, deliberately. An ecosystem list is a
 * moving target — a new storefront appears, a publisher renames one — and a closed
 * set would mean a migration per launch title. What makes exactness safe anyway is
 * `mapping_status` (ADR 0011 D4): the canonical variant is the identity, the slug
 * is the fact carried beside it, and an offer whose facts do not line up exactly
 * is `ambiguous` and dark.
 */
const SLUG_PATTERN = '^[a-z0-9][a-z0-9_-]*$';

/**
 * {@link SLUG_PATTERN} as a SQL literal chunk.
 *
 * `sql.raw`, and a function rather than a constant, because a bare string
 * interpolated into a `sql` template BINDS as a parameter — and a CHECK
 * constraint cannot carry one. drizzle-kit renders it as `~ $1`, the migration
 * fails at apply time with `there is no parameter $1`, and nothing before that
 * point says anything is wrong. Measured, on this file's first generation.
 */
const slugPattern = () => sql.raw(`'${SLUG_PATTERN}'`);

/* -------------------------------------------------------------------------- */
/* Who Mercaria may buy digital goods from                                    */
/* -------------------------------------------------------------------------- */

/**
 * `digital_supply_terms` — the DIGITAL RIDER on one `supplier_agreements`
 * version: what this counterparty has actually authorized Mercaria to resell,
 * where, of what, and how it may be fulfilled (the epic's Workstream 1).
 *
 * ONE row per agreement version (`UNIQUE(agreement_id)`), and its ABSENCE is
 * legible: an agreement with no rider authorizes no digital supply at all. That is
 * what makes the epic's invariant 4 structural — *"a supplier API, affiliate feed
 * or marketplace account does not automatically grant Mercaria resale rights"* —
 * because nothing about having an account creates a row here.
 *
 * ## `provenance` is NOT NULL with a four-member CHECK, and there is no `unknown`
 *
 * ADR 0011 D3. An `unverified` member would be a value the database accepts, which
 * means a row can sit in it, which means the eligibility rule is a service-level
 * `if` somebody can relax. Unclassified supply has no rider, and no rider already
 * authorizes nothing.
 *
 * ## Empty scope arrays mean NONE
 *
 * The `supplier_agreements` semantics, unchanged: an agreement GRANTS, and a grant
 * that names no territory grants none. (`commerce_relationships.territories` reads
 * `'{}'` as worldwide because a relationship is a positive fact being scoped down
 * — the two are documented against each other in `CONVENTIONS.md`.)
 *
 * ## What this table deliberately cannot express
 *
 * **Any permission for a gift card, a top-up or a cash-equivalent instrument.**
 * ADR 0011 D16 keeps ADR 0010 D16's stored-value half intact: there is no column
 * for one, and `permitted_product_classes` is CHECKed against a tuple with no such
 * member — so the permission is unrepresentable rather than defaulted to false.
 */
export const digitalSupplyTerms = pgTable(
  'digital_supply_terms',
  {
    id: generatedId(),
    /** The agreement VERSION this rider belongs to. One rider per version. */
    agreementId: text()
      .notNull()
      .references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    /** Denormalized from the agreement so "what may this supplier sell" is one index. */
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    provenance: text({ enum: asEnumValues(DIGITAL_SUPPLY_PROVENANCES) }).notNull(),
    /** The product classes this rider authorizes. Empty = none. */
    permittedProductClasses: text().array().notNull().default([]),
    /** The fulfilment capabilities this rider authorizes. Empty = none. */
    permittedFulfilmentCapabilities: text().array().notNull().default([]),
    /** ISO-3166-1 alpha-2 territories of ACTIVATION this rider authorizes. Empty = none. */
    permittedTerritories: text().array().notNull().default([]),
    /** Publisher / brand carve-outs, as the contract names them (lower-cased on write). */
    excludedBrands: text().array().notNull().default([]),
    /** Named product exclusions the contract carves out. */
    excludedProductRefs: text().array().notNull().default([]),
    /** Whether Mercaria may RESELL under this rider at all — the gate, not a hint. */
    resaleRightsGranted: boolean().notNull().default(false),
    /** Whether supplier catalogue metadata may be shown on a Mercaria surface. */
    catalogDataRightsGranted: boolean().notNull().default(false),
    /** Whether the supplier will replace an invalid artifact (the epic's W12). */
    replacementSupported: boolean().notNull().default(false),
    /** Whether the supplier will credit Mercaria for one. Separate from replacement. */
    creditSupported: boolean().notNull().default(false),
    /** Whether a submitted order can be cancelled before fulfilment. */
    cancellationSupported: boolean().notNull().default(false),
    /** A per-order procurement ceiling this counterparty is trusted for. Optional. */
    ...optionalMoney('maxOrderCost'),
    /** Where the signed digital rider lives — a vault ref or an Oxy file id. */
    evidenceLocation: text().notNull(),
    /** The operator who approved it. An Oxy account id — no foreign key. */
    approvedByOxyUserId: text().notNull(),
    approvedAt: timestamptz().notNull(),
    /** When this rider stops authorizing anything. NULL = with the agreement. */
    expiresAt: timestamptz(),
    supportEscalationNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('digital_supply_terms_provenance_check', t.provenance, DIGITAL_SUPPLY_PROVENANCES),
    checkEveryElementOf(
      'digital_supply_terms_product_classes_check',
      t.permittedProductClasses,
      DIGITAL_RETAIL_PRODUCT_CLASSES,
    ),
    checkEveryElementOf(
      'digital_supply_terms_capabilities_check',
      t.permittedFulfilmentCapabilities,
      DIGITAL_FULFILMENT_CAPABILITIES,
    ),
    check(
      'digital_supply_terms_territories_check',
      sql`not ('' = any(${t.permittedTerritories}))`,
    ),
    check('digital_supply_terms_brands_check', sql`not ('' = any(${t.excludedBrands}))`),
    check(
      'digital_supply_terms_product_refs_check',
      sql`not ('' = any(${t.excludedProductRefs}))`,
    ),
    check(
      'digital_supply_terms_evidence_check',
      sql`length(btrim(${t.evidenceLocation})) > 0`,
    ),
    ...currencyChecks('digital_supply_terms', [t.maxOrderCostCurrency]),
    // An optional Money is BOTH columns or NEITHER, and a ceiling of zero is not
    // a ceiling — it is a supplier nothing can be bought from, spelled as a limit.
    check(
      'digital_supply_terms_max_order_cost_check',
      sql`num_nonnulls(${t.maxOrderCostAmount}, ${t.maxOrderCostCurrency}) in (0, 2)
          and (${t.maxOrderCostAmount} is null or ${t.maxOrderCostAmount} > 0)`,
    ),
    uniqueIndex('digital_supply_terms_agreement_key').on(t.agreementId),
    index('digital_supply_terms_supplier_idx').on(t.supplierId, t.provenance),
  ],
);

/**
 * `digital_supplier_capabilities` — ONE row per supplier account × adapter
 * operation, each with its OWN pause state, health and reason.
 *
 * The epic requires catalog sync and procurement to pause INDEPENDENTLY (W2
 * requirement 9), and `supplier_accounts.api_capabilities` cannot express that: it
 * is a `text[]`, and an array carries no per-element pause, no per-element health
 * check and no per-element reason. Removing an element to pause it would also
 * lose the record that the capability exists.
 *
 * `state` defaults to `unavailable`, not `enabled`: a capability row created
 * because an adapter advertises an operation has not yet been proven against the
 * account, and fail-closed is the direction that costs nothing.
 */
export const digitalSupplierCapabilities = pgTable(
  'digital_supplier_capabilities',
  {
    id: generatedId(),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    capability: text({ enum: asEnumValues(DIGITAL_SUPPLIER_API_CAPABILITIES) }).notNull(),
    state: text({ enum: asEnumValues(DIGITAL_SUPPLIER_CAPABILITY_STATES) })
      .notNull()
      .default('unavailable'),
    /** The adapter contract version this capability was verified against. */
    adapterVersion: text(),
    /** NULL = never checked, which is a different fact from a failed check. */
    lastHealthCheckAt: timestamptz(),
    lastHealthCheckOk: boolean(),
    /** Per-capability throttle. NULL = the account's, then the adapter's default. */
    rateLimitPerMinute: integer(),
    pausedAt: timestamptz(),
    pauseReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'digital_supplier_capabilities_capability_check',
      t.capability,
      DIGITAL_SUPPLIER_API_CAPABILITIES,
    ),
    checkOneOf(
      'digital_supplier_capabilities_state_check',
      t.state,
      DIGITAL_SUPPLIER_CAPABILITY_STATES,
    ),
    // A pause is a state, a time and a mandatory reason, together — the
    // `supplier_accounts` kill-switch shape, applied one grain finer.
    check(
      'digital_supplier_capabilities_pause_check',
      sql`((${t.state} = 'paused') = (${t.pausedAt} is not null))
          and num_nonnulls(${t.pausedAt}, ${t.pauseReason}) in (0, 2)`,
    ),
    check(
      'digital_supplier_capabilities_rate_limit_check',
      sql`${t.rateLimitPerMinute} is null or ${t.rateLimitPerMinute} >= 1`,
    ),
    uniqueIndex('digital_supplier_capabilities_account_capability_key').on(
      t.supplierAccountId,
      t.capability,
    ),
    index('digital_supplier_capabilities_state_idx').on(t.capability, t.state),
  ],
);

/* -------------------------------------------------------------------------- */
/* Private procurement offers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `digital_procurement_offers` — the CURRENT terms under which Mercaria can source
 * one exact digital product from one supplier account. Private, always.
 *
 * Several offers may carry ONE `canonical_variant_id`: that is how Mercaria
 * sources one public product from several suppliers without minting several
 * products (the epic's acceptance criterion 17).
 *
 * ## `mapping_status` is the column this table exists for
 *
 * The epic's Workstream 4 closes with *"a supplier offer with ambiguous platform,
 * edition, region or activation ecosystem must not be used to fulfil a customer
 * order"*. So the offer is STORED with the supplier's own title kept verbatim for
 * audit, and only `exact` is procurable — the refusal `matchIncomingVariant`
 * already makes for a GTIN collision, which answers `ambiguous` and never
 * `skipped`.
 *
 * ## Current state, not history — and the purchase order is why that is safe
 *
 * A catalogue refresh UPDATES the row in place, converging on
 * `UNIQUE(supplier_account_id, supplier_sku)`. What was true at purchase time is
 * FROZEN onto `digital_purchase_orders` at creation and immutable there, so
 * refreshing an offer can never touch a submitted order's cost snapshot.
 */
export const digitalProcurementOffers = pgTable(
  'digital_procurement_offers',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** The digital rider governing this offer. NULL = `terms_missing`, and dark. */
    digitalSupplyTermsId: text().references(() => digitalSupplyTerms.id, {
      onDelete: 'restrict',
    }),
    /** Canonical-graph mapping (#56). `restrict`: canonical rows are never hard-deleted. */
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    /** The supplier's own SKU — source-scoped, half of the upsert key. */
    supplierSku: text().notNull(),
    /** The supplier platform's own catalogue id, when it has one. */
    supplierExternalId: text(),
    /** The supplier's own title, kept VERBATIM. The audit trail for a mapping. */
    supplierNativeTitle: text().notNull(),
    /** The brand the mapping believes this is, lower-cased — the carve-out input. */
    brandSlug: text(),
    productClass: text({ enum: asEnumValues(DIGITAL_RETAIL_PRODUCT_CLASSES) }).notNull(),
    fulfilmentCapability: text({ enum: asEnumValues(DIGITAL_FULFILMENT_CAPABILITIES) }).notNull(),
    taxClass: text({ enum: asEnumValues(DIGITAL_RETAIL_TAX_CLASSES) }).notNull(),
    /** `pc`, `xbox`, `playstation` … a lower-case slug, not a closed set. */
    platform: text().notNull(),
    /** `steam`, `gog`, `microsoft` … where it ACTIVATES. */
    activationEcosystem: text().notNull(),
    /** `standard`, `deluxe` … the edition as the catalogue knows it. */
    edition: text().notNull(),
    /** ISO-3166-1 alpha-2 territories of activation. Empty = unrestricted. */
    activationTerritories: text().array().notNull().default([]),
    /** Language restrictions where the SKU genuinely differs. Empty = none. */
    languageRestrictions: text().array().notNull().default([]),
    /** The WHOLESALE cost. Private — no projection in this repository carries it. */
    ...money('cost'),
    availability: text({ enum: asEnumValues(PROCUREMENT_AVAILABILITY_STATES) })
      .notNull()
      .default('unknown'),
    /** NULL where the supplier reports availability without a number. */
    availableQuantity: integer(),
    mappingStatus: text({ enum: asEnumValues(DIGITAL_PROCUREMENT_MAPPING_STATUSES) })
      .notNull()
      .default('unmapped'),
    /** Why the mapping is ambiguous, for the review queue. */
    mappingNote: text(),
    status: text({ enum: asEnumValues(DIGITAL_PROCUREMENT_OFFER_STATUSES) })
      .notNull()
      .default('active'),
    sourceProvenance: text({ enum: asEnumValues(PROCUREMENT_PROVENANCES) })
      .notNull()
      .default('api'),
    /** How long this quote may be trusted. NULL = no TTL, only `expires_at`. */
    quoteTtlSeconds: integer(),
    expiresAt: timestamptz(),
    /** Expected time from submission to artifact, for the checkout disclosure. */
    expectedFulfilmentSeconds: integer(),
    /** Survives every refresh. */
    firstSeenAt: timestamptz().notNull(),
    /** Moves with each refresh — the freshness derivation's input. */
    lastConfirmedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'digital_procurement_offers_product_class_check',
      t.productClass,
      DIGITAL_RETAIL_PRODUCT_CLASSES,
    ),
    checkOneOf(
      'digital_procurement_offers_capability_check',
      t.fulfilmentCapability,
      DIGITAL_FULFILMENT_CAPABILITIES,
    ),
    checkOneOf('digital_procurement_offers_tax_class_check', t.taxClass, DIGITAL_RETAIL_TAX_CLASSES),
    checkOneOf(
      'digital_procurement_offers_availability_check',
      t.availability,
      PROCUREMENT_AVAILABILITY_STATES,
    ),
    checkOneOf(
      'digital_procurement_offers_mapping_status_check',
      t.mappingStatus,
      DIGITAL_PROCUREMENT_MAPPING_STATUSES,
    ),
    checkOneOf(
      'digital_procurement_offers_status_check',
      t.status,
      DIGITAL_PROCUREMENT_OFFER_STATUSES,
    ),
    checkOneOf(
      'digital_procurement_offers_source_provenance_check',
      t.sourceProvenance,
      PROCUREMENT_PROVENANCES,
    ),
    ...currencyChecks('digital_procurement_offers', [t.costCurrency]),
    check('digital_procurement_offers_sku_check', sql`length(btrim(${t.supplierSku})) > 0`),
    check(
      'digital_procurement_offers_native_title_check',
      sql`length(btrim(${t.supplierNativeTitle})) > 0`,
    ),
    check(
      'digital_procurement_offers_slugs_check',
      sql`${t.platform} ~ ${slugPattern()}
          and ${t.activationEcosystem} ~ ${slugPattern()}
          and ${t.edition} ~ ${slugPattern()}
          and (${t.brandSlug} is null or ${t.brandSlug} ~ ${slugPattern()})`,
    ),
    check(
      'digital_procurement_offers_territories_check',
      sql`not ('' = any(${t.activationTerritories}))
          and not ('' = any(${t.languageRestrictions}))`,
    ),
    // A cost of zero is not a price, it is a missing one wearing a number.
    check('digital_procurement_offers_cost_check', sql`${t.costAmount} > 0`),
    check(
      'digital_procurement_offers_quantity_check',
      sql`${t.availableQuantity} is null or ${t.availableQuantity} >= 0`,
    ),
    check(
      'digital_procurement_offers_ttl_check',
      sql`(${t.quoteTtlSeconds} is null or ${t.quoteTtlSeconds} >= 1)
          and (${t.expectedFulfilmentSeconds} is null or ${t.expectedFulfilmentSeconds} >= 0)`,
    ),
    // The mapping biconditional, and the half that makes `exact` mean something.
    // `unmapped` is exactly "no variant"; `exact` additionally requires the
    // product, because a variant with no product is a mapping nobody finished.
    check(
      'digital_procurement_offers_mapping_shape_check',
      sql`((${t.mappingStatus} = 'unmapped') = (${t.canonicalVariantId} is null))
          and (${t.mappingStatus} <> 'exact' or ${t.canonicalProductId} is not null)`,
    ),
    // An ambiguous mapping states WHY, so the review queue is a work list rather
    // than a pile. Nothing else may carry the note.
    check(
      'digital_procurement_offers_mapping_note_check',
      sql`(${t.mappingStatus} = 'ambiguous') = (${t.mappingNote} is not null)`,
    ),
    check(
      'digital_procurement_offers_first_seen_check',
      sql`${t.lastConfirmedAt} >= ${t.firstSeenAt}`,
    ),
    uniqueIndex('digital_procurement_offers_account_sku_key').on(t.supplierAccountId, t.supplierSku),
    // "Which suppliers can source this variant" — the selector's own read.
    index('digital_procurement_offers_variant_idx')
      .on(t.canonicalVariantId, t.fulfilmentCapability)
      .where(sql`${t.status} = 'active' and ${t.mappingStatus} = 'exact'`),
    // The mapping review queue.
    index('digital_procurement_offers_review_idx')
      .on(t.supplierAccountId, t.lastConfirmedAt)
      .where(sql`${t.mappingStatus} = 'ambiguous'`),
    index('digital_procurement_offers_freshness_idx').on(t.lastConfirmedAt),
  ],
);

/**
 * `digital_retail_pricing_policies` — the versioned rule that turns a private
 * wholesale cost into Mercaria's public retail price (the epic's Workstream 5).
 *
 * ## Why this is NOT `retail_pricing_policies`
 *
 * ADR 0004 D3 is a COST-ONLY formula: physical Mercaria retail charges what it
 * paid, and its policy table is shaped around proving that the total is the exact
 * sum of approved components with no margin at all. Digital retail carries a
 * margin by decision (ADR 0011), so the two policies differ in the one direction a
 * shared table cannot absorb: one exists to prove margin is ZERO and the other to
 * bound it between a floor and a ceiling.
 *
 * ## Margin is bounded on BOTH sides, and the ceiling is the interesting one
 *
 * A floor stops selling below cost. A ceiling is what stops a cheap supplier
 * turning into an expensive shelf — and it is also what makes "the selector picked
 * the cheapest supplier" invisible to the buyer, because the retail price is a
 * function of the POLICY and the class, not of which supplier won.
 *
 * ONE active policy per market × product class, by partial unique index.
 */
export const digitalRetailPricingPolicies = pgTable(
  'digital_retail_pricing_policies',
  {
    id: generatedId(),
    /** The stable logical id shared by every version of this policy. */
    policyKey: text().notNull(),
    /** Monotonic per key, assigned by the operator creating the draft. */
    version: integer().notNull(),
    name: text().notNull(),
    /** The operator-facing statement of what this version approves and why. */
    summary: text().notNull(),
    status: text({ enum: asEnumValues(RETAIL_PRICING_POLICY_STATUSES) })
      .notNull()
      .default('draft'),
    /** ISO-3166-1 alpha-2. One market, so a launch is per market by construction. */
    market: text().notNull(),
    productClass: text({ enum: asEnumValues(DIGITAL_RETAIL_PRODUCT_CLASSES) }).notNull(),
    /** The currency every amount here and every price it produces is in. */
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** The least margin, in basis points of the retail price. */
    marginFloorBps: integer().notNull(),
    /** The most. `>= floor` by CHECK; equal means a fixed markup. */
    marginCeilingBps: integer().notNull(),
    /** The payment cost this policy passes through, in bps of retail. */
    paymentCostBps: integer().notNull().default(0),
    /** The fixed half of the payment cost, in minor units of `currency`. */
    paymentCostFixedMinor: bigint({ mode: 'number' }).notNull().default(0),
    roundingMode: text({ enum: asEnumValues(DIGITAL_RETAIL_ROUNDING_MODES) })
      .notNull()
      .default('minor_unit'),
    /** A competitive ceiling in minor units. NULL = none. */
    priceCeilingMinor: bigint({ mode: 'number' }),
    effectiveStart: timestamptz().notNull(),
    effectiveEnd: timestamptz(),
    /** An Oxy account id — no foreign key. */
    createdByOxyUserId: text().notNull(),
    approvedByOxyUserId: text(),
    activatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'digital_retail_pricing_policies_status_check',
      t.status,
      RETAIL_PRICING_POLICY_STATUSES,
    ),
    checkOneOf(
      'digital_retail_pricing_policies_product_class_check',
      t.productClass,
      DIGITAL_RETAIL_PRODUCT_CLASSES,
    ),
    checkOneOf(
      'digital_retail_pricing_policies_rounding_check',
      t.roundingMode,
      DIGITAL_RETAIL_ROUNDING_MODES,
    ),
    ...currencyChecks('digital_retail_pricing_policies', [t.currency]),
    check('digital_retail_pricing_policies_version_check', sql`${t.version} >= 1`),
    check('digital_retail_pricing_policies_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    // Basis points are bounded at both ends, the ceiling is never below the floor,
    // and a 100% margin (10 000 bps of the RETAIL price) is not reachable because
    // the retail price would have to be infinite.
    check(
      'digital_retail_pricing_policies_margin_check',
      sql`${t.marginFloorBps} >= 0
          and ${t.marginCeilingBps} >= ${t.marginFloorBps}
          and ${t.marginCeilingBps} < 10000
          and ${t.paymentCostBps} >= 0
          and ${t.paymentCostBps} < 10000
          and ${t.paymentCostFixedMinor} >= 0`,
    ),
    check(
      'digital_retail_pricing_policies_ceiling_check',
      sql`${t.priceCeilingMinor} is null or ${t.priceCeilingMinor} > 0`,
    ),
    check(
      'digital_retail_pricing_policies_window_check',
      sql`${t.effectiveEnd} is null or ${t.effectiveEnd} > ${t.effectiveStart}`,
    ),
    // An activation is a decision WITH its record.
    check(
      'digital_retail_pricing_policies_activation_check',
      sql`${t.status} <> 'active'
          or (${t.activatedAt} is not null and ${t.approvedByOxyUserId} is not null)`,
    ),
    uniqueIndex('digital_retail_pricing_policies_key_version_key').on(t.policyKey, t.version),
    // ONE active policy per market and class — so "which policy priced this" has
    // exactly one answer at any moment.
    uniqueIndex('digital_retail_pricing_policies_active_key')
      .on(t.market, t.productClass)
      .where(sql`${t.status} = 'active'`),
  ],
);

/* -------------------------------------------------------------------------- */
/* The digital purchase order                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `digital_purchase_orders` — the durable B2B record of ONE attempt to buy ONE
 * customer order line from ONE supplier (ADR 0011 D5).
 *
 * A fallback to a second supplier is a SECOND row, chained by
 * `previous_purchase_order_id`, never an edit of the first: the first row is the
 * evidence of what was tried, and an audit that can be overwritten is not one.
 *
 * ## The two indexes that make procurement exactly-once
 *
 * `digital_purchase_orders_idempotency_key` is the adapter's key as well as the
 * database's. `digital_purchase_orders_live_line_key` is a PARTIAL unique on
 * `order_item_id` over the non-terminal statuses, and it is the epic's fallback
 * rule 1 made structural: while an attempt is unresolved — `ambiguous` above all —
 * a second one cannot be inserted at all.
 *
 * ## `max_accepted_cost` is what bounds every later attempt
 *
 * Set at preflight and carried down the fallback chain unchanged. A supplier whose
 * cost exceeds it is ineligible (`cost_above_bound`), so *"never charge the
 * customer more without explicit consent"* needs no code — there is no path that
 * could. When nothing eligible remains inside the bound, the order converges on
 * cancellation and refund, which is deliberately the only other outcome.
 *
 * ## No buyer identity, on purpose
 *
 * `order_id` and `order_item_id` are plain indexed columns with NO foreign key —
 * the `purchase_orders.order_id` precedent: a procurement record must be
 * insertable and readable independently of the commerce record it names, and it
 * outlives anything that happens to that row. There is no `buyer_key`, no name and
 * no address here; the buyer appears on `digital_fulfilments`.
 */
export const digitalPurchaseOrders = pgTable(
  'digital_purchase_orders',
  {
    id: generatedId(),
    /**
     * The DERIVED key this attempt is identified by, on both sides of the wire.
     * `dpo:<order_item_id>:<attempt_ordinal>` — deterministic, so a retry of the
     * same attempt re-derives it and collides rather than buying twice.
     */
    idempotencyKey: text().notNull(),
    /** 1 for the first supplier tried, 2 for the first fallback, and so on. */
    attemptOrdinal: integer().notNull().default(1),
    /** The customer order this fulfils. No foreign key — see the docblock. */
    orderId: text().notNull(),
    orderItemId: text().notNull(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** The rider this purchase is authorized by. Required — nothing procures without one. */
    digitalSupplyTermsId: text()
      .notNull()
      .references(() => digitalSupplyTerms.id, { onDelete: 'restrict' }),
    /** SNAPSHOT provenance — deliberately no foreign key; offers refresh in place. */
    digitalProcurementOfferId: text(),
    /** SNAPSHOT provenance — deliberately no foreign key; canonical entities merge. */
    canonicalVariantId: text(),
    /** Everything below is FROZEN at creation: what was bought, as it was then. */
    supplierSku: text().notNull(),
    productClass: text({ enum: asEnumValues(DIGITAL_RETAIL_PRODUCT_CLASSES) }).notNull(),
    fulfilmentCapability: text({ enum: asEnumValues(DIGITAL_FULFILMENT_CAPABILITIES) }).notNull(),
    platform: text().notNull(),
    activationEcosystem: text().notNull(),
    edition: text().notNull(),
    /** The quoted wholesale cost at preflight. */
    ...money('quotedCost'),
    /** The ceiling this order line may ever pay — inherited by every fallback. */
    ...money('maxAcceptedCost'),
    /** What was actually charged, once the supplier says. */
    ...optionalMoney('finalCost'),
    status: text({ enum: asEnumValues(DIGITAL_PURCHASE_ORDER_STATUSES) })
      .notNull()
      .default('pending'),
    statusChangedAt: timestamptz().notNull(),
    /** The supplier's own order id — a foreign key space, never a Mercaria key. */
    providerOrderId: text(),
    /** The supplier's correlation reference, kept privately for escalation. */
    providerReference: text(),
    errorKind: text({ enum: asEnumValues(DIGITAL_PROCUREMENT_ERROR_KINDS) }),
    /** The supplier's own message, REDACTED at the write site. */
    errorMessageRedacted: text(),
    preflightedAt: timestamptz(),
    submittedAt: timestamptz(),
    /** When this attempt first became ambiguous. Kept after recovery, as history. */
    ambiguousSince: timestamptz(),
    /** When it reached a terminal state. */
    resolvedAt: timestamptz(),
    /** The attempt this one replaces. NULL exactly when `attempt_ordinal = 1`. */
    previousPurchaseOrderId: text().references((): AnyPgColumn => digitalPurchaseOrders.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('digital_purchase_orders_status_check', t.status, DIGITAL_PURCHASE_ORDER_STATUSES),
    checkOneOf(
      'digital_purchase_orders_product_class_check',
      t.productClass,
      DIGITAL_RETAIL_PRODUCT_CLASSES,
    ),
    checkOneOf(
      'digital_purchase_orders_capability_check',
      t.fulfilmentCapability,
      DIGITAL_FULFILMENT_CAPABILITIES,
    ),
    checkOneOf(
      'digital_purchase_orders_error_kind_check',
      t.errorKind,
      DIGITAL_PROCUREMENT_ERROR_KINDS,
    ),
    ...currencyChecks('digital_purchase_orders', [
      t.quotedCostCurrency,
      t.maxAcceptedCostCurrency,
      t.finalCostCurrency,
    ]),
    // The key is DERIVED, and its shape says so: a hand-typed value fails here.
    check(
      'digital_purchase_orders_idempotency_key_check',
      sql`${t.idempotencyKey} ~ '^dpo:[A-Za-z0-9_-]+:[0-9]+$'`,
    ),
    check('digital_purchase_orders_attempt_check', sql`${t.attemptOrdinal} >= 1`),
    // The fallback chain is a chain: attempt 1 starts it, every later attempt
    // names the one it replaces. Neither half is inferable from the other alone.
    check(
      'digital_purchase_orders_chain_check',
      sql`(${t.attemptOrdinal} = 1) = (${t.previousPurchaseOrderId} is null)`,
    ),
    check(
      'digital_purchase_orders_order_refs_check',
      sql`length(btrim(${t.orderId})) > 0 and length(btrim(${t.orderItemId})) > 0`,
    ),
    check(
      'digital_purchase_orders_slugs_check',
      sql`${t.platform} ~ ${slugPattern()}
          and ${t.activationEcosystem} ~ ${slugPattern()}
          and ${t.edition} ~ ${slugPattern()}`,
    ),
    // The bound is in the same currency as the quote, and is never below it.
    // Two amounts in two currencies cannot be compared, and a bound below the
    // quote is an order that could never have been placed.
    check(
      'digital_purchase_orders_cost_bound_check',
      sql`${t.quotedCostCurrency} = ${t.maxAcceptedCostCurrency}
          and ${t.maxAcceptedCostAmount} >= ${t.quotedCostAmount}
          and ${t.quotedCostAmount} > 0`,
    ),
    // A final cost is both columns or neither, in the same currency as the quote,
    // and never above the ceiling — the database's own copy of the rule.
    check(
      'digital_purchase_orders_final_cost_check',
      sql`num_nonnulls(${t.finalCostAmount}, ${t.finalCostCurrency}) in (0, 2)
          and (${t.finalCostCurrency} is null or ${t.finalCostCurrency} = ${t.quotedCostCurrency})
          and (${t.finalCostAmount} is null or ${t.finalCostAmount} <= ${t.maxAcceptedCostAmount})`,
    ),
    // Ordering of the clock columns: you cannot submit what was never preflighted.
    check(
      'digital_purchase_orders_clock_check',
      sql`(${t.submittedAt} is null or ${t.preflightedAt} is not null)
          and (${t.status} <> 'ambiguous' or ${t.ambiguousSince} is not null)`,
    ),
    // A terminal state has a resolution time. Rendered from the tuple, so adding
    // a terminal status without deciding this fails the migration rather than the
    // next incident.
    check(
      'digital_purchase_orders_resolved_check',
      sql`${t.status} not in (${sql.raw(inList(DIGITAL_PURCHASE_ORDER_TERMINAL_STATUSES))})
          or ${t.resolvedAt} is not null`,
    ),
    // A message about no error is a claim about nothing.
    check(
      'digital_purchase_orders_error_pairing_check',
      sql`${t.errorMessageRedacted} is null or ${t.errorKind} is not null`,
    ),
    uniqueIndex('digital_purchase_orders_idempotency_key').on(t.idempotencyKey),
    // MECHANISM 2 (ADR 0011 D6): one live attempt per order line, ever.
    uniqueIndex('digital_purchase_orders_live_line_key')
      .on(t.orderItemId)
      .where(sql`${t.status} in (${sql.raw(inList(DIGITAL_PURCHASE_ORDER_LIVE_STATUSES))})`),
    index('digital_purchase_orders_order_idx').on(t.orderId),
    index('digital_purchase_orders_account_idx').on(t.supplierAccountId, t.status),
    // The recovery sweeper's own read: what has been ambiguous longest.
    index('digital_purchase_orders_ambiguous_idx')
      .on(t.ambiguousSince)
      .where(sql`${t.status} = 'ambiguous'`),
  ],
);

/**
 * `digital_purchase_order_attempts` — one row per ADAPTER CALL made for a purchase
 * order: which operation, how long it took, what came back.
 *
 * Append-only, by trigger and by the ABSENCE of `updated_at`. This is the record
 * the epic's Workstream 6 closing line asks for — *"every attempt must be
 * auditable"* — and the thing a duplicate-prevention incident is reconstructed
 * from, so an edit path would destroy the only account of what happened.
 *
 * The supplier's own message is REDACTED before it is written. Provider payloads
 * are never stored whole (the epic's W19 requirement 6).
 */
export const digitalPurchaseOrderAttempts = pgTable(
  'digital_purchase_order_attempts',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => digitalPurchaseOrders.id, { onDelete: 'restrict' }),
    /** Monotonic per purchase order, starting at 1. */
    attemptNumber: integer().notNull(),
    operation: text({ enum: asEnumValues(DIGITAL_SUPPLIER_API_CAPABILITIES) }).notNull(),
    /** `succeeded`, `failed`, or `ambiguous` — the outcome of THIS call. */
    outcome: text({ enum: ['succeeded', 'failed', 'ambiguous'] as const }).notNull(),
    errorKind: text({ enum: asEnumValues(DIGITAL_PROCUREMENT_ERROR_KINDS) }),
    errorMessageRedacted: text(),
    /** The provider's own request correlation id, kept privately. */
    providerRequestId: text(),
    providerReference: text(),
    durationMs: integer(),
    startedAt: timestamptz().notNull(),
    finishedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'digital_purchase_order_attempts_operation_check',
      t.operation,
      DIGITAL_SUPPLIER_API_CAPABILITIES,
    ),
    checkOneOf('digital_purchase_order_attempts_outcome_check', t.outcome, [
      'succeeded',
      'failed',
      'ambiguous',
    ]),
    checkOneOf(
      'digital_purchase_order_attempts_error_kind_check',
      t.errorKind,
      DIGITAL_PROCUREMENT_ERROR_KINDS,
    ),
    check('digital_purchase_order_attempts_number_check', sql`${t.attemptNumber} >= 1`),
    // An unsuccessful call names WHY in the closed taxonomy; a successful one
    // carries no error at all. Both directions, because either alone permits a
    // row that says nothing or a row that contradicts itself.
    check(
      'digital_purchase_order_attempts_error_shape_check',
      sql`(${t.outcome} = 'succeeded') = (${t.errorKind} is null)
          and (${t.errorMessageRedacted} is null or ${t.errorKind} is not null)`,
    ),
    check(
      'digital_purchase_order_attempts_clock_check',
      sql`${t.finishedAt} >= ${t.startedAt}
          and (${t.durationMs} is null or ${t.durationMs} >= 0)`,
    ),
    uniqueIndex('digital_purchase_order_attempts_number_key').on(t.purchaseOrderId, t.attemptNumber),
    index('digital_purchase_order_attempts_operation_idx').on(t.operation, t.outcome, t.startedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Fulfilment: what the buyer durably owns                                     */
/* -------------------------------------------------------------------------- */

/**
 * `digital_fulfilments` — what a BUYER owns as a result of an authorized retail
 * purchase. The #1016 half of the library's two sources (ADR 0011 D17).
 *
 * ONE row per order line (`UNIQUE(order_item_id)`), whatever happened upstream: a
 * fallback to a second supplier is a second purchase order and the SAME
 * fulfilment, because the buyer still owns the one thing they bought. That is what
 * makes "the customer sees no supplier-switch complexity" (the epic's acceptance
 * criterion 8) structural rather than a rendering choice.
 *
 * A REPLACEMENT is likewise not a second fulfilment — it is a second artifact, and
 * `digital_fulfilment_artifacts` carries a partial unique that keeps exactly one
 * of them active.
 *
 * `buyer_key` is `oxy:<id>` or `guest:<sessionId>`, the same spelling
 * `asset_rights.buyer_key` uses, so the library reads both sources with one key
 * and a guest reaches theirs through #101's scoped authorization.
 */
export const digitalFulfilments = pgTable(
  'digital_fulfilments',
  {
    id: generatedId(),
    /** The purchase order that produced it. One fulfilment per successful PO. */
    purchaseOrderId: text()
      .notNull()
      .references(() => digitalPurchaseOrders.id, { onDelete: 'restrict' }),
    /** No foreign key — the procurement-domain precedent, stated on the PO. */
    orderId: text().notNull(),
    orderItemId: text().notNull(),
    /** `oxy:<id>` or `guest:<sessionId>` — one column for two id spaces. */
    buyerKey: text().notNull(),
    capability: text({ enum: asEnumValues(DIGITAL_FULFILMENT_CAPABILITIES) }).notNull(),
    productClass: text({ enum: asEnumValues(DIGITAL_RETAIL_PRODUCT_CLASSES) }).notNull(),
    status: text({ enum: asEnumValues(DIGITAL_FULFILMENT_STATUSES) })
      .notNull()
      .default('pending'),
    /** SNAPSHOT provenance — deliberately no foreign key; canonical entities merge. */
    canonicalVariantId: text(),
    /** What the buyer sees as the product name, frozen at purchase. */
    displayTitle: text().notNull(),
    platform: text().notNull(),
    activationEcosystem: text().notNull(),
    edition: text().notNull(),
    deliveredAt: timestamptz(),
    /** The FIRST reveal, ever. Never cleared — a reveal is not undoable. */
    firstRevealedAt: timestamptz(),
    /** How many times a secret has been handed over. Never a device fingerprint. */
    revealCount: integer().notNull().default(0),
    refundedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('digital_fulfilments_capability_check', t.capability, DIGITAL_FULFILMENT_CAPABILITIES),
    checkOneOf(
      'digital_fulfilments_product_class_check',
      t.productClass,
      DIGITAL_RETAIL_PRODUCT_CLASSES,
    ),
    checkOneOf('digital_fulfilments_status_check', t.status, DIGITAL_FULFILMENT_STATUSES),
    // The same CHECK `asset_rights.buyer_key` carries: a key belongs to one of
    // exactly two id spaces and says which.
    check('digital_fulfilments_buyer_key_check', sql`${t.buyerKey} ~ '^(oxy|guest):[^[:space:]]+$'`),
    check(
      'digital_fulfilments_order_refs_check',
      sql`length(btrim(${t.orderId})) > 0 and length(btrim(${t.orderItemId})) > 0`,
    ),
    check('digital_fulfilments_title_check', sql`length(btrim(${t.displayTitle})) > 0`),
    check(
      'digital_fulfilments_slugs_check',
      sql`${t.platform} ~ ${slugPattern()}
          and ${t.activationEcosystem} ~ ${slugPattern()}
          and ${t.edition} ~ ${slugPattern()}`,
    ),
    // `delivered` is exactly "there is a delivery time", so a fulfilment cannot
    // claim to have been delivered without one, nor carry one without saying so.
    // The later states are reached FROM `delivered` and keep it.
    check(
      'digital_fulfilments_delivered_check',
      sql`(${t.status} = 'pending') = (${t.deliveredAt} is null)`,
    ),
    check(
      'digital_fulfilments_refunded_check',
      sql`(${t.status} = 'refunded') = (${t.refundedAt} is not null)`,
    ),
    // The counter and the first-reveal timestamp are two views of one fact.
    check(
      'digital_fulfilments_reveal_check',
      sql`${t.revealCount} >= 0
          and (${t.revealCount} = 0) = (${t.firstRevealedAt} is null)`,
    ),
    uniqueIndex('digital_fulfilments_order_item_key').on(t.orderItemId),
    uniqueIndex('digital_fulfilments_purchase_order_key').on(t.purchaseOrderId),
    // The LIBRARY's own read: everything one buyer owns, newest first.
    index('digital_fulfilments_buyer_idx').on(t.buyerKey, t.createdAt),
    index('digital_fulfilments_order_idx').on(t.orderId),
  ],
);

/**
 * `digital_fulfilment_artifacts` — the thing that was actually handed over, sealed
 * (ADR 0011 D10).
 *
 * ## There is no plaintext column, and there is no URL column
 *
 * A secret-bearing artifact is stored as `sealed_secret` (ciphertext),
 * `key_reference` (a PATH into the approved secret store, shaped by CHECK exactly
 * like `supplier_accounts.credential_reference`, so a pasted key fails the write)
 * and `seal_algorithm`. All three are registered in `db/protectedColumns.ts`, so a
 * whole-row read cannot ship them and a serializer that reaches for one fails
 * `tsc`.
 *
 * `masked_hint` is at most four characters and IS stored in clear. It exists so
 * support can answer *"is the key you are holding the key we sold you"* without
 * revealing the secret to an operator on every enquiry, and so a buyer can tell
 * two purchases apart in a list. Four characters cannot reconstruct a key.
 *
 * ## A reveal is not a redemption
 *
 * `digital_fulfilments.first_revealed_at` is written when the buyer looks;
 * `redemption_state` may only be moved by provider truth, and its default is
 * `unknown` because for most ecosystems it is. Collapsing them would make "the
 * customer looked at their key" indistinguishable from "the key was used" — the
 * distinction a refund decision turns on.
 *
 * ## Exactly one active artifact, by partial unique index
 *
 * A replacement is a NEW row carrying `replaces_artifact_id`; the old one moves to
 * `replaced` and is KEPT. "Both the original and the replacement are valid" is
 * therefore unrepresentable rather than a race somebody has to think about.
 */
export const digitalFulfilmentArtifacts = pgTable(
  'digital_fulfilment_artifacts',
  {
    id: generatedId(),
    fulfilmentId: text()
      .notNull()
      .references(() => digitalFulfilments.id, { onDelete: 'restrict' }),
    capability: text({ enum: asEnumValues(DIGITAL_FULFILMENT_CAPABILITIES) }).notNull(),
    source: text({ enum: asEnumValues(DIGITAL_ARTIFACT_SOURCES) }).notNull(),
    state: text({ enum: asEnumValues(DIGITAL_ARTIFACT_STATES) })
      .notNull()
      .default('active'),
    /** CIPHERTEXT. PROTECTED. NULL for a capability that hands over no secret. */
    sealedSecret: text(),
    /** A secret-store PATH naming the key it was sealed with — never a key. PROTECTED. */
    keyReference: text(),
    /** The sealing algorithm, so a re-key can find what needs re-sealing. */
    sealAlgorithm: text(),
    /** SHA-256 of the plaintext — support matching and de-duplication. PROTECTED. */
    plaintextSha256: text(),
    /** At most four characters of the plaintext's TAIL. Deliberately in clear. */
    maskedHint: text(),
    /** Customer-facing redemption instructions. Never contains the secret. */
    instructions: text(),
    /** The provider's own id for the allocated artifact, kept privately. */
    providerArtifactId: text(),
    redemptionState: text({ enum: asEnumValues(DIGITAL_ARTIFACT_REDEMPTION_STATES) })
      .notNull()
      .default('unknown'),
    redemptionCheckedAt: timestamptz(),
    /** When the artifact itself stops working, where the supplier states one. */
    expiresAt: timestamptz(),
    /** The artifact this one replaces. `restrict` — evidence is never orphaned. */
    replacesArtifactId: text().references((): AnyPgColumn => digitalFulfilmentArtifacts.id, {
      onDelete: 'restrict',
    }),
    /**
     * The incident that authorized a manual or replacement artifact.
     *
     * NO foreign key, and it is the direction that decides: the artifact is the
     * record of what was handed to a buyer and must be insertable and readable
     * independently of any support row's lifetime. `digital_fulfilment_incidents`
     * points back with a real one.
     */
    incidentId: text(),
    /** The operator who entered a manual artifact. Required for `operator_manual`. */
    operatorOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'digital_fulfilment_artifacts_capability_check',
      t.capability,
      DIGITAL_FULFILMENT_CAPABILITIES,
    ),
    checkOneOf('digital_fulfilment_artifacts_source_check', t.source, DIGITAL_ARTIFACT_SOURCES),
    checkOneOf('digital_fulfilment_artifacts_state_check', t.state, DIGITAL_ARTIFACT_STATES),
    checkOneOf(
      'digital_fulfilment_artifacts_redemption_check',
      t.redemptionState,
      DIGITAL_ARTIFACT_REDEMPTION_STATES,
    ),
    // A secret-bearing capability HAS a sealed secret, and a capability that hands
    // over nothing carries none. Two directions, because either alone admits a row
    // that contradicts itself — an `activation_key` with nothing in it, or a
    // `direct_account_activation` with a key nobody should ever be shown.
    check(
      'digital_fulfilment_artifacts_secret_presence_check',
      sql`(${t.capability} in (${sql.raw(inList(SECRET_BEARING_FULFILMENT_CAPABILITIES))}))
          = (${t.sealedSecret} is not null)`,
    ),
    // The seal is a three-column fact: ciphertext, the key that sealed it, and how.
    check(
      'digital_fulfilment_artifacts_seal_shape_check',
      sql`num_nonnulls(${t.sealedSecret}, ${t.keyReference}, ${t.sealAlgorithm}) in (0, 3)`,
    ),
    // A secret-store PATH: leading slash, path characters, bounded. A raw key
    // fails this shape — which is the point.
    check(
      'digital_fulfilment_artifacts_key_reference_check',
      sql`${t.keyReference} is null
          or (${t.keyReference} ~ '^/[A-Za-z0-9/_.-]+$' and length(${t.keyReference}) <= 512)`,
    ),
    check(
      'digital_fulfilment_artifacts_digest_check',
      sql`${t.plaintextSha256} is null or ${t.plaintextSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    // Four characters, and never zero: a hint of nothing is a column that looks
    // answered and is not.
    check(
      'digital_fulfilment_artifacts_hint_check',
      sql`${t.maskedHint} is null
          or (length(${t.maskedHint}) between 1 and 4 and ${t.maskedHint} = btrim(${t.maskedHint}))`,
    ),
    // A hint is about a secret. No secret, no hint.
    check(
      'digital_fulfilment_artifacts_hint_pairing_check',
      sql`${t.maskedHint} is null or ${t.sealedSecret} is not null`,
    ),
    // ADR 0011 D12: an operator-entered artifact names the operator AND the
    // incident that authorized it. No default, so the audit cannot be skipped.
    check(
      'digital_fulfilment_artifacts_operator_check',
      sql`(${t.source} = 'operator_manual')
          = (${t.operatorOxyUserId} is not null and ${t.incidentId} is not null)`,
    ),
    check(
      'digital_fulfilment_artifacts_redemption_clock_check',
      sql`${t.redemptionState} = 'unknown' or ${t.redemptionCheckedAt} is not null`,
    ),
    // An artifact never replaces itself, and a replacement names its incident.
    check(
      'digital_fulfilment_artifacts_replacement_check',
      sql`${t.replacesArtifactId} is distinct from ${t.id}
          and (${t.replacesArtifactId} is null or ${t.incidentId} is not null)`,
    ),
    // EXACTLY ONE active artifact per fulfilment.
    uniqueIndex('digital_fulfilment_artifacts_active_key')
      .on(t.fulfilmentId)
      .where(sql`${t.state} = 'active'`),
    index('digital_fulfilment_artifacts_fulfilment_idx').on(t.fulfilmentId, t.createdAt),
    index('digital_fulfilment_artifacts_incident_idx').on(t.incidentId),
  ],
);

/**
 * `digital_fulfilment_reveals` — every time a secret was handed over, and to whom.
 *
 * Append-only by trigger and by the ABSENCE of `updated_at`. The epic's Workstream
 * 11 asks for the first revelation timestamp and for subsequent revelations
 * *"without storing invasive fingerprint data"*, so this table has no IP column,
 * no user-agent column, no device id and no session fingerprint —
 * `~/AGENTS.md`'s no-IP invariant with no exception, and the same absence
 * `asset_download_events` already keeps. A walls test asserts it rather than
 * trusting the review that wrote it.
 *
 * An OPERATOR reveal requires an operator id and a reason. A buyer reveal requires
 * the buyer key it was authorized under.
 */
export const digitalFulfilmentReveals = pgTable(
  'digital_fulfilment_reveals',
  {
    id: generatedId(),
    fulfilmentId: text()
      .notNull()
      .references(() => digitalFulfilments.id, { onDelete: 'restrict' }),
    artifactId: text()
      .notNull()
      .references(() => digitalFulfilmentArtifacts.id, { onDelete: 'restrict' }),
    actorKind: text({ enum: asEnumValues(DIGITAL_REVEAL_ACTOR_KINDS) }).notNull(),
    /** The buyer the reveal was authorized for — present for a buyer reveal. */
    buyerKey: text(),
    /** An Oxy account id — present for an operator reveal, with its reason. */
    operatorOxyUserId: text(),
    /** Why an operator looked. Mandatory for an operator reveal. */
    reason: text(),
    revealedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('digital_fulfilment_reveals_actor_check', t.actorKind, DIGITAL_REVEAL_ACTOR_KINDS),
    check(
      'digital_fulfilment_reveals_buyer_key_check',
      sql`${t.buyerKey} is null or ${t.buyerKey} ~ '^(oxy|guest):[^[:space:]]+$'`,
    ),
    // Each actor kind carries exactly its own evidence, and neither carries the
    // other's — an operator reveal recorded against a buyer key would read, later,
    // as the buyer having looked.
    check(
      'digital_fulfilment_reveals_actor_shape_check',
      sql`(${t.actorKind} = 'buyer') = (${t.buyerKey} is not null)
          and (${t.actorKind} = 'operator')
              = (${t.operatorOxyUserId} is not null and ${t.reason} is not null)`,
    ),
    index('digital_fulfilment_reveals_fulfilment_idx').on(t.fulfilmentId, t.revealedAt),
    index('digital_fulfilment_reveals_artifact_idx').on(t.artifactId),
  ],
);

/**
 * `digital_fulfilment_incidents` — the audited record of something having gone
 * wrong with a delivered artifact, and what was done about it (the epic's
 * Workstream 12 and 18).
 *
 * Append-only in its history: the row's STATE moves, and a trigger refuses DELETE
 * outright. A dispute over an invalid key is answered from here.
 *
 * ADR 0011 D12's other half: an incident whose kind is an OPERATOR action requires
 * a named operator, with no default — a machine can never file one. That is the
 * rule #1015's provenance escalation already runs, restated for a domain where the
 * thing being manufactured is money's worth of key.
 */
export const digitalFulfilmentIncidents = pgTable(
  'digital_fulfilment_incidents',
  {
    id: generatedId(),
    fulfilmentId: text()
      .notNull()
      .references(() => digitalFulfilments.id, { onDelete: 'restrict' }),
    /** The artifact complained about. NULL where the incident precedes one. */
    artifactId: text().references(() => digitalFulfilmentArtifacts.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(DIGITAL_FULFILMENT_INCIDENT_KINDS) }).notNull(),
    state: text({ enum: asEnumValues(DIGITAL_FULFILMENT_INCIDENT_STATES) })
      .notNull()
      .default('open'),
    /** What the buyer said, in their own words. Never contains a secret. */
    reportNote: text(),
    /** The buyer who reported it, where a buyer did. */
    buyerKey: text(),
    /** An Oxy account id. Required for the operator-raised kinds. */
    operatorOxyUserId: text(),
    /** The supplier's own case reference, kept privately for escalation. */
    supplierCaseRef: text(),
    /** The artifact issued as a replacement, once one was. */
    replacementArtifactId: text().references(() => digitalFulfilmentArtifacts.id, {
      onDelete: 'restrict',
    }),
    resolutionNote: text(),
    reportedAt: timestamptz().notNull(),
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'digital_fulfilment_incidents_kind_check',
      t.kind,
      DIGITAL_FULFILMENT_INCIDENT_KINDS,
    ),
    checkOneOf(
      'digital_fulfilment_incidents_state_check',
      t.state,
      DIGITAL_FULFILMENT_INCIDENT_STATES,
    ),
    check(
      'digital_fulfilment_incidents_buyer_key_check',
      sql`${t.buyerKey} is null or ${t.buyerKey} ~ '^(oxy|guest):[^[:space:]]+$'`,
    ),
    // ADR 0011 D12: an operator-raised incident names the operator.
    check(
      'digital_fulfilment_incidents_operator_check',
      sql`${t.kind} not in (${sql.raw(inList(OPERATOR_RAISED_INCIDENT_KINDS))})
          or ${t.operatorOxyUserId} is not null`,
    ),
    // "A replacement was issued" is exactly "there is a replacement artifact".
    check(
      'digital_fulfilment_incidents_replacement_check',
      sql`(${t.state} = 'replacement_issued') = (${t.replacementArtifactId} is not null)`,
    ),
    check(
      'digital_fulfilment_incidents_resolved_check',
      sql`(${t.state} in ('open', 'supplier_escalated')) = (${t.resolvedAt} is null)`,
    ),
    index('digital_fulfilment_incidents_fulfilment_idx').on(t.fulfilmentId, t.reportedAt),
    // The support queue: what is still open, oldest first.
    index('digital_fulfilment_incidents_open_idx')
      .on(t.reportedAt)
      .where(sql`${t.state} in ('open', 'supplier_escalated')`),
  ],
);
