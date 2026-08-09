/**
 * The retail eligibility domain (#121, ADR 0004 D2.8–D2.10, D12.3–D12.4):
 * `retail_eligibility_policies`, `retail_category_rules`,
 * `retail_market_capabilities`, `retail_resale_evidence`,
 * `retail_compliance_evidence`, `retail_suppressions`,
 * `retail_eligibility_exceptions`, `retail_eligibility_decisions`,
 * `retail_eligibility_audits`.
 *
 * Mercaria is the SELLER on a `mercaria_retail` order. These nine tables hold
 * the evidence that it MAY be — that it can resell that exact product through
 * that supplier into that market, and can meet the safety, consumer, tax and
 * operational obligations that come with being the seller.
 *
 * ## The boundaries this file exists to hold
 *
 * **An affiliate feed cannot be stored as resale authority.**
 * `retail_resale_evidence.kind` CHECKs against
 * `RETAIL_RESALE_EVIDENCE_KINDS`, and `RETAIL_FORBIDDEN_EVIDENCE_KINDS` is a
 * DISJOINT union with no representation in any column here. So #121 acceptance
 * 1 is not a validator that says no — there is no row shape in which an
 * affiliate feed, a public page, an API key or a placed consumer order is
 * resale evidence. The `RetailForbiddenComponentKind` device (#120), one domain
 * over.
 *
 * **Expiry is derived, so it needs no sweep.** Every evidence table stores the
 * REVIEWER's verdict (`RETAIL_EVIDENCE_REVIEW_STATES`, five values) and a
 * nullable `expires_at`; `expired` is not a storable state. A certificate that
 * ran out overnight removes eligibility in the next derivation, with nothing
 * having run — #121 acceptance 2, held the way `deriveNativeCheckoutEligibility`
 * (#57) holds its own.
 *
 * **The verdict is DERIVED and `retail_eligibility_decisions` is a
 * RECORDING.** No code path reads a stored decision as an eligibility answer
 * (`services/retail-eligibility/eligibility.ts` does not import the repository,
 * and a test fails the build if that changes). The rows exist for the operator
 * trace, the "re-evaluate what changed" sweep and the eligible-catalogue
 * measurement — the same relationship `payment_discrepancies` has to a payment.
 *
 * **A decision cites its policy version by a NOT NULL COMPOSITE foreign key.**
 * `retail_eligibility_decisions.(policy_id, policy_key, policy_version)`
 * references `retail_eligibility_policies.(id, policy_key, version)`, so a
 * decision whose snapshot names a different version than its policy row is
 * refused by Postgres rather than by a comparison somebody has to remember —
 * the `match_category_gates` device (#58), applied to reproducibility (#121
 * acceptance 7).
 *
 * **Empty scope arrays on a POLICY mean NONE; on EVIDENCE they mean
 * UNRESTRICTED.** The two semantics are deliberate and are the pair
 * `CONVENTIONS.md` already documents: a policy (like a `supplier_agreements`
 * grant) permits what it names and nothing else, while a piece of evidence
 * (like `commerce_relationships.territories`) is a positive fact being scoped
 * DOWN — an unscoped brand authorization covers whatever its agreement covers,
 * which is already bounded.
 *
 * ## What is deliberately absent
 *
 * - **No `eligible` column anywhere.** The verdict is a conjunction over
 *   supplier, agreement, offer, evidence, category, market and suppression rows
 *   spread across three domains; storing it would be the `onboarding_state`
 *   one-verdict rule applied where its precondition (the inputs sit on the row
 *   being verdicted) does not hold — exactly the divergence #57 records.
 * - **No bypass, no default-verdict and no "treat unknown as eligible"
 *   lever.** Every policy column widens or narrows what is PERMITTED, and all
 *   of them start closed.
 * - **No `orders` widening.** `commercial_role` / `seller_type = 'platform'`
 *   land with the code that writes them (#123), the reasoning `procurement.ts`
 *   and `retailPricing.ts` both record.
 * - **No product-traceability TABLE.** Country of origin, manufacturer identity
 *   and the responsible economic operator are #56 attribute facts and #94
 *   registry values; duplicating them here would create a second answer to a
 *   question the canonical graph already owns. This domain REQUIRES them
 *   (`require_country_of_origin`, `require_responsible_operator`) and reads
 *   them through the narrow port `services/retail-eligibility/traceability.port.ts`.
 *
 * ## Hand-written triggers ride the same migration
 *
 * drizzle-kit does not model triggers, so three enforcement functions are added
 * by hand to this domain's migration (the ledger/fee/retail-pricing precedent):
 * a policy version freezes every scope column once it leaves `draft`; decisions
 * and audits refuse UPDATE and DELETE from birth; and an exception refuses every
 * update except the narrow lifecycle transitions its own CHECKs already bound.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  RETAIL_CATEGORY_ADMISSIBILITIES,
  RETAIL_COMPLIANCE_EVIDENCE_KINDS,
  RETAIL_CROSS_BORDER_RESPONSIBILITIES,
  RETAIL_CUSTOMER_TYPES,
  RETAIL_ELIGIBILITY_ACTIONS,
  RETAIL_ELIGIBILITY_AUDIT_ACTIONS,
  RETAIL_ELIGIBILITY_POLICY_STATUSES,
  RETAIL_ELIGIBILITY_REASONS,
  RETAIL_ELIGIBILITY_VERDICTS,
  RETAIL_EVIDENCE_REVIEW_STATES,
  RETAIL_EXCEPTION_STORED_STATES,
  RETAIL_FULFILMENT_METHODS,
  RETAIL_PRICE_FINALITIES,
  RETAIL_RESALE_EVIDENCE_KINDS,
  RETAIL_SUPPRESSION_KINDS,
  RETAIL_SUPPRESSION_SCOPES,
  RETAIL_SUPPRESSION_SEVERITIES,
  RETAIL_SUPPRESSION_SOURCES,
  RETAIL_VAT_TREATMENTS,
  RETAIL_WAIVABLE_REASONS,
  AGREEMENT_CHANNELS,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
  optionalMoney,
} from './columns';
import { supplierAccounts, supplierAgreements, suppliers } from './procurement';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { brands } from './organizations';

/** Bound on any stored note, reason or reference — the `.slice()` at every writer. */
const MAX_NOTE_LENGTH = 2_000;

/**
 * `retail_eligibility_policies` — one immutable VERSION of the eligibility
 * policy (#121 dimension 12, acceptance 7).
 *
 * ## Every scope column starts CLOSED
 *
 * `permitted_destination_countries`, `permitted_channels`,
 * `permitted_currencies`, `permitted_fulfilment_methods`,
 * `permitted_customer_types` and `permitted_fulfilment_origin_countries` all
 * default to `'{}'`, which means NONE — the `supplier_agreements` grant
 * semantics, deliberately the opposite of `commerce_relationships.territories`.
 * A freshly drafted policy therefore permits nothing at all, and every widening
 * is a deliberate, audited act on a NEW version.
 *
 * ## The version is immutable once it leaves `draft`
 *
 * The `fee_schedules` mechanism, twice: a partial unique index holds at most
 * ONE active version per key, and a trigger in this domain's migration refuses
 * every column edit once the status is not `draft`. A policy change is a new
 * version, which is what makes "reproducible from versioned policy and
 * evidence" (#121 acceptance 7) true of a decision recorded months ago.
 *
 * ## `minimum_match_confidence` is where #58 meets this gate
 *
 * A procurement offer's canonical mapping carries `confidence` (NULL for a
 * deterministic or human mapping, 0–1 for a machine one). Below this floor the
 * mapping is AMBIGUOUS, which is `ineligible` and routes to #59 — #121's
 * "ambiguous product matches route to #59 and remain ineligible", answered from
 * data this domain can actually see rather than from a flag somebody sets.
 */
export const retailEligibilityPolicies = pgTable(
  'retail_eligibility_policies',
  {
    id: generatedId(),
    /** The stable logical id shared by every version (`mercaria-retail-eligibility`). */
    policyKey: text().notNull(),
    /** Monotonic per key, assigned by the operator creating the draft. */
    version: integer().notNull(),
    name: text().notNull(),
    /** The operator-facing statement of what this version permits and why. */
    summary: text().notNull(),
    status: text({ enum: asEnumValues(RETAIL_ELIGIBILITY_POLICY_STATUSES) })
      .notNull()
      .default('draft'),
    /** The version applies only inside `[effective_start, effective_end)`. */
    effectiveStart: timestamptz().notNull(),
    effectiveEnd: timestamptz(),
    /** ISO-3166-1 alpha-2 customer destinations. Empty = NONE. */
    permittedDestinationCountries: text().array().notNull().default([]),
    /**
     * Where goods may ship FROM. ADR 0004 D2.9 makes this the EU customs
     * territory at launch: a supplier shipping from outside it is ineligible,
     * and that is data on a policy version rather than a constant in code.
     */
    permittedFulfilmentOriginCountries: text().array().notNull().default([]),
    /** Which Mercaria channels. Empty = NONE. */
    permittedChannels: text().array().notNull().default([]),
    /** Which presentment currencies. Empty = NONE. */
    permittedCurrencies: text().array().notNull().default([]),
    /** Which delivery methods. Empty = NONE. */
    permittedFulfilmentMethods: text().array().notNull().default([]),
    /** Consumer, business, or both. Empty = NONE. */
    permittedCustomerTypes: text().array().notNull().default([]),
    /**
     * The resale-evidence kinds a supplier must hold VERIFIED and in scope
     * before any of its offers is eligible. Containment-CHECKed against the
     * allowed tuple, so a forbidden kind cannot be required into existence.
     */
    requiredResaleEvidenceKinds: text().array().notNull().default([]),
    /**
     * The #56 identifier schemes a product must carry (`gtin`, `mpn`, …). Empty
     * = none required, which is a real launch answer for a category whose
     * products have no standard identifier.
     */
    requiredIdentifierSchemes: text().array().notNull().default([]),
    requireCountryOfOrigin: boolean().notNull().default(true),
    requireResponsibleOperator: boolean().notNull().default(true),
    /** When true, ANY confidence-carrying mapping is ambiguous, whatever its score. */
    requireDeterministicProductMatch: boolean().notNull().default(false),
    /** Below this a machine-matched mapping is ambiguous. `[0, 1]` by CHECK. */
    minimumMatchConfidence: doublePrecision().notNull().default(0.95),
    maxQuantityPerOrder: integer().notNull().default(10),
    /** The order-value ceiling. All four columns present or absent. */
    ...optionalMoney('maxOrderValue'),
    /** Whether ANY manual exception may be recorded under this version (#121 ops 4). */
    manualExceptionsPermitted: boolean().notNull().default(false),
    /** Whether an exception needs two DISTINCT approvers. Default ON. */
    exceptionDualApprovalRequired: boolean().notNull().default(true),
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
      'retail_eligibility_policies_status_check',
      t.status,
      RETAIL_ELIGIBILITY_POLICY_STATUSES,
    ),
    checkEveryElementOf(
      'retail_eligibility_policies_channels_check',
      t.permittedChannels,
      AGREEMENT_CHANNELS,
    ),
    checkEveryElementOf(
      'retail_eligibility_policies_currencies_check',
      t.permittedCurrencies,
      CURRENCY_CODE_VALUES,
    ),
    checkEveryElementOf(
      'retail_eligibility_policies_methods_check',
      t.permittedFulfilmentMethods,
      RETAIL_FULFILMENT_METHODS,
    ),
    checkEveryElementOf(
      'retail_eligibility_policies_customer_types_check',
      t.permittedCustomerTypes,
      RETAIL_CUSTOMER_TYPES,
    ),
    // THE structural half of acceptance 1: what a policy may REQUIRE is drawn
    // from the allowed kinds, and the forbidden union has no representation.
    checkEveryElementOf(
      'retail_eligibility_policies_resale_kinds_check',
      t.requiredResaleEvidenceKinds,
      RETAIL_RESALE_EVIDENCE_KINDS,
    ),
    ...currencyChecks('retail_eligibility_policies', [t.maxOrderValueCurrency]),
    check('retail_eligibility_policies_version_check', sql`${t.version} >= 1`),
    check(
      'retail_eligibility_policies_key_check',
      sql`${t.policyKey} ~ '^[a-z0-9][a-z0-9-]{1,63}$'`,
    ),
    check(
      'retail_eligibility_policies_countries_check',
      sql`not ('' = any(${t.permittedDestinationCountries}))
          and not ('' = any(${t.permittedFulfilmentOriginCountries}))`,
    ),
    check(
      'retail_eligibility_policies_identifier_schemes_check',
      sql`not ('' = any(${t.requiredIdentifierSchemes}))`,
    ),
    check(
      'retail_eligibility_policies_match_confidence_check',
      sql`${t.minimumMatchConfidence} >= 0 and ${t.minimumMatchConfidence} <= 1`,
    ),
    check('retail_eligibility_policies_quantity_check', sql`${t.maxQuantityPerOrder} >= 1`),
    // The order-value ceiling is complete or absent — and when present, this
    // version permits exactly ONE currency, which is what makes the ceiling
    // comparable at all. This domain does no FX (a test asserts it), so a
    // ceiling in a currency the order is not denominated in is a cap that does
    // not exist; the constraint makes that configuration unstorable rather than
    // leaving the derivation to fail open or invent a conversion.
    check(
      'retail_eligibility_policies_max_order_value_check',
      sql`num_nonnulls(${t.maxOrderValueAmount}, ${t.maxOrderValueCurrency}) in (0, 2)
          and (${t.maxOrderValueAmount} is null or ${t.maxOrderValueAmount} > 0)
          and (${t.maxOrderValueCurrency} is null
               or ${t.permittedCurrencies} <@ array[${t.maxOrderValueCurrency}])`,
    ),
    check(
      'retail_eligibility_policies_effective_window_check',
      sql`${t.effectiveEnd} is null or ${t.effectiveEnd} > ${t.effectiveStart}`,
    ),
    // Dual approval may only be waived where exceptions exist at all — a
    // version that permits none must not carry a live "one approver is enough".
    check(
      'retail_eligibility_policies_exception_shape_check',
      sql`${t.manualExceptionsPermitted} or ${t.exceptionDualApprovalRequired}`,
    ),
    // Nothing published is anonymous — the `fee_schedules` activation audit.
    check(
      'retail_eligibility_policies_activation_audit_check',
      sql`${t.status} not in ('active', 'superseded')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    uniqueIndex('retail_eligibility_policies_key_version_key').on(t.policyKey, t.version),
    // The structural half of "active versions are immutable; publish a new one".
    uniqueIndex('retail_eligibility_policies_one_active_per_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'active'`),
    /**
     * The composite key a decision cites through. A table CONSTRAINT rather
     * than a unique INDEX, for the reason `match_benchmark_runs` records: a
     * composite foreign key needs its referenced columns unique when the
     * constraint is added, and drizzle-kit emits table constraints with the
     * CREATE TABLE while it emits indexes afterwards.
     */
    unique('retail_eligibility_policies_identity_key').on(t.id, t.policyKey, t.version),
  ],
);

/**
 * `retail_category_rules` — what one policy version says about one category
 * (#121 "Prohibited and restricted products", ADR 0004 D12.3).
 *
 * ## Absence is the fail-closed default, and it is not a row
 *
 * There is no rule for a category until somebody writes one, and
 * `resolveCategoryRule` answers "unevaluated" for an absent row — which is
 * `unknown`, which blocks. ADR 0004 D12.3's "an unevaluated category is
 * ineligible by default" is therefore true in EFFECT (nothing publishes,
 * nothing checks out) while being reported honestly, so it lands in the review
 * queue (#121 operations 2) rather than reading as a refusal somebody decided.
 *
 * ## `required_compliance_evidence_kinds` is the category-aware registry
 *
 * #121's "Safety and regulatory evidence" is not a fixed list — a toy, a
 * cosmetic and a radio transmitter owe different documents. The requirement is
 * therefore DATA on this row, containment-CHECKed against
 * `RETAIL_COMPLIANCE_EVIDENCE_KINDS`, and the derivation demands a VERIFIED,
 * in-market, unexpired row of each named kind.
 */
export const retailCategoryRules = pgTable(
  'retail_category_rules',
  {
    id: generatedId(),
    policyId: text()
      .notNull()
      .references(() => retailEligibilityPolicies.id, { onDelete: 'restrict' }),
    /**
     * The category this rule covers. A category SLUG rather than a
     * `categories.id`, the `match_category_gates` decision: a policy is written
     * against a taxonomy position and must stay readable after a category row
     * is renamed or merged.
     */
    categoryKey: text().notNull(),
    admissibility: text({ enum: asEnumValues(RETAIL_CATEGORY_ADMISSIBILITIES) }).notNull(),
    /** The compliance documents this category requires, per market. */
    requiredComplianceEvidenceKinds: text().array().notNull().default([]),
    /** Whether selling this needs an approved age-assurance flow Mercaria does not have. */
    requiresAgeAssurance: boolean().notNull().default(false),
    /** Whether the category carries dangerous-goods shipping restrictions. */
    dangerousGoodsRestricted: boolean().notNull().default(false),
    /** Whether an authorized-dealer status Mercaria may not hold is required. */
    requiresAuthorizedDealer: boolean().notNull().default(false),
    /**
     * Whether a batch, lot or serial has to be trackable through fulfilment
     * (#121 "Product identity and traceability" 8). Answered by the #56/#94
     * traceability port, which reports NO DATA until #122 registers a provider
     * — so a category that requires it is ineligible until the facts exist.
     */
    requiresBatchTraceability: boolean().notNull().default(false),
    /** Why this rule reads the way it does — mandatory, and read by an operator. */
    reason: text().notNull(),
    /** An Oxy account id — no foreign key. */
    recordedByOxyUserId: text().notNull(),
    recordedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'retail_category_rules_admissibility_check',
      t.admissibility,
      RETAIL_CATEGORY_ADMISSIBILITIES,
    ),
    checkEveryElementOf(
      'retail_category_rules_evidence_kinds_check',
      t.requiredComplianceEvidenceKinds,
      RETAIL_COMPLIANCE_EVIDENCE_KINDS,
    ),
    check('retail_category_rules_category_check', sql`btrim(${t.categoryKey}) <> ''`),
    check(
      'retail_category_rules_reason_check',
      sql`btrim(${t.reason}) <> '' and length(${t.reason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check('retail_category_rules_actor_check', sql`btrim(${t.recordedByOxyUserId}) <> ''`),
    // A prohibited category cannot also carry requirements to satisfy: the two
    // readings ("never" and "once you have the documents") are different
    // answers, and a row asserting both would let a reader pick.
    check(
      'retail_category_rules_prohibited_shape_check',
      sql`${t.admissibility} <> 'prohibited'
          or (cardinality(${t.requiredComplianceEvidenceKinds}) = 0
              and not ${t.requiresAgeAssurance}
              and not ${t.requiresAuthorizedDealer}
              and not ${t.requiresBatchTraceability})`,
    ),
    /** ONE rule per (policy version, category). A change is a new policy version. */
    uniqueIndex('retail_category_rules_policy_category_key').on(t.policyId, t.categoryKey),
    index('retail_category_rules_category_idx').on(t.categoryKey),
  ],
);

/**
 * `retail_market_capabilities` — whether Mercaria can actually OPERATE one
 * route (#121 "Consumer and commercial capability" and "Tax and cross-border
 * gate", both of which are properties of the same route).
 *
 * ## One row per (policy version, destination, fulfilment origin)
 *
 * Both sections of the issue ask questions whose answer depends on where the
 * goods come from AND where they go — VAT treatment, importer of record, duty
 * responsibility, whether a return can physically be accepted. One table with
 * two column groups, because splitting them would make two rows that must agree
 * about the same route.
 *
 * ## An absent row is `unknown`, and every boolean defaults to FALSE
 *
 * "A technically orderable SKU remains ineligible if Mercaria cannot support
 * the customer's rights" is the whole point, so the columns are opt-IN: a row
 * recorded with nothing set supports nothing, and the derivation names each
 * capability it found missing. `not_determined` / `undetermined` on the tax
 * columns is the RECORDED finding that somebody looked and could not conclude —
 * a different fact from having no row, and both block.
 */
export const retailMarketCapabilities = pgTable(
  'retail_market_capabilities',
  {
    id: generatedId(),
    policyId: text()
      .notNull()
      .references(() => retailEligibilityPolicies.id, { onDelete: 'restrict' }),
    /** ISO-3166-1 alpha-2 customer destination. */
    destinationCountry: text().notNull(),
    /** ISO-3166-1 alpha-2 fulfilment origin. */
    fulfilmentOriginCountry: text().notNull(),
    /** Which customer type this determination covers — the rights differ. */
    customerType: text({ enum: asEnumValues(RETAIL_CUSTOMER_TYPES) }).notNull(),

    // Consumer and commercial capability (#121 items 1–12).
    cancellationBeforeFulfilmentSupported: boolean().notNull().default(false),
    statutoryWithdrawalSupported: boolean().notNull().default(false),
    legalGuaranteeSupported: boolean().notNull().default(false),
    returnsSupported: boolean().notNull().default(false),
    defectHandlingSupported: boolean().notNull().default(false),
    refundThroughOriginalRailSupported: boolean().notNull().default(false),
    invoiceIssuanceSupported: boolean().notNull().default(false),
    recallNotificationSupported: boolean().notNull().default(false),
    deliveryEstimateAvailable: boolean().notNull().default(false),
    /** BCP-47 language tags Mercaria can support customers in on this route. */
    supportLanguages: text().array().notNull().default([]),

    // Tax and cross-border gate (#121 items 1–10).
    vatTreatment: text({ enum: asEnumValues(RETAIL_VAT_TREATMENTS) })
      .notNull()
      .default('not_determined'),
    /** Whether Mercaria holds the registration this route's treatment requires. */
    sellerRegistrationRecorded: boolean().notNull().default(false),
    /** The registration reference — an operator-visible pointer, never a credential. */
    sellerRegistrationRef: text(),
    ossRelevant: boolean().notNull().default(false),
    iossRelevant: boolean().notNull().default(false),
    importerOfRecord: text({ enum: asEnumValues(RETAIL_CROSS_BORDER_RESPONSIBILITIES) })
      .notNull()
      .default('undetermined'),
    dutyResponsibility: text({ enum: asEnumValues(RETAIL_CROSS_BORDER_RESPONSIBILITIES) })
      .notNull()
      .default('undetermined'),
    priceFinality: text({ enum: asEnumValues(RETAIL_PRICE_FINALITIES) })
      .notNull()
      .default('undetermined'),
    /** The value above which a different treatment applies. NULL = no threshold. */
    orderValueThresholdMinor: bigint({ mode: 'number' }),
    orderValueThresholdCurrency: text({ enum: CURRENCY_CODE_VALUES }),
    supplierInvoiceTaxNote: text(),
    customerInvoiceNote: text(),

    /** Why this determination reads the way it does — mandatory. */
    reason: text().notNull(),
    /** An Oxy account id — no foreign key. */
    recordedByOxyUserId: text().notNull(),
    recordedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_market_capabilities_customer_type_check', t.customerType, RETAIL_CUSTOMER_TYPES),
    checkOneOf('retail_market_capabilities_vat_check', t.vatTreatment, RETAIL_VAT_TREATMENTS),
    checkOneOf(
      'retail_market_capabilities_importer_check',
      t.importerOfRecord,
      RETAIL_CROSS_BORDER_RESPONSIBILITIES,
    ),
    checkOneOf(
      'retail_market_capabilities_duty_check',
      t.dutyResponsibility,
      RETAIL_CROSS_BORDER_RESPONSIBILITIES,
    ),
    checkOneOf(
      'retail_market_capabilities_price_finality_check',
      t.priceFinality,
      RETAIL_PRICE_FINALITIES,
    ),
    ...currencyChecks('retail_market_capabilities', [t.orderValueThresholdCurrency]),
    check(
      'retail_market_capabilities_countries_check',
      sql`${t.destinationCountry} ~ '^[A-Z]{2}$' and ${t.fulfilmentOriginCountry} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'retail_market_capabilities_languages_check',
      sql`not ('' = any(${t.supportLanguages}))`,
    ),
    check(
      'retail_market_capabilities_threshold_check',
      sql`num_nonnulls(${t.orderValueThresholdMinor}, ${t.orderValueThresholdCurrency}) in (0, 2)
          and (${t.orderValueThresholdMinor} is null or ${t.orderValueThresholdMinor} > 0)`,
    ),
    // A determined treatment names the registration it runs under. Claiming OSS
    // without a recorded registration is a claim about somebody else's paperwork.
    check(
      'retail_market_capabilities_registration_check',
      sql`not ${t.sellerRegistrationRecorded} or btrim(coalesce(${t.sellerRegistrationRef}, '')) <> ''`,
    ),
    // A price cannot be claimed FINAL while the duty or import question is open:
    // "no additional fees" is exactly the sentence that would be false.
    check(
      'retail_market_capabilities_price_finality_shape_check',
      sql`${t.priceFinality} <> 'final'
          or (${t.dutyResponsibility} <> 'undetermined'
              and ${t.importerOfRecord} <> 'undetermined'
              and ${t.vatTreatment} <> 'not_determined')`,
    ),
    check(
      'retail_market_capabilities_reason_check',
      sql`btrim(${t.reason}) <> '' and length(${t.reason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check('retail_market_capabilities_actor_check', sql`btrim(${t.recordedByOxyUserId}) <> ''`),
    /** ONE determination per (policy version, route, customer type). */
    uniqueIndex('retail_market_capabilities_route_key').on(
      t.policyId,
      t.destinationCountry,
      t.fulfilmentOriginCountry,
      t.customerType,
    ),
    index('retail_market_capabilities_destination_idx').on(t.destinationCountry),
  ],
);

/**
 * `retail_resale_evidence` — one document or grant supporting a right to resell
 * (#121 "Resale authorization" 1–10, ADR 0004 D2.10).
 *
 * ## `kind` is where acceptance 1 becomes structural
 *
 * The CHECK reads `RETAIL_RESALE_EVIDENCE_KINDS`, and
 * `RETAIL_FORBIDDEN_EVIDENCE_KINDS` is a disjoint union with no representation
 * in this table. An affiliate feed, a public product page, an API key or a
 * placed consumer order cannot be STORED here — so "never sufficient evidence"
 * is not a rule the derivation applies, it is a row that cannot exist.
 *
 * ## The scope arrays scope DOWN, and empty means unrestricted
 *
 * The opposite of `retail_eligibility_policies` above and of
 * `supplier_agreements`, and deliberately: a policy and an agreement GRANT, so
 * naming nothing grants nothing, while a piece of evidence is a positive fact
 * about something already bounded by the agreement it sits under. A brand
 * authorization with no `scope_brand_keys` covers whatever its agreement covers;
 * one that names two brands covers those two.
 *
 * ## Reviewer columns, and no `expired` state
 *
 * `review_state` is what a REVIEWER decided (five values). `expires_at` is the
 * deadline, and `expired` is derived against the clock in
 * `services/retail-eligibility/evidence-state.ts` — so a document that ran out
 * overnight stops authorizing anything with no sweep having run.
 */
export const retailResaleEvidence = pgTable(
  'retail_resale_evidence',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** The agreement VERSION this evidence was collected under, when one governs it. */
    agreementId: text().references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    /** The specific platform account, when the grant is account-scoped. */
    supplierAccountId: text().references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(RETAIL_RESALE_EVIDENCE_KINDS) }).notNull(),
    reviewState: text({ enum: asEnumValues(RETAIL_EVIDENCE_REVIEW_STATES) })
      .notNull()
      .default('unknown'),
    /** Scope-DOWN arrays. Empty = the whole of what the agreement already covers. */
    scopeBrandKeys: text().array().notNull().default([]),
    scopeCategoryKeys: text().array().notNull().default([]),
    scopeSupplierSkus: text().array().notNull().default([]),
    /** ISO-3166-1 alpha-2 destinations this grant covers. Empty = unrestricted. */
    scopeDestinationCountries: text().array().notNull().default([]),
    /** When the counterparty issued it. */
    issuedAt: timestamptz(),
    /** The deadline. NULL = no expiry. `expired` is DERIVED against the clock. */
    expiresAt: timestamptz(),
    /** An Oxy media file id — Oxy owns the file, no foreign key. */
    oxyFileId: text(),
    /** Where the document lives, when it is not an Oxy file. */
    documentUrl: text(),
    /** Content hash, so the claim survives the document moving or changing. */
    sha256: text(),
    /** Who provided it — a counterparty name, a register, an operator. */
    issuer: text(),
    note: text(),
    /** An Oxy account id — no foreign key. */
    recordedByOxyUserId: text().notNull(),
    recordedAt: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. Set exactly when `review_state = 'verified'`. */
    verifiedByOxyUserId: text(),
    verifiedAt: timestamptz(),
    rejectionReason: text(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokedAt: timestamptz(),
    revocationReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_resale_evidence_kind_check', t.kind, RETAIL_RESALE_EVIDENCE_KINDS),
    checkOneOf(
      'retail_resale_evidence_review_state_check',
      t.reviewState,
      RETAIL_EVIDENCE_REVIEW_STATES,
    ),
    check(
      'retail_resale_evidence_scope_check',
      sql`not ('' = any(${t.scopeBrandKeys}))
          and not ('' = any(${t.scopeCategoryKeys}))
          and not ('' = any(${t.scopeSupplierSkus}))
          and not ('' = any(${t.scopeDestinationCountries}))`,
    ),
    // Evidence points at SOMETHING durable — the `supplier_agreement_evidence`
    // rule. A verified grant that references no document is a memory.
    check(
      'retail_resale_evidence_target_check',
      sql`num_nonnulls(${t.oxyFileId}, ${t.documentUrl}) >= 1`,
    ),
    check(
      'retail_resale_evidence_sha256_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'retail_resale_evidence_window_check',
      sql`${t.issuedAt} is null or ${t.expiresAt} is null or ${t.expiresAt} > ${t.issuedAt}`,
    ),
    check('retail_resale_evidence_actor_check', sql`btrim(${t.recordedByOxyUserId}) <> ''`),
    // A verification is a decision WITH its record: who, and when. Anything less
    // is not `verified` — the `supplier_agreements` approval rule.
    check(
      'retail_resale_evidence_verified_complete_check',
      sql`(${t.reviewState} = 'verified')
          = (${t.verifiedByOxyUserId} is not null and ${t.verifiedAt} is not null)`,
    ),
    // A rejection states why, and only a rejection carries one.
    check(
      'retail_resale_evidence_rejected_check',
      sql`(${t.reviewState} = 'rejected') = (btrim(coalesce(${t.rejectionReason}, '')) <> '')`,
    ),
    // A revocation is attributable, dated and explained, or it did not happen.
    check(
      'retail_resale_evidence_revoked_check',
      sql`(${t.reviewState} = 'revoked')
          = (${t.revokedByOxyUserId} is not null and ${t.revokedAt} is not null
             and btrim(coalesce(${t.revocationReason}, '')) <> '')`,
    ),
    check(
      'retail_resale_evidence_note_length_check',
      sql`(${t.note} is null or length(${t.note}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})
          and (${t.rejectionReason} is null or length(${t.rejectionReason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})
          and (${t.revocationReason} is null or length(${t.revocationReason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})`,
    ),
    // "Which resale evidence does this supplier hold, of which kind" — the
    // derivation's own read, and the expiry dashboard's (#121 operations 1).
    index('retail_resale_evidence_supplier_idx').on(t.supplierId, t.kind, t.reviewState),
    index('retail_resale_evidence_agreement_idx')
      .on(t.agreementId)
      .where(sql`${t.agreementId} is not null`),
    index('retail_resale_evidence_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.reviewState} = 'verified' and ${t.expiresAt} is not null`),
  ],
);

/**
 * `retail_compliance_evidence` — one product-safety or regulatory document
 * (#121 "Safety and regulatory evidence" 1–10).
 *
 * A SEPARATE table from `retail_resale_evidence` rather than one table with a
 * discriminator, because the two scope on genuinely different things: resale
 * evidence scopes on brand, category, SKU and destination, compliance evidence
 * on a canonical product or variant and the MARKETS the document is valid in. A
 * merged table would carry both sets mostly-NULL and would let a compliance
 * certificate be cited as resale authority, which the disjoint tables make
 * impossible for free.
 *
 * ## `market_countries` is what "Do not infer compliance" means mechanically
 *
 * A declaration of conformity issued for one market is not evidence for
 * another, and a supplier's own category label is not evidence at all. So the
 * document names the markets it covers (empty = unrestricted, the scope-DOWN
 * semantics above), and the derivation demands a document whose markets include
 * the destination — reporting `compliance_evidence_market_mismatch` rather than
 * quietly accepting one issued elsewhere.
 */
export const retailComplianceEvidence = pgTable(
  'retail_compliance_evidence',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** The canonical product this document is about (#56). */
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** The exact variant, when the document is variant-specific. */
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    /** The supplier's own SKU, when the document names one. */
    supplierSku: text(),
    kind: text({ enum: asEnumValues(RETAIL_COMPLIANCE_EVIDENCE_KINDS) }).notNull(),
    reviewState: text({ enum: asEnumValues(RETAIL_EVIDENCE_REVIEW_STATES) })
      .notNull()
      .default('unknown'),
    /** ISO-3166-1 alpha-2 markets this document is valid for. Empty = unrestricted. */
    marketCountries: text().array().notNull().default([]),
    /** The document's own version or revision label, as the issuer prints it. */
    documentVersion: text(),
    /** Who issued it — a notified body, a manufacturer, a laboratory. */
    issuer: text(),
    issuedAt: timestamptz(),
    /** The deadline. NULL = no expiry. `expired` is DERIVED against the clock. */
    expiresAt: timestamptz(),
    /** An Oxy media file id — Oxy owns the file, no foreign key. */
    oxyFileId: text(),
    documentUrl: text(),
    sha256: text(),
    note: text(),
    /** An Oxy account id — no foreign key. */
    recordedByOxyUserId: text().notNull(),
    recordedAt: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. Set exactly when `review_state = 'verified'`. */
    verifiedByOxyUserId: text(),
    verifiedAt: timestamptz(),
    rejectionReason: text(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokedAt: timestamptz(),
    revocationReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_compliance_evidence_kind_check', t.kind, RETAIL_COMPLIANCE_EVIDENCE_KINDS),
    checkOneOf(
      'retail_compliance_evidence_review_state_check',
      t.reviewState,
      RETAIL_EVIDENCE_REVIEW_STATES,
    ),
    // A document about nothing identifiable cannot gate anything: it names a
    // canonical product, a canonical variant or a supplier SKU.
    check(
      'retail_compliance_evidence_subject_check',
      sql`num_nonnulls(${t.canonicalProductId}, ${t.canonicalVariantId}, ${t.supplierSku}) >= 1`,
    ),
    check(
      'retail_compliance_evidence_target_check',
      sql`num_nonnulls(${t.oxyFileId}, ${t.documentUrl}) >= 1`,
    ),
    check(
      'retail_compliance_evidence_markets_check',
      sql`not ('' = any(${t.marketCountries}))`,
    ),
    check(
      'retail_compliance_evidence_sha256_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'retail_compliance_evidence_window_check',
      sql`${t.issuedAt} is null or ${t.expiresAt} is null or ${t.expiresAt} > ${t.issuedAt}`,
    ),
    check('retail_compliance_evidence_actor_check', sql`btrim(${t.recordedByOxyUserId}) <> ''`),
    check(
      'retail_compliance_evidence_verified_complete_check',
      sql`(${t.reviewState} = 'verified')
          = (${t.verifiedByOxyUserId} is not null and ${t.verifiedAt} is not null)`,
    ),
    check(
      'retail_compliance_evidence_rejected_check',
      sql`(${t.reviewState} = 'rejected') = (btrim(coalesce(${t.rejectionReason}, '')) <> '')`,
    ),
    check(
      'retail_compliance_evidence_revoked_check',
      sql`(${t.reviewState} = 'revoked')
          = (${t.revokedByOxyUserId} is not null and ${t.revokedAt} is not null
             and btrim(coalesce(${t.revocationReason}, '')) <> '')`,
    ),
    check(
      'retail_compliance_evidence_note_length_check',
      sql`(${t.note} is null or length(${t.note}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})
          and (${t.rejectionReason} is null or length(${t.rejectionReason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})
          and (${t.revocationReason} is null or length(${t.revocationReason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))})`,
    ),
    index('retail_compliance_evidence_variant_idx')
      .on(t.canonicalVariantId, t.kind, t.reviewState)
      .where(sql`${t.canonicalVariantId} is not null`),
    index('retail_compliance_evidence_product_idx')
      .on(t.canonicalProductId, t.kind, t.reviewState)
      .where(sql`${t.canonicalProductId} is not null`),
    index('retail_compliance_evidence_supplier_sku_idx')
      .on(t.supplierId, t.supplierSku)
      .where(sql`${t.supplierSku} is not null`),
    index('retail_compliance_evidence_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.reviewState} = 'verified' and ${t.expiresAt} is not null`),
  ],
);

/**
 * `retail_suppressions` — the recall and emergency-control table (#121 "Recall
 * and emergency controls").
 *
 * ## The emergency path is an INSERT, and nothing else has to run
 *
 * Eligibility is derived, so a `stop_sale` row committed here stops new
 * publication and new checkout in the very next derivation — no queue, no
 * sweep, no cache to invalidate (#121 acceptance 5). That is the whole reason
 * the verdict is not a stored column, and it is what makes emergency
 * suppression testable INDEPENDENTLY of ordinary source refresh: the refresh
 * path is not involved at all.
 *
 * ## Severity, and the one combination that cannot exist
 *
 * `advisory` records without blocking, because a safety notice that is not a
 * stop-sale must not silently delist a catalogue. A `recall` may therefore
 * never be `advisory` — a CHECK refuses exactly the combination that would turn
 * "recorded a recall" into "changed nothing".
 *
 * ## Scope is a kind plus a reference, and the kind decides the key space
 *
 * Eight scopes over five different key spaces (Mercaria supplier ids, canonical
 * ids, a supplier's own SKU, a category slug, an ISO country). A polymorphic
 * `(scope, ref)` pair rather than eight nullable foreign keys: unlike
 * `match_decisions`' two-FK subject, these key spaces are not all Mercaria's,
 * and `market`/`category`/`supplier_sku` have no table to reference at all.
 * `scope_ref` is therefore plain text with per-scope SHAPE CHECKs, and the
 * supplier/brand/canonical scopes additionally carry their real foreign key so
 * the common cases stay constrained.
 */
export const retailSuppressions = pgTable(
  'retail_suppressions',
  {
    id: generatedId(),
    scope: text({ enum: asEnumValues(RETAIL_SUPPRESSION_SCOPES) }).notNull(),
    /** The scoped subject, in the key space `scope` names. */
    scopeRef: text().notNull(),
    /** The real reference for the scopes whose key space is Mercaria's own. */
    supplierId: text().references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text().references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    brandId: text().references(() => brands.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(RETAIL_SUPPRESSION_KINDS) }).notNull(),
    severity: text({ enum: asEnumValues(RETAIL_SUPPRESSION_SEVERITIES) }).notNull(),
    source: text({ enum: asEnumValues(RETAIL_SUPPRESSION_SOURCES) }).notNull(),
    /** The authority notice or supplier reference this came from. */
    externalReference: text(),
    /** Why — mandatory, bounded, and shown to an operator. */
    reason: text().notNull(),
    effectiveFrom: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. */
    raisedByOxyUserId: text().notNull(),
    liftedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    liftedByOxyUserId: text(),
    liftReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_suppressions_scope_check', t.scope, RETAIL_SUPPRESSION_SCOPES),
    checkOneOf('retail_suppressions_kind_check', t.kind, RETAIL_SUPPRESSION_KINDS),
    checkOneOf('retail_suppressions_severity_check', t.severity, RETAIL_SUPPRESSION_SEVERITIES),
    checkOneOf('retail_suppressions_source_check', t.source, RETAIL_SUPPRESSION_SOURCES),
    check('retail_suppressions_scope_ref_check', sql`btrim(${t.scopeRef}) <> ''`),
    // A market scope is an ISO country code; anything else in that column would
    // silently suppress nothing.
    check(
      'retail_suppressions_market_shape_check',
      sql`${t.scope} <> 'market' or ${t.scopeRef} ~ '^[A-Z]{2}$'`,
    ),
    // The scopes whose key space is Mercaria's own carry the real reference,
    // and it agrees with `scope_ref` — one subject, stated once.
    check(
      'retail_suppressions_reference_check',
      sql`(${t.scope} = 'supplier') = (${t.supplierId} is not null)
          and (${t.scope} = 'supplier_account') = (${t.supplierAccountId} is not null)
          and (${t.scope} = 'canonical_product') = (${t.canonicalProductId} is not null)
          and (${t.scope} = 'canonical_variant') = (${t.canonicalVariantId} is not null)
          and (${t.scope} = 'brand') = (${t.brandId} is not null)`,
    ),
    // …and it agrees with `scope_ref`, so one subject is stated once. Written as
    // five explicit implications rather than a `coalesce` chain: the chain is
    // shorter and reads as an accident, and this is the constraint that stops a
    // suppression naming one supplier by id and a different one by reference.
    check(
      'retail_suppressions_reference_agreement_check',
      sql`(${t.supplierId} is null or ${t.scopeRef} = ${t.supplierId})
          and (${t.supplierAccountId} is null or ${t.scopeRef} = ${t.supplierAccountId})
          and (${t.canonicalProductId} is null or ${t.scopeRef} = ${t.canonicalProductId})
          and (${t.canonicalVariantId} is null or ${t.scopeRef} = ${t.canonicalVariantId})
          and (${t.brandId} is null or ${t.scopeRef} = ${t.brandId})`,
    ),
    // THE combination that must not exist: a recall that changes nothing.
    check(
      'retail_suppressions_recall_severity_check',
      sql`${t.kind} <> 'recall' or ${t.severity} <> 'advisory'`,
    ),
    check(
      'retail_suppressions_reason_check',
      sql`btrim(${t.reason}) <> '' and length(${t.reason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check('retail_suppressions_actor_check', sql`btrim(${t.raisedByOxyUserId}) <> ''`),
    // A lift is attributable, dated and explained, or it did not happen — the
    // `match_category_gates` closure rule. Turning a recall off unaudited is
    // exactly the act that must leave a name behind.
    check(
      'retail_suppressions_lift_check',
      sql`${t.liftedAt} is null
          or (${t.liftedByOxyUserId} is not null and btrim(coalesce(${t.liftReason}, '')) <> '')`,
    ),
    /**
     * ONE live suppression per (scope, subject, kind). A repeat converges on the
     * existing row rather than stacking duplicates an operator would have to
     * lift one at a time — the moderation-claim shape, applied to an emergency
     * control.
     */
    uniqueIndex('retail_suppressions_live_key')
      .on(t.scope, t.scopeRef, t.kind)
      .where(sql`${t.liftedAt} is null`),
    // The derivation's own read: every live suppression touching a subject.
    index('retail_suppressions_active_idx')
      .on(t.scope, t.scopeRef)
      .where(sql`${t.liftedAt} is null`),
    index('retail_suppressions_raised_idx').on(t.createdAt),
  ],
);

/**
 * `retail_eligibility_exceptions` — a recorded, dual-approved waiver of a
 * NAMED, WAIVABLE reason (#121 operations 4).
 *
 * ## An exception is DATA the derivation reads, never a parameter a caller passes
 *
 * `getRetailEligibility` has no override argument. What can change a verdict is
 * a row here: requested by somebody, approved by two distinct operators, scoped,
 * expiring, and naming exactly which reasons it waives. That keeps every
 * override inside the same audit trail as everything else, and it means a
 * client cannot construct one.
 *
 * ## Only `RETAIL_WAIVABLE_REASONS` can be waived, and the CHECK says so
 *
 * `waived_reasons` is containment-CHECKed against the waivable tuple, which is
 * disjoint from `RETAIL_UNWAIVABLE_REASONS` by a test. So no exception — however
 * many operators approve it — can waive a recall, a suppression, a prohibited
 * category, an ambiguous product match, missing or expired resale or compliance
 * evidence, an unresolved tax treatment or a missing refund rail. Those are the
 * refusals a person under pressure would most want to wave through, which is
 * precisely why the database refuses to store the waiver.
 *
 * ## Four eyes is a partial unique index, not a comparison
 *
 * `approved_by_oxy_user_id` and `second_approved_by_oxy_user_id` must differ by
 * CHECK, and the policy version decides whether the second is required — the
 * `relationship_reviews` device: the property is held by the shape of the row
 * rather than by a service remembering to compare two ids.
 */
export const retailEligibilityExceptions = pgTable(
  'retail_eligibility_exceptions',
  {
    id: generatedId(),
    policyId: text()
      .notNull()
      .references(() => retailEligibilityPolicies.id, { onDelete: 'restrict' }),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** The canonical variant this waiver covers. NULL = every variant of the supplier. */
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    /** ISO-3166-1 alpha-2 destinations. Empty = unrestricted within the policy. */
    scopeDestinationCountries: text().array().notNull().default([]),
    /** Exactly which reasons this waives. Containment-CHECKed to the waivable set. */
    waivedReasons: text().array().notNull(),
    state: text({ enum: asEnumValues(RETAIL_EXCEPTION_STORED_STATES) })
      .notNull()
      .default('requested'),
    /** Why this waiver is justified — mandatory, and read by both approvers. */
    justification: text().notNull(),
    /** An Oxy account id — no foreign key. */
    requestedByOxyUserId: text().notNull(),
    requestedAt: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. */
    approvedByOxyUserId: text(),
    approvedAt: timestamptz(),
    /** The SECOND approver — a DIFFERENT person, by CHECK. */
    secondApprovedByOxyUserId: text(),
    secondApprovedAt: timestamptz(),
    /** The deadline. NULL is unrepresentable: a waiver without an end is a policy change. */
    expiresAt: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. */
    rejectedByOxyUserId: text(),
    rejectedAt: timestamptz(),
    rejectionReason: text(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokedAt: timestamptz(),
    revocationReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_eligibility_exceptions_state_check', t.state, RETAIL_EXCEPTION_STORED_STATES),
    // The structural half of "no exception waives a recall": the unwaivable
    // reasons have no representation in this column at all.
    // Rendered from the waivable tuple in shared-types, so the CHECK, the
    // service and the disjointness test all read ONE source.
    checkEveryElementOf(
      'retail_eligibility_exceptions_waived_reasons_check',
      t.waivedReasons,
      RETAIL_WAIVABLE_REASONS,
    ),
    check(
      'retail_eligibility_exceptions_waived_nonempty_check',
      sql`cardinality(${t.waivedReasons}) >= 1`,
    ),
    check(
      'retail_eligibility_exceptions_scope_check',
      sql`not ('' = any(${t.scopeDestinationCountries}))`,
    ),
    check(
      'retail_eligibility_exceptions_justification_check',
      sql`btrim(${t.justification}) <> ''
          and length(${t.justification}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check(
      'retail_eligibility_exceptions_requested_by_check',
      sql`btrim(${t.requestedByOxyUserId}) <> ''`,
    ),
    check(
      'retail_eligibility_exceptions_expiry_check',
      sql`${t.expiresAt} > ${t.requestedAt}`,
    ),
    // An approval is a decision WITH its record, and an approved exception has
    // at least the first one.
    check(
      'retail_eligibility_exceptions_approved_complete_check',
      sql`num_nonnulls(${t.approvedByOxyUserId}, ${t.approvedAt}) in (0, 2)
          and num_nonnulls(${t.secondApprovedByOxyUserId}, ${t.secondApprovedAt}) in (0, 2)
          and (${t.state} <> 'approved' or ${t.approvedByOxyUserId} is not null)`,
    ),
    // FOUR EYES: two approvers, two DIFFERENT people, and the requester is not
    // one of them. A waiver somebody granted themselves is not an exception.
    check(
      'retail_eligibility_exceptions_four_eyes_check',
      sql`(${t.secondApprovedByOxyUserId} is null
           or ${t.secondApprovedByOxyUserId} <> ${t.approvedByOxyUserId})
          and (${t.approvedByOxyUserId} is null
               or ${t.approvedByOxyUserId} <> ${t.requestedByOxyUserId})
          and (${t.secondApprovedByOxyUserId} is null
               or ${t.secondApprovedByOxyUserId} <> ${t.requestedByOxyUserId})`,
    ),
    // A second approval only follows a first.
    check(
      'retail_eligibility_exceptions_approval_order_check',
      sql`${t.secondApprovedByOxyUserId} is null or ${t.approvedByOxyUserId} is not null`,
    ),
    check(
      'retail_eligibility_exceptions_rejected_check',
      sql`(${t.state} = 'rejected')
          = (${t.rejectedByOxyUserId} is not null and ${t.rejectedAt} is not null
             and btrim(coalesce(${t.rejectionReason}, '')) <> '')`,
    ),
    check(
      'retail_eligibility_exceptions_revoked_check',
      sql`(${t.state} = 'revoked')
          = (${t.revokedByOxyUserId} is not null and ${t.revokedAt} is not null
             and btrim(coalesce(${t.revocationReason}, '')) <> '')`,
    ),
    // The derivation's read: live approved waivers for this supplier/variant.
    index('retail_eligibility_exceptions_live_idx')
      .on(t.supplierId, t.canonicalVariantId, t.expiresAt)
      .where(sql`${t.state} = 'approved'`),
    index('retail_eligibility_exceptions_queue_idx')
      .on(t.requestedAt)
      .where(sql`${t.state} = 'requested'`),
  ],
);

/**
 * `retail_eligibility_decisions` — the append-only RECORD of one answer (#121
 * acceptance 7, operations 5–7).
 *
 * ## This table is never an authority
 *
 * Nothing reads a row here to decide whether something is eligible; the verdict
 * is re-derived every time it is asked for. What the rows are FOR is the
 * operator trace, the "re-evaluate what changed" sweep, the eligible-catalogue
 * measurement and the alert on a checkout blocked by an eligibility that moved.
 * The relationship is `payment_discrepancies`' to a payment: a durable
 * observation, not a cached truth. `services/retail-eligibility/eligibility.ts`
 * does not import this table's repository, and a test fails the build if it
 * starts to.
 *
 * ## The policy citation is a NOT NULL COMPOSITE foreign key
 *
 * `(policy_id, policy_key, policy_version)` references
 * `retail_eligibility_policies.(id, policy_key, version)`. So a decision that
 * cannot name the version it was made under is unrepresentable, and one whose
 * snapshot names a DIFFERENT version than its policy row is refused by Postgres
 * rather than by a comparison somebody has to remember — the
 * `match_category_gates` device, applied to reproducibility.
 *
 * There is one honest exception: a derivation made when NO policy version is
 * active answers `unknown` with `policy_missing`, and it has no version to
 * cite. Such a decision is not recorded — the repository refuses it — because a
 * record that cannot be reproduced is not evidence of anything.
 */
export const retailEligibilityDecisions = pgTable(
  'retail_eligibility_decisions',
  {
    id: generatedId(),
    policyId: text().notNull(),
    /** The SNAPSHOT names, kept in agreement with `policy_id` by the composite FK. */
    policyKey: text().notNull(),
    policyVersion: integer().notNull(),
    /** SNAPSHOT provenance — no foreign key; offers refresh in place. */
    procurementOfferId: text().notNull(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** SNAPSHOT provenance — no foreign key; canonical entities merge. */
    canonicalVariantId: text(),
    /** The exact question, so the answer is reproducible from the row alone. */
    destinationCountry: text().notNull(),
    fulfilmentOriginCountry: text(),
    channel: text().notNull(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    quantity: integer().notNull(),
    fulfilmentMethod: text({ enum: asEnumValues(RETAIL_FULFILMENT_METHODS) }).notNull(),
    customerType: text({ enum: asEnumValues(RETAIL_CUSTOMER_TYPES) }).notNull(),
    verdict: text({ enum: asEnumValues(RETAIL_ELIGIBILITY_VERDICTS) }).notNull(),
    /** Sorted, deduped and non-empty exactly when the verdict is not `eligible`. */
    reasons: text().array().notNull().default([]),
    nextRequiredAction: text({ enum: asEnumValues(RETAIL_ELIGIBILITY_ACTIONS) }).notNull(),
    /** The evidence row ids the answer rested on, in a stable order. */
    resaleEvidenceIds: text().array().notNull().default([]),
    complianceEvidenceIds: text().array().notNull().default([]),
    /** The exception that waived a reason, when one did. */
    exceptionId: text().references(() => retailEligibilityExceptions.id, { onDelete: 'restrict' }),
    /** sha-256 over the canonical composition of query, policy and outcome. */
    contentHash: text().notNull(),
    evaluatedAt: timestamptz().notNull(),
    /** Where the question came from: `publication`, `checkout`, `sweep`, `operator`. */
    surface: text().notNull(),
    /** No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('retail_eligibility_decisions_verdict_check', t.verdict, RETAIL_ELIGIBILITY_VERDICTS),
    checkOneOf(
      'retail_eligibility_decisions_action_check',
      t.nextRequiredAction,
      RETAIL_ELIGIBILITY_ACTIONS,
    ),
    checkOneOf(
      'retail_eligibility_decisions_method_check',
      t.fulfilmentMethod,
      RETAIL_FULFILMENT_METHODS,
    ),
    checkOneOf(
      'retail_eligibility_decisions_customer_type_check',
      t.customerType,
      RETAIL_CUSTOMER_TYPES,
    ),
    checkEveryElementOf(
      'retail_eligibility_decisions_reasons_check',
      t.reasons,
      RETAIL_ELIGIBILITY_REASONS,
    ),
    checkOneOf('retail_eligibility_decisions_channel_check', t.channel, AGREEMENT_CHANNELS),
    ...currencyChecks('retail_eligibility_decisions', [t.currency]),
    check('retail_eligibility_decisions_policy_version_check', sql`${t.policyVersion} >= 1`),
    check('retail_eligibility_decisions_quantity_check', sql`${t.quantity} > 0`),
    check(
      'retail_eligibility_decisions_countries_check',
      sql`${t.destinationCountry} ~ '^[A-Z]{2}$'
          and (${t.fulfilmentOriginCountry} is null or ${t.fulfilmentOriginCountry} ~ '^[A-Z]{2}$')`,
    ),
    check(
      'retail_eligibility_decisions_surface_check',
      sql`${t.surface} in ('publication', 'checkout', 'sweep', 'operator')`,
    ),
    // An eligible answer explains nothing; anything else explains itself — the
    // `retail_cost_quotes` block-reason rule.
    check(
      'retail_eligibility_decisions_reason_presence_check',
      sql`(${t.verdict} = 'eligible') = (cardinality(${t.reasons}) = 0)`,
    ),
    // `none` is the action of an eligible answer, and of no other.
    check(
      'retail_eligibility_decisions_action_presence_check',
      sql`(${t.verdict} = 'eligible') = (${t.nextRequiredAction} = 'none')`,
    ),
    check(
      'retail_eligibility_decisions_content_hash_check',
      sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    /** THE citation — see the table docblock. */
    foreignKey({
      name: 'retail_eligibility_decisions_policy_fk',
      columns: [t.policyId, t.policyKey, t.policyVersion],
      foreignColumns: [
        retailEligibilityPolicies.id,
        retailEligibilityPolicies.policyKey,
        retailEligibilityPolicies.version,
      ],
    }).onDelete('restrict'),
    // "What did this offer last answer, into this market" — the operator trace
    // and the re-evaluation sweep, one index.
    index('retail_eligibility_decisions_offer_idx').on(
      t.procurementOfferId,
      t.destinationCountry,
      t.evaluatedAt,
    ),
    index('retail_eligibility_decisions_supplier_idx').on(t.supplierId, t.evaluatedAt),
    // The eligible-catalogue measurement (#121 operations 6).
    index('retail_eligibility_decisions_verdict_idx').on(t.verdict, t.evaluatedAt),
    index('retail_eligibility_decisions_content_hash_idx').on(t.contentHash),
  ],
);

/**
 * `retail_eligibility_audits` — every approval, rejection and override, one row
 * per ATTEMPT (#121 operations 3).
 *
 * The `payment_repairs` shape verbatim: append-only by trigger, a mandatory
 * actor, a mandatory reason, and a row whether the attempt SUCCEEDED or was
 * refused — because "who tried to verify this and was told no" is exactly the
 * question an incident asks, and a table that only records successes cannot
 * answer it.
 *
 * The subject is a `(table, row id)` pair rather than nine nullable foreign
 * keys: an audit row must outlive its subject (the `cart_merges` reasoning), and
 * a foreign key here would make the trail a function of whether what it
 * describes still exists.
 */
export const retailEligibilityAudits = pgTable(
  'retail_eligibility_audits',
  {
    id: generatedId(),
    action: text({ enum: asEnumValues(RETAIL_ELIGIBILITY_AUDIT_ACTIONS) }).notNull(),
    /** The SQL table the subject row lives in — correlation, no foreign key. */
    subjectTable: text().notNull(),
    /** The subject row's id — correlation, no foreign key. */
    subjectId: text().notNull(),
    /** Whether the attempt was carried out or refused. Both are recorded. */
    outcome: text().notNull(),
    /** Mandatory. An unexplained decision about what Mercaria may sell is not one. */
    reason: text().notNull(),
    /** An Oxy account id — no foreign key. Mandatory: nothing here is anonymous. */
    actorOxyUserId: text().notNull(),
    /** Bounded detail — never a payload, never a document. */
    detail: text(),
    at: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('retail_eligibility_audits_action_check', t.action, RETAIL_ELIGIBILITY_AUDIT_ACTIONS),
    check(
      'retail_eligibility_audits_outcome_check',
      sql`${t.outcome} in ('applied', 'refused')`,
    ),
    check('retail_eligibility_audits_subject_check', sql`btrim(${t.subjectTable}) <> '' and btrim(${t.subjectId}) <> ''`),
    check(
      'retail_eligibility_audits_reason_check',
      sql`btrim(${t.reason}) <> '' and length(${t.reason}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check('retail_eligibility_audits_actor_check', sql`btrim(${t.actorOxyUserId}) <> ''`),
    check(
      'retail_eligibility_audits_detail_check',
      sql`${t.detail} is null or length(${t.detail}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    index('retail_eligibility_audits_subject_idx').on(t.subjectTable, t.subjectId, t.at),
    index('retail_eligibility_audits_actor_idx').on(t.actorOxyUserId, t.at),
    index('retail_eligibility_audits_action_idx').on(t.action, t.at),
  ],
);
