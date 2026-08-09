/**
 * Verified relationships and their evidence — issue #55, bound by ADR 0002
 * D10/D11/D17: `commerce_relationships`, `relationship_evidence`,
 * `relationship_reviews`.
 *
 * ONE table with typed kinds and real foreign keys, not a boolean per fact and
 * not a polymorphic `{type, id}` pair — every endpoint's key space lives in THIS
 * database, so real references are available and the `orders` shape (nullable FK
 * columns plus a per-kind CHECK) applies. What that buys is concrete: a claim
 * naming a merchant that does not exist cannot be stored at all.
 *
 * ## Four properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **A badge cannot be minted from a name, a logo or a domain.**
 *    `verification_method`'s closed set has no `name_match` member — the same
 *    device `native_store_links` uses — so "verified because the name matched"
 *    has no value to be stored as. Which EVIDENCE kinds suffice per relationship
 *    kind is a further, service-side gate (`SUFFICIENT_EVIDENCE_KINDS`), because
 *    "at least one evidence row of an acceptable kind" is cross-table and a
 *    CHECK cannot see another table.
 * 2. **Verification and confidence cannot be confused.** They are two columns,
 *    and `commerce_relationships_confidence_machine_check` restricts a
 *    confidence number to rows an ingestion source asserted. A hand-verified row
 *    therefore has no confidence at all, so no reader can mistake one for a
 *    weaker form of the other.
 * 3. **Duplicate open claims are impossible, not merely refused.** The generated
 *    `endpoint_key` collapses the five nullable endpoint columns plus the
 *    storefront scope into one text key, and the partial unique
 *    `(kind, endpoint_key) WHERE valid_to IS NULL` uses it. A plain multi-column
 *    unique would NOT work: Postgres treats NULLs as distinct, so two rows with
 *    identical non-null endpoints and NULL elsewhere would both be admitted —
 *    the exact duplicate the index exists to stop.
 * 4. **History is never erased.** Nothing in this file is deleted by a
 *    production flow: expiry stamps `valid_to`, revocation stamps `revoked_at`
 *    plus `valid_to`, a correction opens a NEW row and links back through
 *    `superseded_by_id`, and both child tables are RESTRICT so evidence and
 *    review rows block a delete rather than vanishing with their parent.
 *
 * ## Markets are an ARRAY on one row, not one row per market
 *
 * ADR 0002 D17 allows at most one OPEN row per (kind, endpoints), so "Apple
 * Store is an official Apple channel in ES, FR and DE" is ONE row whose
 * `territories` lists three codes. That is what makes overlapping-window
 * detection unnecessary for identical endpoints: there is nothing to overlap
 * with. `'{}'` means WORLDWIDE — a positive claim scoped down, the opposite of
 * `supplier_agreements`' empty scope (which is a grant and means none).
 */

import { sql } from 'drizzle-orm';
import {
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
  RELATIONSHIP_ASSERTED_BY_KINDS,
  RELATIONSHIP_EVIDENCE_KINDS,
  RELATIONSHIP_EVIDENCE_STATUSES,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_REVIEW_ACTIONS,
  RELATIONSHIP_VERIFICATION_METHODS,
  RELATIONSHIP_VERIFICATION_STATES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { brands, organizations } from './organizations';
import { merchants, storefronts } from './merchants';
import { catalogSources, sourceRecords } from './provenance';
import { canonicalProductFamilies } from './canonicalCatalog';

/**
 * `commerce_relationships` — one typed, scoped, temporal, evidence-gated claim.
 *
 * ### The endpoint columns, and why there are FIVE and not four
 *
 * ADR 0002 D17 names four — one per entity kind. `brand_succeeds_brand` (the
 * issue's ninth type) has a brand on BOTH ends, so a fifth column is what an
 * endpoint-per-entity-kind model needs to express it: `related_brand_id` is the
 * OBJECT side of a brand → brand kind and is CHECKed NULL on every other kind.
 * The alternative — one `{subject_kind, subject_id, object_kind, object_id}`
 * quad — gives up every foreign key in the table to solve a problem exactly one
 * kind has, which is the trade D17 already rejected.
 *
 * `product_family_id` points at #56's `canonical_product_families`, which has
 * not landed: it is carried in `deferredForeignKeys.ts` as a DECIDED relation
 * (RESTRICT, per D20) and the convention gate flips it into a real
 * `.references()` the moment that table appears — the same mechanism #54 used
 * for `source_records`.
 *
 * ### `storefront_id` is SCOPE, not an endpoint
 *
 * The issue's field 6 asks for storefront scope beside geography, market and
 * language. It is part of `endpoint_key` all the same, because "official
 * channel through this specific storefront" and "official channel across every
 * channel this merchant runs" are two different claims that must be able to
 * coexist — while two rows differing only by TERRITORY must not, since markets
 * are an array on one row.
 */
export const commerceRelationships = pgTable(
  'commerce_relationships',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(RELATIONSHIP_KINDS) }).notNull(),

    // ── Endpoints (per-kind CHECK below decides which pair must be set) ──────
    organizationId: text().references(() => organizations.id, { onDelete: 'restrict' }),
    brandId: text().references(() => brands.id, { onDelete: 'restrict' }),
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    /**
     * The object endpoint of an `organization_manufactures` claim. RESTRICT
     * (ADR 0002 D20): a family is never hard-deleted out from under an
     * evidence-backed claim that cites it.
     */
    productFamilyId: text().references(() => canonicalProductFamilies.id, { onDelete: 'restrict' }),
    /** The OBJECT brand of a brand → brand kind; NULL on every other kind. */
    relatedBrandId: text().references((): AnyPgColumn => brands.id, { onDelete: 'restrict' }),

    // ── Scope (issue field 6) ────────────────────────────────────────────────
    /**
     * ISO 3166-1 alpha-2 markets. `'{}'` = WORLDWIDE, so an unscoped claim is
     * the broad one and a scoped claim is a deliberate narrowing.
     *
     * Shape-CHECKed rather than containment-CHECKed against a 249-code tuple, to
     * match `storefronts.country` — the sibling column that scopes the very same
     * markets one table over. Two different validations of one vocabulary inside
     * one graph is precisely the disagreement these conventions exist to prevent,
     * and the shape check is what rejects `Spain`, `es` and `ESP` alike.
     */
    territories: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Lowercased language subtags; `'{}'` = every language. Display scope only. */
    languages: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Narrowed to ONE channel of the merchant; NULL = all of them. */
    storefrontId: text().references(() => storefronts.id, { onDelete: 'restrict' }),

    // ── Temporal validity (issue field 7) ────────────────────────────────────
    validFrom: timestamptz()
      .notNull()
      .default(sql`date_trunc('milliseconds', now())`),
    /** NULL = still open. A closed row is history and is never deleted. */
    validTo: timestamptz(),

    // ── The verdict, and the machine number that is NOT it (fields 4 and 5) ──
    status: text({ enum: asEnumValues(RELATIONSHIP_VERIFICATION_STATES) })
      .notNull()
      .default('candidate'),
    verificationMethod: text({ enum: asEnumValues(RELATIONSHIP_VERIFICATION_METHODS) }),
    /**
     * 0–1 machine-matching confidence. NULL on deterministic and human rows —
     * and CHECKed to appear only on rows an ingestion source asserted, so no
     * amount of confidence can read as a weak form of verification.
     */
    confidence: doublePrecision(),

    // ── Source, actor and review audit trail (issue field 9) ─────────────────
    assertedByKind: text({ enum: asEnumValues(RELATIONSHIP_ASSERTED_BY_KINDS) }).notNull(),
    /** The catalog source behind an ingested row; NULL on every other kind. */
    assertedBySourceId: text().references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    createdByOxyUserId: text(),
    /**
     * The four-eyes generation. Endorsements are unique per (relationship,
     * round, operator), and every terminal decision increments the round — so an
     * approval cannot be reused across two different decisions, and a single
     * operator cannot approve twice to satisfy a two-operator rule.
     */
    reviewRound: integer().notNull().default(0),

    // ── Timestamps (issue field 10) ──────────────────────────────────────────
    verifiedAt: timestamptz(),
    /** An Oxy account id — no foreign key. Who put their name to the verdict. */
    verifiedByOxyUserId: text(),
    /**
     * When the claim was last RE-CHECKED against its evidence. Distinct from
     * `verified_at` (when the verdict was made) and from `updated_at` (any write
     * at all): a claim verified two years ago and re-checked last week is a
     * different fact from one nobody has looked at since, and collapsing them
     * would make one of the two a lie.
     */
    lastCheckedAt: timestamptz(),
    rejectedAt: timestamptz(),
    expiredAt: timestamptz(),
    revokedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokeReason: text(),

    /**
     * The correction chain. A correction never edits a row into a different
     * meaning: it closes this one and opens a new one, and this pointer is how
     * the two are read as one history. RESTRICT — the successor cannot vanish
     * from under the row that names it.
     */
    supersededById: text().references((): AnyPgColumn => commerceRelationships.id, {
      onDelete: 'restrict',
    }),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The duplicate-prevention key, GENERATED so no write path can supply one
     * that disagrees with the endpoints it claims to summarise. `coalesce` and
     * `||` are both IMMUTABLE, which a stored generated column requires.
     *
     * The separator is `|`, a character no uuid v7 or ObjectId hex contains, so
     * two different endpoint sets cannot render to one key.
     */
    endpointKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("organization_id", '') || '|' || coalesce("brand_id", '') || '|' ||
            coalesce("merchant_id", '') || '|' || coalesce("product_family_id", '') || '|' ||
            coalesce("related_brand_id", '') || '|' || coalesce("storefront_id", '')`,
      ),
  },
  (t) => [
    checkOneOf('commerce_relationships_kind_check', t.kind, RELATIONSHIP_KINDS),
    checkOneOf('commerce_relationships_status_check', t.status, RELATIONSHIP_VERIFICATION_STATES),
    checkOneOf(
      'commerce_relationships_verification_method_check',
      t.verificationMethod,
      RELATIONSHIP_VERIFICATION_METHODS,
    ),
    checkOneOf(
      'commerce_relationships_asserted_by_kind_check',
      t.assertedByKind,
      RELATIONSHIP_ASSERTED_BY_KINDS,
    ),
    /**
     * The subject/object entity-kind constraint, per kind. `else false` is the
     * load-bearing branch: an unrecognised kind is unrepresentable even with the
     * kind CHECK dropped, so widening the tuple without widening this CHECK
     * fails the first write instead of admitting an endpoint-less row.
     */
    check(
      'commerce_relationships_endpoints_check',
      sql`case ${t.kind}
        when 'organization_owns_brand' then
          ${t.organizationId} is not null and ${t.brandId} is not null
          and ${t.merchantId} is null and ${t.productFamilyId} is null and ${t.relatedBrandId} is null
        when 'organization_operates_merchant' then
          ${t.organizationId} is not null and ${t.merchantId} is not null
          and ${t.brandId} is null and ${t.productFamilyId} is null and ${t.relatedBrandId} is null
        when 'organization_manufactures' then
          ${t.organizationId} is not null and ${t.productFamilyId} is not null
          and ${t.brandId} is null and ${t.merchantId} is null and ${t.relatedBrandId} is null
        when 'merchant_official_channel_for_brand' then
          ${t.merchantId} is not null and ${t.brandId} is not null
          and ${t.organizationId} is null and ${t.productFamilyId} is null and ${t.relatedBrandId} is null
        when 'merchant_authorized_reseller_for_brand' then
          ${t.merchantId} is not null and ${t.brandId} is not null
          and ${t.organizationId} is null and ${t.productFamilyId} is null and ${t.relatedBrandId} is null
        when 'brand_succeeds_brand' then
          ${t.brandId} is not null and ${t.relatedBrandId} is not null
          and ${t.organizationId} is null and ${t.merchantId} is null and ${t.productFamilyId} is null
        else false
      end`,
    ),
    // A brand cannot succeed itself, and a correction cannot supersede itself.
    check(
      'commerce_relationships_distinct_brands_check',
      sql`${t.relatedBrandId} is null or ${t.relatedBrandId} <> ${t.brandId}`,
    ),
    check(
      'commerce_relationships_supersedes_other_check',
      sql`${t.supersededById} is null or ${t.supersededById} <> ${t.id}`,
    ),
    // Storefront scope belongs only to kinds whose subject is a merchant or the
    // organization operating one; a brand-ownership claim has no channel.
    check(
      'commerce_relationships_storefront_scope_check',
      sql`${t.storefrontId} is null or ${t.kind} in (
        'organization_operates_merchant',
        'merchant_official_channel_for_brand',
        'merchant_authorized_reseller_for_brand'
      )`,
    ),
    // A verified row without a method or a time is a verdict nobody can audit.
    check(
      'commerce_relationships_verified_state_check',
      sql`${t.status} <> 'verified' or (${t.verificationMethod} is not null and ${t.verifiedAt} is not null and ${t.verifiedByOxyUserId} is not null)`,
    ),
    check(
      'commerce_relationships_confidence_range_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    // Confidence is a MACHINE's number. A human or platform verdict carrying one
    // would invite reading it as a strength of verification, which it is not.
    check(
      'commerce_relationships_confidence_machine_check',
      sql`${t.confidence} is null or ${t.assertedByKind} = 'ingestion_source'`,
    ),
    // An ingested row names its source; nothing else may claim one.
    check(
      'commerce_relationships_source_presence_check',
      sql`(${t.assertedByKind} = 'ingestion_source') = (${t.assertedBySourceId} is not null)`,
    ),
    check(
      'commerce_relationships_validity_order_check',
      sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),
    // Both endings close the window AND stamp their own time, so "no longer
    // current" is true in the temporal read as well as in the status column.
    check(
      'commerce_relationships_expired_state_check',
      sql`${t.status} <> 'expired' or (${t.expiredAt} is not null and ${t.validTo} is not null)`,
    ),
    check(
      'commerce_relationships_revoked_state_check',
      sql`${t.status} <> 'revoked' or (${t.revokedAt} is not null and ${t.revokedByOxyUserId} is not null and ${t.validTo} is not null)`,
    ),
    check(
      'commerce_relationships_rejected_state_check',
      sql`${t.status} <> 'rejected' or ${t.rejectedAt} is not null`,
    ),
    // ISO 3166-1 alpha-2 shape, element by element, without `unnest` (a CHECK may
    // contain no subquery). `mercaria_immutable_array_to_string` is the narrowed
    // IMMUTABLE wrapper migration 0006 declared for exactly this reason.
    check(
      'commerce_relationships_territories_shape_check',
      sql`mercaria_immutable_array_to_string(${t.territories}, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'`,
    ),
    check(
      'commerce_relationships_languages_shape_check',
      sql`mercaria_immutable_array_to_string(${t.languages}, ',') ~ '^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)*)?$'`,
    ),
    check('commerce_relationships_review_round_check', sql`${t.reviewRound} >= 0`),

    /**
     * ≤1 OPEN row per (kind, endpoints, storefront scope) — ADR 0002 D17/D20.
     * On the GENERATED key rather than the raw columns, because Postgres treats
     * NULLs as distinct and the raw form would admit the duplicates it exists to
     * refuse.
     */
    uniqueIndex('commerce_relationships_open_claim_key')
      .on(t.kind, t.endpointKey)
      .where(sql`${t.validTo} is null`),
    /**
     * ≤1 CURRENT VERIFIED owner per brand (D20). Two organizations may both hold
     * a candidate — that is the dispute an operator resolves — but only one may
     * hold the verified answer, and the database is what says so.
     */
    uniqueIndex('commerce_relationships_verified_brand_owner_key')
      .on(t.brandId)
      .where(
        sql`${t.kind} = 'organization_owns_brand' and ${t.status} = 'verified' and ${t.validTo} is null`,
      ),

    index('commerce_relationships_brand_idx').on(t.brandId, t.kind, t.status),
    index('commerce_relationships_merchant_idx').on(t.merchantId, t.kind, t.status),
    index('commerce_relationships_organization_idx').on(t.organizationId, t.kind, t.status),
    index('commerce_relationships_product_family_idx').on(t.productFamilyId, t.kind, t.status),
    // The operator candidate queue's own order: oldest waiting first.
    index('commerce_relationships_review_queue_idx').on(t.status, t.createdAt),
  ],
);

/**
 * `relationship_evidence` — the durable proof rows, and the ONLY path to
 * `verified` (ADR 0002 D17).
 *
 * Each proof is a TYPED ROW, never a jsonb blob: the fields a reviewer and a
 * later re-check need — what was observed, where, when, in which locale, and the
 * digest of the content — are queryable and constrainable, and a shape a newer
 * source adds is a column decision rather than a silent extra key.
 *
 * `relationship_id` is RESTRICT even though evidence is a child: audit rows must
 * be able to BLOCK a delete, not vanish with the row they justify (D20). And
 * revoking or expiring evidence never deletes it — `status` moves, the row and
 * its timestamps stay, so the history of a relationship that was once verified
 * remains readable after the proof behind it lapsed.
 */
export const relationshipEvidence = pgTable(
  'relationship_evidence',
  {
    id: generatedId(),
    relationshipId: text()
      .notNull()
      .references(() => commerceRelationships.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(RELATIONSHIP_EVIDENCE_KINDS) }).notNull(),
    status: text({ enum: asEnumValues(RELATIONSHIP_EVIDENCE_STATUSES) })
      .notNull()
      .default('active'),
    /** What was actually observed, in words. The claim this row supports. */
    observedFact: text().notNull(),
    /**
     * The hostname a `domain_control` row proves control OF — mandatory for that
     * kind and forbidden on every other. Naming it is what keeps the proof
     * honest: control of this hostname is the whole content of the evidence, and
     * a row that cannot say which hostname could be read as proving anything.
     */
    subjectDomain: text(),
    sourceUrl: text(),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    oxyFileId: text(),
    /** Hex sha-256 of the fetched content, so the claim survives the page changing. */
    contentSha256: text(),
    /**
     * The observation this evidence came from, when it was imported. RESTRICT:
     * provenance must be able to block a delete, not vanish with it (D19).
     */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** BCP-47 tag of the material observed — a reseller list differs per locale. */
    locale: text(),
    /** When the fact was observed in the world — may predate this row. */
    observedAt: timestamptz().notNull(),
    collectedAt: timestamptz()
      .notNull()
      .default(sql`date_trunc('milliseconds', now())`),
    /** An Oxy account id — no foreign key. NULL for machine collection. */
    collectedByOxyUserId: text(),
    reviewerNote: text(),
    /** When this proof stops standing on its own — a dated brand statement, say. */
    expiresAt: timestamptz(),
    revokedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokeReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('relationship_evidence_kind_check', t.kind, RELATIONSHIP_EVIDENCE_KINDS),
    checkOneOf('relationship_evidence_status_check', t.status, RELATIONSHIP_EVIDENCE_STATUSES),
    // ADR 0002 D17: a brand statement carries the URL AND the digest, so the
    // claim survives the page being edited under it.
    check(
      'relationship_evidence_brand_statement_check',
      sql`${t.kind} <> 'brand_statement' or (${t.sourceUrl} is not null and ${t.contentSha256} is not null)`,
    ),
    check(
      'relationship_evidence_domain_subject_check',
      sql`(${t.kind} = 'domain_control') = (${t.subjectDomain} is not null)`,
    ),
    check(
      'relationship_evidence_domain_normalized_check',
      sql`${t.subjectDomain} is null or ${t.subjectDomain} = lower(btrim(${t.subjectDomain}))`,
    ),
    check(
      'relationship_evidence_sha256_shape_check',
      sql`${t.contentSha256} is null or ${t.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    // Everything but an operator's own attestation must point SOMEWHERE. An
    // attestation is a named person's word and is the one kind with no locator.
    check(
      'relationship_evidence_locator_check',
      sql`${t.kind} = 'operator_attestation'
        or ${t.sourceUrl} is not null
        or ${t.oxyFileId} is not null
        or ${t.sourceRecordId} is not null
        or ${t.subjectDomain} is not null`,
    ),
    check(
      'relationship_evidence_revoked_state_check',
      sql`${t.status} <> 'revoked' or (${t.revokedAt} is not null and ${t.revokedByOxyUserId} is not null)`,
    ),
    check(
      'relationship_evidence_expired_state_check',
      sql`${t.status} <> 'expired' or ${t.expiresAt} is not null`,
    ),
    check(
      'relationship_evidence_observed_fact_check',
      sql`btrim(${t.observedFact}) <> ''`,
    ),
    index('relationship_evidence_relationship_idx').on(t.relationshipId, t.status),
    index('relationship_evidence_source_record_idx')
      .on(t.sourceRecordId)
      .where(sql`${t.sourceRecordId} is not null`),
  ],
);

/**
 * `relationship_reviews` — every operator ACTION, append-only.
 *
 * The `payment_repairs` discipline, applied to the catalogue: one row per
 * attempt, a mandatory actor and a mandatory reason, refusals included. There is
 * no `updated_at` and a trigger refuses UPDATE and DELETE, so the audit trail is
 * immutable by construction rather than by nobody having written the UPDATE yet.
 *
 * ### It is also the FOUR-EYES mechanism, not just its record
 *
 * `UNIQUE(relationship_id, review_round, actor_oxy_user_id) WHERE action =
 * 'approve'` means one operator may endorse a given round exactly once. A
 * high-impact verification therefore needs two DISTINCT operators to have
 * endorsed the CURRENT round, and the database is what refuses the second
 * endorsement from the same person — not a service-side comparison that a later
 * code path could forget to make. Every terminal decision increments the round,
 * so approvals cannot be carried over into a decision they were not given for.
 */
export const relationshipReviews = pgTable(
  'relationship_reviews',
  {
    id: generatedId(),
    relationshipId: text()
      .notNull()
      .references(() => commerceRelationships.id, { onDelete: 'restrict' }),
    action: text({ enum: asEnumValues(RELATIONSHIP_REVIEW_ACTIONS) }).notNull(),
    /** An Oxy account id — no foreign key. MANDATORY: an unattributed review is none. */
    actorOxyUserId: text().notNull(),
    reason: text().notNull(),
    reviewRound: integer().notNull(),
    fromStatus: text({ enum: asEnumValues(RELATIONSHIP_VERIFICATION_STATES) }).notNull(),
    /** NULL when the action records an endorsement that did not itself move the status. */
    toStatus: text({ enum: asEnumValues(RELATIONSHIP_VERIFICATION_STATES) }),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('relationship_reviews_action_check', t.action, RELATIONSHIP_REVIEW_ACTIONS),
    checkOneOf(
      'relationship_reviews_from_status_check',
      t.fromStatus,
      RELATIONSHIP_VERIFICATION_STATES,
    ),
    checkOneOf(
      'relationship_reviews_to_status_check',
      t.toStatus,
      RELATIONSHIP_VERIFICATION_STATES,
    ),
    check('relationship_reviews_reason_check', sql`btrim(${t.reason}) <> ''`),
    check('relationship_reviews_actor_check', sql`btrim(${t.actorOxyUserId}) <> ''`),
    check('relationship_reviews_review_round_check', sql`${t.reviewRound} >= 0`),
    uniqueIndex('relationship_reviews_approval_key')
      .on(t.relationshipId, t.reviewRound, t.actorOxyUserId)
      .where(sql`${t.action} = 'approve'`),
    index('relationship_reviews_relationship_idx').on(t.relationshipId, t.createdAt),
  ],
);
