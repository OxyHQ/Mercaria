/**
 * The procurement domain (#118): `suppliers`, `supplier_contacts`,
 * `supplier_events`, `supplier_accounts`, `supplier_agreements`,
 * `supplier_agreement_evidence`, `procurement_offers`, `purchase_orders`,
 * `purchase_order_lines`, `purchase_order_transitions`,
 * `purchase_order_shipments`.
 *
 * The private supply side of Mercaria retail (ADR 0004): who Mercaria can BUY
 * from, under which agreement, at which terms, and the durable B2B record of
 * each purchase. It sits BESIDE the payment domain with its own seam
 * (`services/procurement/order-linkage.ts`), and neither imports the other:
 * supplier acceptance never marks a payment, and a Stripe success never marks
 * procurement accepted (ADR 0004 D1; #118 consistency rules 4–5).
 *
 * ## The boundaries this file exists to hold
 *
 * **A supplier is not a merchant, a brand or an organization** (ADR 0002).
 * Creating one grants no public page and no official status. Where the
 * canonical graph has LANDED, the linkage is a real RESTRICT foreign key
 * (`suppliers.organization_id` → `organizations`, #53); where it has not
 * (#56's product/variant tables), the mapping columns are plain and sit in
 * `DEFERRED_FOREIGN_KEYS`, which forces the constraint the moment the tables
 * appear.
 *
 * **A supplier platform's id is never a Mercaria primary key** — the payments
 * invariant, applied to a second family of external systems. Every
 * `provider_account_id` / `supplier_external_order_id` here is a plain,
 * indexed column in a foreign key space.
 *
 * **Credentials are REFERENCES into the approved secret store, never values**
 * (ADR 0004 D6.5: SSM under `/oxy/mercaria/suppliers/*`). The
 * `credential_reference` column carries a PATH-shaped CHECK so a pasted API
 * key fails the write, and the column is registered in
 * `db/protectedColumns.ts` so no whole-row read can ship it.
 *
 * **One purchase order = one supplier account + one currency** (#118
 * consistency rule 2), held STRUCTURALLY: the PO carries ONE `currency` column
 * and five bare amount columns, so a second currency is unrepresentable rather
 * than merely rejected — the reasoning that keeps a `direction` column out of
 * the ledger.
 *
 * **The order correlation carries no foreign key.** `purchase_orders.order_id`
 * names the customer order it fulfils the way `payments.order_id` does: a B2B
 * procurement record must be insertable and readable independently of the
 * commerce record it names, and it outlives anything that happens to that row.
 *
 * ## What is deliberately absent
 *
 * - No `po_number` sequence. The commerce gate pins EXACTLY two sequences
 *   (`order_number_seq`, `rma_number_seq`), and ADR 0004 D6.6 makes the PO's
 *   own id the external reference every supplier draw carries — a third
 *   printed number would be a second identity for one record.
 * - No stored eligibility flag on `procurement_offers`. Eligibility is DERIVED
 *   (`services/procurement/procurement-eligibility.ts`) from supplier, account,
 *   agreement and freshness facts — a stored verdict beside them is two
 *   representations of one fact, and the place they must not disagree is a
 *   checkout gate.
 * - No `mercaria_retail` widening of `orders` (`sellerType: 'platform'`,
 *   `commercialRole`). Nothing can CREATE a platform order until retail
 *   checkout (#123) and the public offer (#57) exist, and a value the database
 *   accepts but no code can produce is the trap `payment.ts` names. Those
 *   columns land with the code that writes them.
 *
 * ## Hand-written triggers ride the same migration
 *
 * Like the ledger's append-only triggers, three enforcement functions are
 * hand-added to this domain's migration (drizzle-kit does not model triggers):
 * `purchase_order_lines` refuses UPDATE and DELETE outright (the line set IS
 * the immutable quote snapshot), and `purchase_orders` refuses any change to
 * its identity columns ever, and to its money/fx columns once it has left
 * `draft` — which is what makes "source refresh cannot silently change the
 * cost snapshot of an already submitted order" (#118 consistency rule 7) a
 * property of the database rather than of whoever writes the next service.
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
  AGREEMENT_APPROVAL_STATES,
  AGREEMENT_CHANNELS,
  AGREEMENT_EVIDENCE_KINDS,
  AGREEMENT_PAYMENT_TERMS_KINDS,
  INCOTERMS,
  PROCUREMENT_AVAILABILITY_STATES,
  PROCUREMENT_OFFER_STATUSES,
  PROCUREMENT_PROVENANCES,
  PURCHASE_ORDER_INITIATORS,
  PURCHASE_ORDER_REASON_CODES,
  PURCHASE_ORDER_STATUSES,
  SUPPLIER_ACCOUNT_ENVIRONMENTS,
  SUPPLIER_ACCOUNT_STATES,
  SUPPLIER_API_CAPABILITIES,
  SUPPLIER_CONTACT_KINDS,
  SUPPLIER_CREDENTIAL_STATUSES,
  SUPPLIER_EVENT_KINDS,
  SUPPLIER_RISK_LEVELS,
  SUPPLIER_STATUSES,
  SUPPLIER_TYPES,
} from '@mercaria/shared-types';
import {
  addressColumns,
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
  money,
} from './columns';
import { organizations } from './organizations';

/** Bound on any stored note or error — the `.slice()` at every writer. */
const MAX_NOTE_LENGTH = 2_000;

/**
 * `suppliers` — one B2B supply counterparty, however many platform accounts or
 * agreement versions it has.
 *
 * ## The organization linkage is an identity claim with evidence
 *
 * `organization_id` is a real RESTRICT foreign key into #53's `organizations`,
 * and the verification pair beside it is complete-or-absent so a "verified"
 * linkage with no evidence is unrepresentable. Verifying it grants NOTHING
 * public: official-brand status lives in `commerce_relationships` behind real
 * evidence (ADR 0002 D10), not here.
 *
 * ## Merge history is a tombstone plus append-only events
 *
 * A merged supplier keeps its row (`status = 'merged'`, `merged_into_id` → the
 * winner) exactly like an ADR 0002 canonical tombstone, because purchase
 * orders keep naming it forever — a merge repoints LIVE children (accounts,
 * agreements, offers) and never a historical PO (#118 consistency rule 6; the
 * PO trigger makes the rewrite impossible, not just refused in review).
 */
export const suppliers = pgTable(
  'suppliers',
  {
    id: generatedId(),
    status: text({ enum: asEnumValues(SUPPLIER_STATUSES) }).notNull().default('under_review'),
    supplierType: text({ enum: asEnumValues(SUPPLIER_TYPES) }).notNull(),
    /** The name Mercaria's operators know this counterparty by. */
    canonicalName: text().notNull(),
    /**
     * Alternate spellings and trade names, for operator search. `text[]` and not
     * an alias table: suppliers number in the dozens, nothing queries these BY
     * element, and the canonical graph's per-entity alias tables (#53) exist for
     * a different, public problem.
     */
    internalAliases: text().array().notNull().default([]),
    /**
     * The canonical-graph organization this supplier IS, once verified (#53).
     * `restrict`, like every FK within the graph (ADR 0002 D20): canonical
     * rows are never hard-deleted, and a supplier's identity claim must not be
     * orphaned silently. Carrying the id asserts nothing public — official
     * status lives in `commerce_relationships` behind evidence.
     */
    organizationId: text().references(() => organizations.id, { onDelete: 'restrict' }),
    organizationVerifiedAt: timestamptz(),
    /** What proved the linkage — a register lookup, a signed contract, a domain. */
    organizationVerificationEvidence: text(),
    /** ISO-3166-1 alpha-2, upper-cased at the write site. */
    establishmentCountries: text().array().notNull().default([]),
    /** Where this supplier actually ships FROM — the #121 EU-origin gate's input. */
    fulfilmentOriginCountries: text().array().notNull().default([]),
    /** Domains proven to belong to this supplier (lower-cased at the write site). */
    verifiedDomains: text().array().notNull().default([]),
    riskLevel: text({ enum: asEnumValues(SUPPLIER_RISK_LEVELS) })
      .notNull()
      .default('unassessed'),
    riskReviewedAt: timestamptz(),
    riskReviewNote: text(),
    /**
     * Operator working notes and evidence pointers. PROTECTED
     * (`db/protectedColumns.ts`): commercially sensitive counterparty detail
     * that must never reach a DTO through a whole-row read.
     */
    internalNotes: text(),
    /** When this supplier first became `active`. Set once, never cleared. */
    activatedAt: timestamptz(),
    deactivatedAt: timestamptz(),
    deactivationReason: text(),
    /** The merge winner, on a tombstone. Flattened on write — one hop resolves. */
    mergedIntoId: text().references((): AnyPgColumn => suppliers.id, { onDelete: 'restrict' }),
    mergedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('suppliers_status_check', t.status, SUPPLIER_STATUSES),
    checkOneOf('suppliers_supplier_type_check', t.supplierType, SUPPLIER_TYPES),
    checkOneOf('suppliers_risk_level_check', t.riskLevel, SUPPLIER_RISK_LEVELS),
    check('suppliers_canonical_name_check', sql`length(btrim(${t.canonicalName})) > 0`),
    check('suppliers_internal_aliases_check', sql`not ('' = any(${t.internalAliases}))`),
    check(
      'suppliers_establishment_countries_check',
      sql`not ('' = any(${t.establishmentCountries}))`,
    ),
    check(
      'suppliers_fulfilment_origins_check',
      sql`not ('' = any(${t.fulfilmentOriginCountries}))`,
    ),
    check('suppliers_verified_domains_check', sql`not ('' = any(${t.verifiedDomains}))`),
    // A verification is a timestamp AND its evidence, or neither — and it can
    // only be about a linkage that exists.
    check(
      'suppliers_org_verification_complete_check',
      sql`num_nonnulls(${t.organizationVerifiedAt}, ${t.organizationVerificationEvidence}) in (0, 2)`,
    ),
    check(
      'suppliers_org_verification_target_check',
      sql`${t.organizationVerifiedAt} is null or ${t.organizationId} is not null`,
    ),
    // A tombstone names its winner; nothing else may carry one.
    check(
      'suppliers_merged_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)
          and (${t.status} = 'merged') = (${t.mergedAt} is not null)`,
    ),
    check(
      'suppliers_deactivated_check',
      sql`(${t.status} = 'deactivated') = (${t.deactivatedAt} is not null)`,
    ),
    // The operator list: "which suppliers are in state X".
    index('suppliers_status_idx').on(t.status, t.createdAt),
  ],
);

/**
 * `supplier_contacts` — the support / finance / returns / compliance people
 * (#118 supplier model 5). A child table rather than eight columns because a
 * supplier legitimately has several contacts per role.
 *
 * `email` and `phone` are PROTECTED columns: a person's contact details on a
 * table an operator surface reads — exactly the `customers.email` precedent.
 */
export const supplierContacts = pgTable(
  'supplier_contacts',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(SUPPLIER_CONTACT_KINDS) }).notNull(),
    name: text(),
    email: text(),
    phone: text(),
    url: text(),
    note: text(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('supplier_contacts_kind_check', t.kind, SUPPLIER_CONTACT_KINDS),
    // A contact that names nobody and no way to reach anybody is not a contact.
    check(
      'supplier_contacts_reachable_check',
      sql`num_nonnulls(${t.name}, ${t.email}, ${t.phone}, ${t.url}) >= 1`,
    ),
    index('supplier_contacts_supplier_id_idx').on(t.supplierId, t.kind, t.position),
  ],
);

/**
 * `supplier_events` — the append-only merge / replacement / deactivation
 * history (#118 supplier model 10). `at` only, no `updated_at`: the absence is
 * the append-only contract, the `order_status_history` shape.
 *
 * `restrict` from `suppliers`, unlike an ordinary history child: suppliers are
 * never hard-deleted (lifecycle states are the delete), and history that could
 * vanish with its subject is not history.
 */
export const supplierEvents = pgTable(
  'supplier_events',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(SUPPLIER_EVENT_KINDS) }).notNull(),
    /** The merge winner or the replacement — the OTHER supplier the event names. */
    relatedSupplierId: text().references(() => suppliers.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key. NULL for a system event. */
    byOxyUserId: text(),
    note: text(),
    at: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('supplier_events_kind_check', t.kind, SUPPLIER_EVENT_KINDS),
    // A merge or replacement without its counterparty is a fact about nothing.
    check(
      'supplier_events_related_check',
      sql`${t.kind} not in ('merged', 'replaced') or ${t.relatedSupplierId} is not null`,
    ),
    check(
      'supplier_events_note_length_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    index('supplier_events_supplier_id_at_idx').on(t.supplierId, t.at),
  ],
);

/**
 * `supplier_accounts` — one concrete account on one supplier platform, in one
 * environment. The thing an adapter (#124) authenticates AS.
 *
 * ## `provider` is a shape-checked OPEN set, unlike `PAYMENT_PROVIDER_IDS`
 *
 * Payment rails are a closed tuple because each arrives with its adapter and
 * its migration. Supplier platforms arrive per-supplier (#125 builds the first
 * adapter), and gating the RECORD of an account on Mercaria having shipped its
 * adapter would invert the domain's own rule — the durable record is never
 * gated, only the loop that uses it. The CHECK pins the slug SHAPE
 * (`^[a-z0-9][a-z0-9_-]*$`) so the value stays a machine identifier, and the
 * adapter registry (#124) is what closes the set operationally.
 *
 * ## `credential_reference` cannot hold a secret, structurally
 *
 * ADR 0004 D6.5: supplier credentials live in SSM under
 * `/oxy/mercaria/suppliers/*`, per-supplier, least-privilege. This column is
 * the POINTER only, and its CHECK requires a leading `/` and a path character
 * set — a pasted API key (`sk_live_…`, spaces, base64 padding) fails the
 * write. It is also PROTECTED, so only a path that names it explicitly (the
 * adapter's credential resolver) can read it back.
 */
export const supplierAccounts = pgTable(
  'supplier_accounts',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** The supplier platform / adapter slug — an open, shape-checked set. */
    provider: text().notNull(),
    environment: text({ enum: asEnumValues(SUPPLIER_ACCOUNT_ENVIRONMENTS) }).notNull(),
    /** The platform's own account id — a foreign key space, never a Mercaria key. */
    providerAccountId: text().notNull(),
    /** A secret-store PATH (`/oxy/mercaria/suppliers/…`) — never the secret. PROTECTED. */
    credentialReference: text(),
    /** Where this account's billing / prefunded-balance configuration lives. */
    billingReference: text(),
    /** ISO-3166-1 alpha-2 markets this account may sell into. */
    enabledMarkets: text().array().notNull().default([]),
    /** Origins this account actually ships from. */
    fulfilmentOrigins: text().array().notNull().default([]),
    /** What the platform's API can do for this account — the #124 capability set. */
    apiCapabilities: text().array().notNull().default([]),
    credentialStatus: text({ enum: asEnumValues(SUPPLIER_CREDENTIAL_STATUSES) })
      .notNull()
      .default('unconfigured'),
    lastHealthCheckAt: timestamptz(),
    /** NULL = never checked — a different fact from a failed check. */
    lastHealthCheckOk: boolean(),
    /** Adapter throttle configuration. NULL = the adapter's own default. */
    rateLimitPerMinute: integer(),
    dailyOrderQuota: integer(),
    state: text({ enum: asEnumValues(SUPPLIER_ACCOUNT_STATES) }).notNull().default('inactive'),
    /** When this account first became `active`. Set once, never cleared. */
    activatedAt: timestamptz(),
    killSwitchedAt: timestamptz(),
    killSwitchReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('supplier_accounts_environment_check', t.environment, SUPPLIER_ACCOUNT_ENVIRONMENTS),
    checkOneOf(
      'supplier_accounts_credential_status_check',
      t.credentialStatus,
      SUPPLIER_CREDENTIAL_STATUSES,
    ),
    checkOneOf('supplier_accounts_state_check', t.state, SUPPLIER_ACCOUNT_STATES),
    checkEveryElementOf(
      'supplier_accounts_api_capabilities_check',
      t.apiCapabilities,
      SUPPLIER_API_CAPABILITIES,
    ),
    // A machine identifier, not a display name — the adapter registry keys on it.
    check('supplier_accounts_provider_check', sql`${t.provider} ~ '^[a-z0-9][a-z0-9_-]*$'`),
    check(
      'supplier_accounts_provider_account_id_check',
      sql`length(${t.providerAccountId}) > 0`,
    ),
    // A secret-store PATH: leading slash, path characters, bounded. A raw API
    // key or token fails this shape — which is the point.
    check(
      'supplier_accounts_credential_reference_check',
      sql`${t.credentialReference} is null
          or (${t.credentialReference} ~ '^/[A-Za-z0-9/_.-]+$' and length(${t.credentialReference}) <= 512)`,
    ),
    // A credential status about no credential is a claim about nothing.
    check(
      'supplier_accounts_credential_configured_check',
      sql`${t.credentialStatus} = 'unconfigured' or ${t.credentialReference} is not null`,
    ),
    check('supplier_accounts_enabled_markets_check', sql`not ('' = any(${t.enabledMarkets}))`),
    check(
      'supplier_accounts_fulfilment_origins_check',
      sql`not ('' = any(${t.fulfilmentOrigins}))`,
    ),
    check(
      'supplier_accounts_rate_limit_check',
      sql`(${t.rateLimitPerMinute} is null or ${t.rateLimitPerMinute} >= 1)
          and (${t.dailyOrderQuota} is null or ${t.dailyOrderQuota} >= 1)`,
    ),
    // The kill switch is a state, a time and a mandatory reason, together.
    check(
      'supplier_accounts_kill_switch_check',
      sql`((${t.state} = 'killed') = (${t.killSwitchedAt} is not null))
          and num_nonnulls(${t.killSwitchedAt}, ${t.killSwitchReason}) in (0, 2)`,
    ),
    // "Supplier by provider and external account" (#118 indexes 1) — and the
    // constraint that stops two Mercaria rows claiming one platform account.
    uniqueIndex('supplier_accounts_provider_account_key').on(
      t.provider,
      t.environment,
      t.providerAccountId,
    ),
    index('supplier_accounts_supplier_id_idx').on(t.supplierId, t.state),
  ],
);

/**
 * `supplier_agreements` — one VERSION of the written supply agreement with one
 * supplier. Versioned by row: `UNIQUE(supplier_id, version)`, and a purchase
 * order pins the version it was created under by foreign key, which is what
 * makes its terms immutable without copying them (#118 PO item 15).
 *
 * ## Approval is one stored verdict, and it is evidence-gated in the schema
 *
 * `approval_state = 'approved'` REQUIRES — by CHECK, not convention — an
 * effective date, an evidence location, a reviewer, an approver and accepted
 * data-processing terms (ADR 0004 D2.7 makes the DPA clauses mandatory in
 * every supply agreement, so an approval without them is not an approval).
 * Scope (destinations, channels, rights, expiry) is evaluated by
 * `services/procurement/agreement-scope.ts`, fail-closed.
 *
 * ## Empty scope arrays mean NONE, deliberately
 *
 * `commerce_relationships.territories` reads `'{}'` as "worldwide" because a
 * relationship is a positive fact being scoped down. An agreement is the
 * opposite: it GRANTS, and a grant that names no destination grants none. The
 * two semantics are documented against each other in `CONVENTIONS.md`.
 */
export const supplierAgreements = pgTable(
  'supplier_agreements',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    version: integer().notNull(),
    approvalState: text({ enum: asEnumValues(AGREEMENT_APPROVAL_STATES) })
      .notNull()
      .default('draft'),
    effectiveAt: timestamptz(),
    /** NULL = no fixed end. Expiry removes eligibility, never history (#118 acceptance 6). */
    expiresAt: timestamptz(),
    /** ISO-3166-1 alpha-2 customer destinations this agreement permits. Empty = none. */
    permittedDestinationCountries: text().array().notNull().default([]),
    /** Which Mercaria channels are permitted. Empty = none. */
    permittedChannels: text().array().notNull().default([]),
    resaleRightsGranted: boolean().notNull().default(false),
    dropshipRightsGranted: boolean().notNull().default(false),
    whiteLabelRightsGranted: boolean().notNull().default(false),
    /**
     * The ADR 0004 D2.3 / D12.4 verdict: the supplier ships blind — no supplier
     * invoice, no supplier pricing in the parcel — verified per supplier, and
     * the gate data #121 reads.
     */
    blindDropshipVerified: boolean().notNull().default(false),
    catalogDataRightsGranted: boolean().notNull().default(false),
    imageRightsGranted: boolean().notNull().default(false),
    pricingDataRightsGranted: boolean().notNull().default(false),
    /** Brand / category / product carve-outs, as the contract names them. */
    excludedBrands: text().array().notNull().default([]),
    excludedCategories: text().array().notNull().default([]),
    excludedProductRefs: text().array().notNull().default([]),
    mapRestricted: boolean().notNull().default(false),
    pricingRestrictionsNote: text(),
    /** ADR 0004 open item 2: the 48h default is CARRIED HERE as versioned config. */
    acceptanceSlaHours: integer().notNull().default(48),
    shipmentSlaHours: integer(),
    packagingBrandingNote: text(),
    returnsResponsibility: text(),
    warrantyResponsibility: text(),
    recallResponsibility: text(),
    incoterm: text({ enum: asEnumValues(INCOTERMS) }),
    shippingTermsNote: text(),
    paymentTermsKind: text({ enum: asEnumValues(AGREEMENT_PAYMENT_TERMS_KINDS) })
      .notNull()
      .default('prepaid_balance'),
    /** Net-N days — present exactly when the terms are `invoice_net` (ADR 0004 D6.3). */
    creditTermDays: integer(),
    /** ADR 0004 D2.7: purpose limitation, no-marketing, deletion-after-retention. */
    dataProcessingTermsAccepted: boolean().notNull().default(false),
    dataProcessingNote: text(),
    /** Where the signed contract for THIS version lives (vault ref / Oxy file id). */
    evidenceLocation: text(),
    /** An Oxy account id — no foreign key. */
    reviewedByOxyUserId: text(),
    approvedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    approvedByOxyUserId: text(),
    /** The version that replaced this one, once superseded. */
    supersededById: text().references((): AnyPgColumn => supplierAgreements.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('supplier_agreements_approval_state_check', t.approvalState, AGREEMENT_APPROVAL_STATES),
    checkOneOf('supplier_agreements_incoterm_check', t.incoterm, INCOTERMS),
    checkOneOf(
      'supplier_agreements_payment_terms_kind_check',
      t.paymentTermsKind,
      AGREEMENT_PAYMENT_TERMS_KINDS,
    ),
    checkEveryElementOf(
      'supplier_agreements_permitted_channels_check',
      t.permittedChannels,
      AGREEMENT_CHANNELS,
    ),
    check('supplier_agreements_version_check', sql`${t.version} >= 1`),
    check(
      'supplier_agreements_window_check',
      sql`${t.effectiveAt} is null or ${t.expiresAt} is null or ${t.expiresAt} > ${t.effectiveAt}`,
    ),
    check(
      'supplier_agreements_destinations_check',
      sql`not ('' = any(${t.permittedDestinationCountries}))`,
    ),
    check(
      'supplier_agreements_sla_check',
      sql`${t.acceptanceSlaHours} >= 1
          and (${t.shipmentSlaHours} is null or ${t.shipmentSlaHours} >= 1)`,
    ),
    // Credit terms are a number of days exactly when the kind says invoice.
    check(
      'supplier_agreements_credit_terms_check',
      sql`(${t.paymentTermsKind} = 'invoice_net') = (${t.creditTermDays} is not null)
          and (${t.creditTermDays} is null or ${t.creditTermDays} >= 1)`,
    ),
    // An approval is a decision WITH its record: when, by whom, reviewed by
    // whom, where the contract lives, from when it runs, and with the mandatory
    // data-processing clauses accepted. Anything less is not `approved`.
    check(
      'supplier_agreements_approved_complete_check',
      sql`${t.approvalState} <> 'approved'
          or (${t.approvedAt} is not null
              and ${t.approvedByOxyUserId} is not null
              and ${t.reviewedByOxyUserId} is not null
              and ${t.evidenceLocation} is not null
              and ${t.effectiveAt} is not null
              and ${t.dataProcessingTermsAccepted})`,
    ),
    check(
      'supplier_agreements_superseded_check',
      sql`(${t.approvalState} = 'superseded') = (${t.supersededById} is not null)`,
    ),
    uniqueIndex('supplier_agreements_supplier_version_key').on(t.supplierId, t.version),
    // "Active agreements by supplier, market, channel and time" (#118 indexes 2):
    // the approved rows, filterable by window; array scopes are re-checked in
    // the fail-closed scope service.
    index('supplier_agreements_active_idx')
      .on(t.supplierId, t.effectiveAt, t.expiresAt)
      .where(sql`${t.approvalState} = 'approved'`),
    // "Agreement and compliance expiry" (#118 indexes 7): what runs out next.
    index('supplier_agreements_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.approvalState} = 'approved' and ${t.expiresAt} is not null`),
  ],
);

/**
 * `supplier_agreement_evidence` — one document backing one agreement version:
 * the signed contract, an insurance certificate, a compliance document (#118
 * agreement items 14–15). Append-only (no `updated_at`), `restrict` from its
 * agreement: evidence blocks deletion rather than vanishing with it — the
 * `relationship_evidence` reasoning.
 */
export const supplierAgreementEvidence = pgTable(
  'supplier_agreement_evidence',
  {
    id: generatedId(),
    agreementId: text()
      .notNull()
      .references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(AGREEMENT_EVIDENCE_KINDS) }).notNull(),
    /** An Oxy media file id — Oxy owns the file, no foreign key. */
    oxyFileId: text(),
    url: text(),
    /** Content hash, so the claim survives the document moving or changing. */
    sha256: text(),
    note: text(),
    /** An Oxy account id — no foreign key. */
    collectedByOxyUserId: text(),
    collectedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('supplier_agreement_evidence_kind_check', t.kind, AGREEMENT_EVIDENCE_KINDS),
    // Evidence points at SOMETHING — a stored file or a location.
    check(
      'supplier_agreement_evidence_target_check',
      sql`num_nonnulls(${t.oxyFileId}, ${t.url}) >= 1`,
    ),
    check(
      'supplier_agreement_evidence_sha256_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    index('supplier_agreement_evidence_agreement_id_idx').on(t.agreementId),
  ],
);

/**
 * `procurement_offers` — the CURRENT terms under which Mercaria can source one
 * exact item from one supplier account. Private, always: nothing in this table
 * is ever serialized toward a public product API, and the one projection that
 * crosses that line (`RetailOfferSourcingSeam`) is a type with no cost field.
 *
 * ## Current state, not history — and the PO is why that is safe
 *
 * A source refresh UPDATES the row in place, converging on
 * `UNIQUE(supplier_account_id, supplier_sku)`. What was true at purchase time
 * is frozen onto `purchase_order_lines` at PO creation and made immutable by
 * trigger — so refreshing an offer can never touch a submitted order's cost
 * snapshot (#118 consistency rule 7), and the offer row is free to stay
 * honest about NOW. `first_seen_at` survives every refresh; `last_confirmed_at`
 * moves with each one.
 *
 * ## The canonical mapping is two plain columns
 *
 * `canonical_product_id` / `canonical_variant_id` name #56's tables, which are
 * being built in parallel — no foreign key, no import, registered in the
 * ledger. Several offers carrying one `canonical_variant_id` is exactly how
 * Mercaria sources one canonical variant from several suppliers without
 * minting several products (#118 acceptance 1). An unmapped offer (both NULL)
 * is stored and ineligible, never refused — matching is a later, separate
 * step.
 */
export const procurementOffers = pgTable(
  'procurement_offers',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** The agreement version this offer is sourced under, once one governs it. */
    agreementId: text().references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    /** Canonical-graph ids (#56) — parallel domain, no foreign key. */
    canonicalProductId: text(),
    canonicalVariantId: text(),
    /** The supplier's own SKU — source-scoped, half of the upsert key. */
    supplierSku: text().notNull(),
    /** The supplier platform's own catalog/object id, when it has one. */
    supplierExternalId: text(),
    /** The wholesale unit cost, in the supplier's own billing currency. */
    ...money('unitCost'),
    minimumOrderQuantity: integer().notNull().default(1),
    packSize: integer().notNull().default(1),
    availability: text({ enum: asEnumValues(PROCUREMENT_AVAILABILITY_STATES) })
      .notNull()
      .default('unknown'),
    /** NULL = the source does not report a count — a different fact from zero. */
    stockQuantity: integer(),
    fulfilmentOriginCountries: text().array().notNull().default([]),
    /** ISO-3166-1 alpha-2 destinations this offer can ship to. Empty = none (fail closed). */
    eligibleDestinationCountries: text().array().notNull().default([]),
    /** Whether the account's API can quote shipping for THIS item (#122's input). */
    shippingQuoteSupported: boolean().notNull().default(false),
    handlingDaysMin: integer(),
    handlingDaysMax: integer(),
    deliveryDaysMin: integer(),
    deliveryDaysMax: integer(),
    incoterm: text({ enum: asEnumValues(INCOTERMS) }),
    taxNote: text(),
    dutyNote: text(),
    returnPolicyRef: text(),
    warrantyPolicyRef: text(),
    /** A #121 compliance-verdict pointer, once that gate exists. */
    complianceVerdictRef: text(),
    /** Set at first ingestion and NEVER moved by a refresh. */
    firstSeenAt: timestamptz().notNull(),
    /** The last time the source confirmed these terms. Moves with every refresh. */
    lastConfirmedAt: timestamptz().notNull(),
    /** How long a quote from this source may be trusted. NULL = source default. */
    quoteTtlSeconds: integer(),
    /**
     * A hard end the source declared (a closeout, a seasonal delist). DERIVED
     * staleness — `expires_at < now()` — never a status column that could
     * disagree with the clock.
     */
    expiresAt: timestamptz(),
    provenance: text({ enum: asEnumValues(PROCUREMENT_PROVENANCES) }).notNull(),
    /** 0–1 for machine-matched facts; NULL = deterministic or human (ADR 0002). */
    confidence: doublePrecision(),
    status: text({ enum: asEnumValues(PROCUREMENT_OFFER_STATUSES) })
      .notNull()
      .default('active'),
    retiredAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'procurement_offers_availability_check',
      t.availability,
      PROCUREMENT_AVAILABILITY_STATES,
    ),
    checkOneOf('procurement_offers_incoterm_check', t.incoterm, INCOTERMS),
    checkOneOf('procurement_offers_provenance_check', t.provenance, PROCUREMENT_PROVENANCES),
    checkOneOf('procurement_offers_status_check', t.status, PROCUREMENT_OFFER_STATUSES),
    ...currencyChecks('procurement_offers', [t.unitCostCurrency]),
    check('procurement_offers_supplier_sku_check', sql`length(${t.supplierSku}) > 0`),
    check('procurement_offers_unit_cost_check', sql`${t.unitCostAmount} >= 0`),
    check(
      'procurement_offers_quantities_check',
      sql`${t.minimumOrderQuantity} >= 1 and ${t.packSize} >= 1
          and (${t.stockQuantity} is null or ${t.stockQuantity} >= 0)`,
    ),
    // A variant mapping without its product is half a mapping.
    check(
      'procurement_offers_mapping_check',
      sql`${t.canonicalVariantId} is null or ${t.canonicalProductId} is not null`,
    ),
    check(
      'procurement_offers_origins_check',
      sql`not ('' = any(${t.fulfilmentOriginCountries}))`,
    ),
    check(
      'procurement_offers_destinations_check',
      sql`not ('' = any(${t.eligibleDestinationCountries}))`,
    ),
    // Each window is a complete, ordered pair or absent.
    check(
      'procurement_offers_handling_window_check',
      sql`num_nonnulls(${t.handlingDaysMin}, ${t.handlingDaysMax}) in (0, 2)
          and (${t.handlingDaysMin} is null
               or (${t.handlingDaysMin} >= 0 and ${t.handlingDaysMax} >= ${t.handlingDaysMin}))`,
    ),
    check(
      'procurement_offers_delivery_window_check',
      sql`num_nonnulls(${t.deliveryDaysMin}, ${t.deliveryDaysMax}) in (0, 2)
          and (${t.deliveryDaysMin} is null
               or (${t.deliveryDaysMin} >= 0 and ${t.deliveryDaysMax} >= ${t.deliveryDaysMin}))`,
    ),
    check(
      'procurement_offers_quote_ttl_check',
      sql`${t.quoteTtlSeconds} is null or ${t.quoteTtlSeconds} >= 1`,
    ),
    check(
      'procurement_offers_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    check(
      'procurement_offers_retired_check',
      sql`(${t.status} = 'retired') = (${t.retiredAt} is not null)`,
    ),
    // The source-upsert convergence key: a re-delivered feed row updates the
    // offer it already made, never a second one.
    uniqueIndex('procurement_offers_account_sku_key').on(t.supplierAccountId, t.supplierSku),
    // "Procurement offers by variant / supplier / freshness" (#118 indexes 3).
    index('procurement_offers_variant_idx')
      .on(t.canonicalVariantId, t.status)
      .where(sql`${t.canonicalVariantId} is not null`),
    index('procurement_offers_supplier_idx').on(t.supplierId, t.status),
    index('procurement_offers_freshness_idx').on(t.status, t.lastConfirmedAt),
    index('procurement_offers_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
    // Destination filtering is by array element (`@>`), which only GIN serves.
    index('procurement_offers_destinations_gin_idx').using(
      'gin',
      t.eligibleDestinationCountries,
    ),
  ],
);

/**
 * `purchase_orders` — the durable supplier-side order record, SEPARATE from
 * the customer order it fulfils (#118 PO model; ADR 0004 D5: one PO per
 * supplier under the retail order).
 *
 * ## Identity and idempotency
 *
 * `idempotency_key` is deterministic — `po:<orderId>:<supplierId>` (ADR 0004
 * D4 step 4) — and UNIQUE, so a replayed checkout consequence, a redelivered
 * supplier callback or two concurrent outbox dispatchers converge on ONE row
 * (#118 consistency rule 3, acceptance 4). The repository claims it with
 * `on conflict do nothing` and returns the survivor, the moderation-event
 * pattern.
 *
 * ## One currency, held structurally
 *
 * ONE `currency` column and five bare `bigint` amounts (items, shipping, tax,
 * duty, total). Two currencies on one PO are unrepresentable. There is
 * deliberately NO CHECK that the amounts sum: the total is the supplier's own
 * arithmetic from their quote, their rounding included, and #128 reconciles it
 * against their invoice — a constraint here would reject the record of what
 * the supplier actually said.
 *
 * ## The destination snapshot is redacted by SHAPE
 *
 * `destination_*` is the fulfilment-only projection of ADR 0004 D2.7:
 * recipient, address, phone where the carrier requires it. There is no email
 * column, no buyer identity, no order-history reference — the columns that
 * could leak do not exist.
 *
 * ## What the triggers freeze (hand-written SQL in this domain's migration)
 *
 * Identity columns (supplier, account, agreement, order, idempotency key,
 * checkout group) never change — which is how a supplier MERGE is structurally
 * unable to rewrite a historical PO (#118 consistency rule 6). The money, fx
 * and destination snapshot freeze the moment the PO leaves `draft` (#118
 * consistency rule 7). Lines are immutable from birth.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: generatedId(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** The agreement VERSION governing this PO — its immutable terms, by reference. */
    agreementId: text()
      .notNull()
      .references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    /** The customer seller-order this PO fulfils — correlation, no foreign key. */
    orderId: text().notNull(),
    /** The checkout group that order belongs to — the trace handle, no foreign key. */
    checkoutGroupId: text(),
    /** The supplier platform's own order id, once it has answered. Their key space. */
    supplierExternalOrderId: text(),
    /** Deterministic (`po:<orderId>:<supplierId>`) — the convergence key. */
    idempotencyKey: text().notNull(),
    /** The ONE currency every amount on this PO is denominated in. */
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    itemsAmount: bigint({ mode: 'number' }).notNull(),
    shippingAmount: bigint({ mode: 'number' }).notNull().default(0),
    taxAmount: bigint({ mode: 'number' }).notNull().default(0),
    dutyAmount: bigint({ mode: 'number' }).notNull().default(0),
    /** The supplier's own total — reconciled by #128, never recomputed here. */
    totalAmount: bigint({ mode: 'number' }).notNull(),
    // The FX snapshot relating this PO's currency to the platform settlement
    // currency, when a conversion was quoted — five columns, complete or
    // absent, the `orders.fx_rate_*` shape for the same reproducibility reason.
    fxRateFrom: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateTo: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateRate: doublePrecision(),
    fxRateProvider: text(),
    /** An ISO-8601 instant as TEXT — `FxRateSnapshot.asOf` is declared `string`. */
    fxRateAsOf: text(),
    /** The redacted fulfilment destination — see the table docblock. */
    ...addressColumns('destination'),
    status: text({ enum: asEnumValues(PURCHASE_ORDER_STATUSES) }).notNull().default('draft'),
    /** The normalized reason behind a refusal/expiry/cancellation, when one exists. */
    reasonCode: text({ enum: asEnumValues(PURCHASE_ORDER_REASON_CODES) }),
    /** The #122 preflight quote this PO was created from, when one exists. */
    quoteRef: text(),
    /** Snapshotted from the agreement's SLA at submission — the timeout sweep's clock. */
    acceptanceDeadlineAt: timestamptz(),
    submittedAt: timestamptz(),
    acceptedAt: timestamptz(),
    /** When the supplier reported stock ALLOCATED — a fact, not a status (D9.2). */
    allocatedAt: timestamptz(),
    /** First shipment / final delivery times; per-parcel detail is `purchase_order_shipments`. */
    shippedAt: timestamptz(),
    deliveredAt: timestamptz(),
    cancelledAt: timestamptz(),
    submissionAttempts: integer().notNull().default(0),
    lastSubmissionError: text(),
    /** An operator has to look — the exception queue's flag (#118 PO item 14). */
    operatorInterventionRequired: boolean().notNull().default(false),
    operatorNote: text(),
    /** #128 seams: the supplier's invoice / credit note, and when it reconciled. */
    supplierInvoiceRef: text(),
    supplierCreditNoteRef: text(),
    reconciledAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('purchase_orders_status_check', t.status, PURCHASE_ORDER_STATUSES),
    checkOneOf('purchase_orders_reason_code_check', t.reasonCode, PURCHASE_ORDER_REASON_CODES),
    ...currencyChecks('purchase_orders', [t.currency, t.fxRateFrom, t.fxRateTo]),
    check('purchase_orders_order_id_check', sql`length(${t.orderId}) > 0`),
    check('purchase_orders_idempotency_key_check', sql`length(${t.idempotencyKey}) > 0`),
    check(
      'purchase_orders_amounts_check',
      sql`${t.itemsAmount} >= 0 and ${t.shippingAmount} >= 0 and ${t.taxAmount} >= 0
          and ${t.dutyAmount} >= 0 and ${t.totalAmount} >= 0`,
    ),
    check(
      'purchase_orders_fx_rate_complete_check',
      sql`num_nonnulls(${t.fxRateFrom}, ${t.fxRateTo}, ${t.fxRateRate}, ${t.fxRateProvider}, ${t.fxRateAsOf}) in (0, 5)`,
    ),
    check(
      'purchase_orders_attempts_check',
      sql`${t.submissionAttempts} >= 0`,
    ),
    check(
      'purchase_orders_last_error_length_check',
      sql`${t.lastSubmissionError} is null or length(${t.lastSubmissionError}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // Consistency rules 3 and 4: replaying anything converges on this row.
    uniqueIndex('purchase_orders_idempotency_key_key').on(t.idempotencyKey),
    // "PO by customer order" (#118 indexes 5) — the fulfilment view's join.
    index('purchase_orders_order_id_idx').on(t.orderId),
    index('purchase_orders_checkout_group_id_idx')
      .on(t.checkoutGroupId)
      .where(sql`${t.checkoutGroupId} is not null`),
    // "PO by supplier external id" — the correlation every supplier callback
    // starts from, and the constraint that stops two POs claiming one supplier
    // order. Scoped to the account because platforms mint per-account ids.
    uniqueIndex('purchase_orders_supplier_external_order_key')
      .on(t.supplierAccountId, t.supplierExternalOrderId)
      .where(sql`${t.supplierExternalOrderId} is not null`),
    index('purchase_orders_supplier_status_idx').on(t.supplierId, t.status, t.createdAt),
    // The acceptance-timeout sweep: submitted POs, soonest deadline first.
    index('purchase_orders_submitted_deadline_idx')
      .on(t.acceptanceDeadlineAt)
      .where(sql`${t.status} = 'submitted'`),
    // "Stuck, failed and unreconciled" (#118 indexes 6): the operator queues.
    index('purchase_orders_operator_queue_idx')
      .on(t.createdAt)
      .where(sql`${t.operatorInterventionRequired}`),
    index('purchase_orders_unreconciled_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'delivered' and ${t.reconciledAt} is null`),
  ],
);

/**
 * `purchase_order_lines` — the exact SKU / quantity / cost snapshot the PO was
 * created with (#118 PO item 6). IMMUTABLE from birth: a trigger refuses
 * UPDATE and DELETE outright, so no source refresh, no offer re-mapping and no
 * merge can touch what was actually ordered.
 *
 * `canonical_*` and `procurement_offer_id` are SNAPSHOT provenance with no
 * foreign key — the `order_items.listing_id` rule: the target may move on
 * (offers are refreshed in place, canonical entities merge), and this row must
 * survive it verbatim. Amounts carry NO currency column: the parent PO's one
 * `currency` denominates every line, which is what "one PO, one currency"
 * means structurally.
 */
export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    /** The supplier's SKU as ordered — frozen. */
    supplierSku: text().notNull(),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    canonicalProductId: text(),
    /** SNAPSHOT provenance — deliberately no foreign key. */
    canonicalVariantId: text(),
    /** SNAPSHOT provenance — deliberately no foreign key; offers refresh in place. */
    procurementOfferId: text(),
    /** What was ordered, as a human reads it — frozen alongside the numbers. */
    description: text(),
    quantity: integer().notNull(),
    /** In the parent PO's currency, minor units — frozen. */
    unitCostAmount: bigint({ mode: 'number' }).notNull(),
    lineTotalAmount: bigint({ mode: 'number' }).notNull(),
    /** The quote line this snapshot came from (#122), when one exists. */
    quoteRef: text(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('purchase_order_lines_supplier_sku_check', sql`length(${t.supplierSku}) > 0`),
    check('purchase_order_lines_quantity_check', sql`${t.quantity} > 0`),
    check(
      'purchase_order_lines_amounts_check',
      sql`${t.unitCostAmount} >= 0 and ${t.lineTotalAmount} >= 0`,
    ),
    index('purchase_order_lines_purchase_order_id_idx').on(t.purchaseOrderId, t.position),
  ],
);

/**
 * `purchase_order_transitions` — the append-only lifecycle trail (#118 PO item
 * 15). The `order_status_history` shape: `at` only, no `updated_at`, and the
 * absence is the contract.
 *
 * `initiator` is what keeps supplier cancellation and customer cancellation
 * SEPARATE events (#118 consistency rule 8): the same `cancelled` status
 * arrived at from two directions is two different rows saying who asked.
 * `supplier_note` is stored REDACTED at the call site — never a payload.
 */
export const purchaseOrderTransitions = pgTable(
  'purchase_order_transitions',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    status: text({ enum: asEnumValues(PURCHASE_ORDER_STATUSES) }).notNull(),
    at: timestamptz().notNull(),
    initiator: text({ enum: asEnumValues(PURCHASE_ORDER_INITIATORS) }).notNull(),
    reasonCode: text({ enum: asEnumValues(PURCHASE_ORDER_REASON_CODES) }),
    /** The supplier's own words, redacted and bounded — never a payload. */
    supplierNote: text(),
    /** An Oxy account id — no foreign key. NULL unless a person did it. */
    byOxyUserId: text(),
  },
  (t) => [
    checkOneOf('purchase_order_transitions_status_check', t.status, PURCHASE_ORDER_STATUSES),
    checkOneOf(
      'purchase_order_transitions_initiator_check',
      t.initiator,
      PURCHASE_ORDER_INITIATORS,
    ),
    checkOneOf(
      'purchase_order_transitions_reason_code_check',
      t.reasonCode,
      PURCHASE_ORDER_REASON_CODES,
    ),
    check(
      'purchase_order_transitions_note_length_check',
      sql`${t.supplierNote} is null or length(${t.supplierNote}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    index('purchase_order_transitions_po_id_at_idx').on(t.purchaseOrderId, t.at),
  ],
);

/**
 * `purchase_order_shipments` — one parcel with one tracking reference (#118 PO
 * item 12). A child table because split shipments are ordinary (ADR 0004
 * diagram 7): each PO ships independently, and each parcel is tracked
 * separately toward #126's customer notifications.
 */
export const purchaseOrderShipments = pgTable(
  'purchase_order_shipments',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    trackingNumber: text().notNull(),
    carrier: text(),
    service: text(),
    shippedAt: timestamptz().notNull(),
    deliveredAt: timestamptz(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'purchase_order_shipments_tracking_number_check',
      sql`length(${t.trackingNumber}) > 0`,
    ),
    // A redelivered shipment callback updates the parcel it already made.
    uniqueIndex('purchase_order_shipments_po_tracking_key').on(t.purchaseOrderId, t.trackingNumber),
  ],
);
