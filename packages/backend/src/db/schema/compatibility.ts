/**
 * Compatibility and automotive fitment — issue #367 merge-order step 8, bound by
 * ADR 0007 **D8**: `generic_compatibility_relations`, `compatibility_claims`,
 * `vehicle_makes`, `vehicle_models`, `vehicle_generations`,
 * `vehicle_configurations` and `automotive_fitments`.
 *
 * Seven tables, and the shape of every one of them follows from one sentence in
 * D8: **a year range, a make or a model may never be stored as a variant
 * option.** A brake pad that fits a thousand vehicles is ONE variant with a
 * thousand relationship rows, not a thousand variants. Everything below is what
 * that costs and what it buys.
 *
 * ## Four properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **Nothing here can write a variant option.** Not because a rule says so —
 *    because this file imports `canonical_products`, `canonical_variants` and
 *    `canonical_product_families` and does NOT import `listing_options` or
 *    `product_variant_option_values`, and no repository in `db/compatibility/`
 *    names either table. `compatibility-isolation.test.ts` fails the build on
 *    the day one does, and separately walks the real drizzle columns of both
 *    option tables asserting none is named for a vehicle fact.
 * 2. **Unknown is a VALUE, not a NULL.** `applicability` is NOT NULL on both
 *    relation tables and carries all four members of
 *    `COMPATIBILITY_APPLICABILITIES`. A nullable boolean would make "we have no
 *    data" and "it does not fit" the same row, and the second of those is a
 *    statement a shopper acts on.
 * 3. **A claim and a selected fact are different rows** (D7). `compatibility_claims`
 *    keeps the source's own words — including a target it could not resolve —
 *    and points at the canonical row it was selected into, or at nothing.
 *    A partial unique holds at most ONE selected claim per canonical row, so
 *    "which claim is this fact" has one answer and the canonical table needs no
 *    back-pointer (which would be the circular foreign key `drizzle-kit generate`
 *    silently drops — measured in #66).
 * 4. **A duplicate open relation is impossible, not refused.** `relation_key` is
 *    GENERATED from the five endpoint columns plus the kind, and the partial
 *    unique `WHERE valid_to IS NULL` is taken on it. A plain multi-column unique
 *    would NOT work: Postgres treats NULLs as distinct, so two rows with
 *    identical non-null endpoints and NULL elsewhere would both be admitted —
 *    #55's finding, and the same fix.
 *
 * ## What is deliberately NOT here
 *
 * - **No evidence table.** #55 has one because a brand relationship's proof is a
 *   document with a digest that outlives the claim. A compatibility claim's
 *   evidence IS the claim: what a source said, where, when, and with what raw
 *   text. Splitting it would put the same provenance on two rows.
 * - **No label on any vehicle record beyond `name`.** Localized display belongs
 *   to the localization family (D4), which is merge-order step 2 and a different
 *   module. `name` here is the base name, exactly as `canonical_products.name`
 *   is, and a second display column would be a second identity.
 * - **No `is_exclusion` boolean and no exclusions table.** An exclusion is a
 *   fitment row at a NARROWER scope whose `applicability` is `does_not_apply`;
 *   `resolveFitment` is the ordering that makes it bite. One mechanism.
 * - **No jsonb**, so this domain adds no row to CONVENTIONS' jsonb register.
 *   Every condition, qualifier and position is a real column or a CHECKed array.
 * - **No VIN, plate, owner or buyer column.** A VIN identifies one physical car
 *   with a person attached; `COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS` names it and
 *   there is no column any writer could put one in.
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
  COMPATIBILITY_APPLICABILITIES,
  COMPATIBILITY_ASSERTED_BY_KINDS,
  COMPATIBILITY_CLAIM_STATES,
  COMPATIBILITY_CONDITION_KINDS,
  COMPATIBILITY_DIRECTIONS,
  COMPATIBILITY_RELATION_KINDS,
  COMPATIBILITY_TARGET_KINDS,
  COMPATIBILITY_UNRESOLVED_REASONS,
  COMPATIBILITY_VERIFICATION_METHODS,
  COMPATIBILITY_VERIFICATION_STATES,
  FITMENT_POSITIONS,
  FITMENT_QUALIFIERS,
  FITMENT_TARGET_SCOPES,
  TYPED_COMPATIBILITY_TARGET_KEY_PATTERN,
  TYPED_COMPATIBILITY_TARGET_TYPES,
  VEHICLE_BODY_STYLES,
  VEHICLE_DRIVETRAINS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_MAX_YEAR,
  VEHICLE_MIN_YEAR,
  VEHICLE_RECORD_STATUSES,
  VEHICLE_TRANSMISSIONS,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import {
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariants,
} from './canonicalCatalog';
import { catalogSources, sourceRecords } from './provenance';

/**
 * The stable machine key shape every vehicle record carries (ADR 0007 D1).
 *
 * Lowercase, `_`-separated segments: `volkswagen`, `golf_gti`, `mk7_facelift`.
 * Stated once and read by all four vehicle tables' CHECKs, because four
 * hand-written copies of one pattern is four chances to admit `Golf GTI` into a
 * column whose entire job is to be citable from a seed file.
 */
const VEHICLE_KEY_PATTERN = '^[a-z0-9]+(_[a-z0-9]+)*$';

/** A model-year column bounded to a year a car could have (see `VEHICLE_MIN_YEAR`). */
function yearRangeCheck(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`${column} is null or (${column} >= ${sql.raw(String(VEHICLE_MIN_YEAR))} and ${column} <= ${sql.raw(String(VEHICLE_MAX_YEAR))})`,
  );
}

// ---------------------------------------------------------------------------
// Generic compatibility
// ---------------------------------------------------------------------------

/**
 * `generic_compatibility_relations` — the SELECTED canonical answer to "does
 * this go with that" (ADR 0007 D8, first paragraph).
 *
 * ## The endpoint columns, and why the subject is two and the target is four
 *
 * A subject is always a Mercaria catalogue identity, at one of two grains: a
 * PRODUCT ("AirPods cases fit AirPods Pro") or a VARIANT ("this 2 m cable fits
 * …", where the length is the variant). Exactly one is set, by CHECK.
 *
 * A target is one of the same two grains, plus a FAMILY (an accessory that fits
 * every phone in a line) plus a TYPED target for the very large class of
 * compatibility facts whose other end is not a product: a connector standard, a
 * lamp socket, a capsule system. Minting canonical products for those would put
 * catalogue entities nobody sells into the graph — and then into search, into
 * matching and into the merge census.
 *
 * `target_kind` is a stored discriminant rather than a derivation over the four
 * nullable columns, for the reason `orders` carries one: the CHECK below reads
 * it in a `case`, so an unrecognised kind is unrepresentable (`else false`) even
 * with the kind CHECK dropped, and widening the tuple without widening this
 * CHECK fails the first write rather than admitting an endpoint-less row.
 *
 * ## Reverse lookup is an INDEX, not a second row
 *
 * D8 asks that "accessories compatible with this product" be an indexed read.
 * Four target-side indexes below serve it — one per target kind, each leading
 * with the target id and carrying the kind and the verification state, so the
 * common read ("verified accessories for this product") is a single index scan
 * rather than a scan plus a filter. The subject side has its own two, for the
 * forward question ("what does this case fit"). Six indexes on one table is a
 * lot, and it is the cost of a relation that is genuinely read from both ends.
 */
export const genericCompatibilityRelations = pgTable(
  'generic_compatibility_relations',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(COMPATIBILITY_RELATION_KINDS) }).notNull(),
    direction: text({ enum: asEnumValues(COMPATIBILITY_DIRECTIONS) })
      .notNull()
      .default('subject_to_target'),

    // ── Subject: exactly one, by CHECK ───────────────────────────────────────
    /**
     * RESTRICT throughout this file. A compatibility relation is a curated fact
     * with provenance and a review history behind it; cascading it away with a
     * canonical merge's loser would delete evidence, and #59's merge plan is the
     * mechanism that moves it deliberately instead.
     */
    subjectProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    subjectVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),

    // ── Target: exactly one, decided by `target_kind` ────────────────────────
    targetKind: text({ enum: asEnumValues(COMPATIBILITY_TARGET_KINDS) }).notNull(),
    targetFamilyId: text().references(() => canonicalProductFamilies.id, { onDelete: 'restrict' }),
    targetProductId: text().references((): AnyPgColumn => canonicalProducts.id, {
      onDelete: 'restrict',
    }),
    targetVariantId: text().references((): AnyPgColumn => canonicalVariants.id, {
      onDelete: 'restrict',
    }),
    /** A closed class of non-catalogue target; NULL unless `target_kind = 'typed'`. */
    targetType: text({ enum: asEnumValues(TYPED_COMPATIBILITY_TARGET_TYPES) }),
    /** The typed target's stable machine key (D1) — `connector.usb_c`. NEVER a label. */
    targetKey: text(),

    // ── The answer ───────────────────────────────────────────────────────────
    /**
     * Four-valued and NOT NULL. `unknown` is a stored verdict — a relation an
     * operator has opened and not yet answered — and is a different row from no
     * relation at all, which is why it is worth storing: the second is silence
     * and the first is a queue item.
     */
    applicability: text({ enum: asEnumValues(COMPATIBILITY_APPLICABILITIES) })
      .notNull()
      .default('unknown'),
    /**
     * The closed condition vocabulary. `'{}'` means unconditional, which is a
     * positive fact a filter reads, not an absence.
     */
    conditionKinds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The human sentence beside the conditions — presentation, never the fact. */
    conditionNote: text(),

    // ── Scope ────────────────────────────────────────────────────────────────
    /**
     * ISO 3166-1 alpha-2. `'{}'` = WORLDWIDE — the #55 posture, so an unscoped
     * claim is the broad one and a scoped claim is a deliberate narrowing.
     * Shape-CHECKed element by element rather than against a 249-code tuple, to
     * match `commerce_relationships.territories`, the sibling column scoping the
     * very same markets one domain over.
     */
    markets: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    validFrom: timestamptz()
      .notNull()
      .default(sql`date_trunc('milliseconds', now())`),
    /** NULL = still open. A closed row is history and is never deleted. */
    validTo: timestamptz(),

    // ── Verification, and the machine number that is NOT it ──────────────────
    verification: text({ enum: asEnumValues(COMPATIBILITY_VERIFICATION_STATES) })
      .notNull()
      .default('candidate'),
    verificationMethod: text({ enum: asEnumValues(COMPATIBILITY_VERIFICATION_METHODS) }),
    assertedByKind: text({ enum: asEnumValues(COMPATIBILITY_ASSERTED_BY_KINDS) }).notNull(),
    /** The catalog source behind an ingested relation; NULL on every other kind. */
    assertedBySourceId: text().references(() => catalogSources.id, { onDelete: 'restrict' }),
    /**
     * 0–1 machine confidence, and CHECKed to appear ONLY on rows a machine
     * asserted — #55's `confidence_machine_check`, for the same reason: no
     * amount of confidence may read as a weak form of verification. A relation
     * a person verified therefore carries none at all.
     */
    confidence: doublePrecision(),

    verifiedAt: timestamptz(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    verifiedByOxyUserId: text(),
    /** When the claim was last RE-CHECKED against its sources. Not `verified_at`. */
    lastCheckedAt: timestamptz(),
    revokedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokeReason: text(),
    /**
     * The correction chain. A correction closes this row and opens a new one;
     * RESTRICT, so the successor cannot vanish from under the row naming it.
     */
    supersededById: text().references((): AnyPgColumn => genericCompatibilityRelations.id, {
      onDelete: 'restrict',
    }),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The duplicate-prevention key, GENERATED so no write path can supply one
     * that disagrees with the endpoints it summarises. `coalesce` and `||` are
     * both IMMUTABLE, which a stored generated column requires. The separator is
     * `|`, which no uuid v7, ObjectId hex or vehicle key contains, so two
     * different endpoint sets cannot render to one key.
     *
     * **A `merge-plan.ts` `uniqueWith` must NEVER name this column.** The unique
     * is taken on it, so naming it reads as the exact statement of the
     * constraint — and measures nothing: the key CONTAINS the id a merge moves,
     * so the pre-move key can never equal the winner's, the guard never fires,
     * and the collision lands as a 23505 that fails the phase. Name the RAW
     * components minus the one moving; `docs/compatibility.md` §"The merge plan"
     * carries the measurement.
     */
    relationKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("subject_product_id", '') || '|' || coalesce("subject_variant_id", '') || '|' ||
            coalesce("target_family_id", '') || '|' || coalesce("target_product_id", '') || '|' ||
            coalesce("target_variant_id", '') || '|' || coalesce("target_type", '') || '|' ||
            coalesce("target_key", '')`,
      ),
  },
  (t) => [
    checkOneOf('generic_compatibility_relations_kind_check', t.kind, COMPATIBILITY_RELATION_KINDS),
    checkOneOf(
      'generic_compatibility_relations_direction_check',
      t.direction,
      COMPATIBILITY_DIRECTIONS,
    ),
    checkOneOf(
      'generic_compatibility_relations_target_kind_check',
      t.targetKind,
      COMPATIBILITY_TARGET_KINDS,
    ),
    checkOneOf(
      'generic_compatibility_relations_applicability_check',
      t.applicability,
      COMPATIBILITY_APPLICABILITIES,
    ),
    checkOneOf(
      'generic_compatibility_relations_verification_check',
      t.verification,
      COMPATIBILITY_VERIFICATION_STATES,
    ),
    checkOneOf(
      'generic_compatibility_relations_verification_method_check',
      t.verificationMethod,
      COMPATIBILITY_VERIFICATION_METHODS,
    ),
    checkOneOf(
      'generic_compatibility_relations_asserted_by_kind_check',
      t.assertedByKind,
      COMPATIBILITY_ASSERTED_BY_KINDS,
    ),
    checkOneOf(
      'generic_compatibility_relations_target_type_check',
      t.targetType,
      TYPED_COMPATIBILITY_TARGET_TYPES,
    ),
    checkEveryElementOf(
      'generic_compatibility_relations_condition_kinds_check',
      t.conditionKinds,
      COMPATIBILITY_CONDITION_KINDS,
    ),
    // Exactly ONE subject grain. `num_nonnulls` states it in one expression that
    // cannot drift as columns are added, unlike a hand-written pair of `is null`s.
    check(
      'generic_compatibility_relations_subject_check',
      sql`num_nonnulls(${t.subjectProductId}, ${t.subjectVariantId}) = 1`,
    ),
    /**
     * The target shape, per kind. `else false` is the load-bearing branch: an
     * unrecognised kind is unrepresentable even with the kind CHECK dropped, so
     * widening the tuple without widening this CHECK fails the first write
     * instead of admitting a target-less row.
     */
    check(
      'generic_compatibility_relations_target_check',
      sql`case ${t.targetKind}
        when 'canonical_family' then
          ${t.targetFamilyId} is not null and ${t.targetProductId} is null
          and ${t.targetVariantId} is null and ${t.targetType} is null and ${t.targetKey} is null
        when 'canonical_product' then
          ${t.targetProductId} is not null and ${t.targetFamilyId} is null
          and ${t.targetVariantId} is null and ${t.targetType} is null and ${t.targetKey} is null
        when 'canonical_variant' then
          ${t.targetVariantId} is not null and ${t.targetFamilyId} is null
          and ${t.targetProductId} is null and ${t.targetType} is null and ${t.targetKey} is null
        when 'typed' then
          ${t.targetType} is not null and ${t.targetKey} is not null
          and ${t.targetFamilyId} is null and ${t.targetProductId} is null and ${t.targetVariantId} is null
        else false
      end`,
    ),
    // A typed target's key is a KEY (D1). A CHECK on the shape is what stops
    // `USB-C (male)` being stored in the column that seeds and mappings cite.
    check(
      'generic_compatibility_relations_target_key_shape_check',
      sql`${t.targetKey} is null or ${t.targetKey} ~ ${sql.raw(`'${TYPED_COMPATIBILITY_TARGET_KEY_PATTERN}'`)}`,
    ),
    // Nothing is compatible with itself, at either grain. Both directions are
    // written out because either column may be the one that is set.
    check(
      'generic_compatibility_relations_distinct_endpoints_check',
      sql`(${t.subjectProductId} is null or ${t.targetProductId} is null or ${t.subjectProductId} <> ${t.targetProductId})
        and (${t.subjectVariantId} is null or ${t.targetVariantId} is null or ${t.subjectVariantId} <> ${t.targetVariantId})`,
    ),
    check(
      'generic_compatibility_relations_supersedes_other_check',
      sql`${t.supersededById} is null or ${t.supersededById} <> ${t.id}`,
    ),
    /**
     * `partially_applies` without a condition is a claim that says it is
     * qualified and never says how — which renders as a bare warning a shopper
     * cannot act on. `cardinality`, never `array_length`: the latter is NULL on
     * an empty array and a CHECK rejects only FALSE, so `array_length(...) >= 1`
     * ADMITS `{}` — measured twice in this schema already (#68).
     */
    check(
      'generic_compatibility_relations_partial_condition_check',
      sql`${t.applicability} <> 'partially_applies'
        or cardinality(${t.conditionKinds}) >= 1
        or ${t.conditionNote} is not null`,
    ),
    // A verified row without a method or an attributable time is a verdict
    // nobody can audit.
    check(
      'generic_compatibility_relations_verified_state_check',
      sql`${t.verification} <> 'verified'
        or (${t.verificationMethod} is not null and ${t.verifiedAt} is not null and ${t.verifiedByOxyUserId} is not null)`,
    ),
    check(
      'generic_compatibility_relations_revoked_state_check',
      sql`${t.verification} <> 'revoked'
        or (${t.revokedAt} is not null and ${t.revokedByOxyUserId} is not null and ${t.validTo} is not null)`,
    ),
    check(
      'generic_compatibility_relations_confidence_range_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    // Confidence is a MACHINE's number (#55's rule, restated for this domain's
    // two machine kinds).
    check(
      'generic_compatibility_relations_confidence_machine_check',
      sql`${t.confidence} is null or ${t.assertedByKind} in ('catalog_source', 'matcher')`,
    ),
    // An ingested row names its source; nothing else may claim one.
    check(
      'generic_compatibility_relations_source_presence_check',
      sql`(${t.assertedByKind} = 'catalog_source') = (${t.assertedBySourceId} is not null)`,
    ),
    check(
      'generic_compatibility_relations_validity_order_check',
      sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),
    // ISO 3166-1 alpha-2 shape, element by element, without `unnest` (a CHECK may
    // hold no subquery). `mercaria_immutable_array_to_string` is the narrowed
    // IMMUTABLE wrapper migration 0006 declared for exactly this.
    check(
      'generic_compatibility_relations_markets_shape_check',
      sql`mercaria_immutable_array_to_string(${t.markets}, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'`,
    ),

    /**
     * ≤1 OPEN relation per (kind, endpoints). On the GENERATED key rather than
     * the raw columns, because Postgres treats NULLs as distinct and the raw
     * form would admit exactly the duplicates this index exists to refuse.
     */
    uniqueIndex('generic_compatibility_relations_open_key')
      .on(t.kind, t.relationKey)
      .where(sql`${t.validTo} is null`),

    // ── Reverse lookup (D8: an indexed read, never a scan) ───────────────────
    index('generic_compatibility_relations_target_product_idx')
      .on(t.targetProductId, t.kind, t.verification)
      .where(sql`${t.targetProductId} is not null`),
    index('generic_compatibility_relations_target_variant_idx')
      .on(t.targetVariantId, t.kind, t.verification)
      .where(sql`${t.targetVariantId} is not null`),
    index('generic_compatibility_relations_target_family_idx')
      .on(t.targetFamilyId, t.kind, t.verification)
      .where(sql`${t.targetFamilyId} is not null`),
    index('generic_compatibility_relations_target_typed_idx')
      .on(t.targetType, t.targetKey, t.kind, t.verification)
      .where(sql`${t.targetType} is not null`),
    // ── Forward lookup ──────────────────────────────────────────────────────
    index('generic_compatibility_relations_subject_product_idx')
      .on(t.subjectProductId, t.kind, t.verification)
      .where(sql`${t.subjectProductId} is not null`),
    index('generic_compatibility_relations_subject_variant_idx')
      .on(t.subjectVariantId, t.kind, t.verification)
      .where(sql`${t.subjectVariantId} is not null`),
    // The operator queue's own order: oldest unanswered first.
    index('generic_compatibility_relations_review_idx').on(t.verification, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Automotive reference data
// ---------------------------------------------------------------------------

/**
 * `vehicle_makes` — a manufacturer, as vehicle reference data.
 *
 * Deliberately NOT `brands` (#54/#55's table). A brand there is a commercial
 * identity that can be owned, claimed, verified and badged; a make here is a
 * classification node in a fitment tree, and a fitment claiming "fits Volkswagen"
 * asserts nothing about Volkswagen the organization and grants nobody standing.
 * Collapsing the two would make a vehicle-data import able to mint rows in the
 * table #55's badges are keyed on — and the reverse: a brand merge would rehome
 * fitments. Two tables, one `brand_id` pointer if that link is ever wanted, and
 * this issue does not add one because nothing reads it.
 */
export const vehicleMakes = pgTable(
  'vehicle_makes',
  {
    id: generatedId(),
    /** The stable machine key (D1), frozen by trigger. `volkswagen`. */
    key: text().notNull(),
    /** The base name. Localized display is D4's, in a different module. */
    name: text().notNull(),
    /** ISO 3166-1 alpha-2 of the manufacturer's home market; display only. */
    countryCode: text(),
    status: text({ enum: asEnumValues(VEHICLE_RECORD_STATUSES) }).notNull().default('active'),
    mergedIntoId: text().references((): AnyPgColumn => vehicleMakes.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('vehicle_makes_status_check', t.status, VEHICLE_RECORD_STATUSES),
    check('vehicle_makes_key_shape_check', sql`${t.key} ~ ${sql.raw(`'${VEHICLE_KEY_PATTERN}'`)}`),
    check('vehicle_makes_name_check', sql`btrim(${t.name}) <> ''`),
    check(
      'vehicle_makes_country_shape_check',
      sql`${t.countryCode} is null or ${t.countryCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'vehicle_makes_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'vehicle_makes_merged_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    uniqueIndex('vehicle_makes_key_key').on(t.key),
    index('vehicle_makes_status_idx').on(t.status, t.name),
  ],
);

/**
 * `vehicle_models` — one model line of one make.
 *
 * `UNIQUE(make_id, key)` rather than a global unique on `key`: `golf` is
 * Volkswagen's and nobody else's, but `focus`, `civic` and `500` are the kind of
 * name that recurs across manufacturers, and a global unique would make the
 * SECOND importer of a colliding name unable to store a real model at all — the
 * `product_variants.sku` finding (#296), which is the same question asked of a
 * different column: what does a legitimate second row look like?
 */
export const vehicleModels = pgTable(
  'vehicle_models',
  {
    id: generatedId(),
    makeId: text()
      .notNull()
      .references(() => vehicleMakes.id, { onDelete: 'restrict' }),
    key: text().notNull(),
    name: text().notNull(),
    status: text({ enum: asEnumValues(VEHICLE_RECORD_STATUSES) }).notNull().default('active'),
    mergedIntoId: text().references((): AnyPgColumn => vehicleModels.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('vehicle_models_status_check', t.status, VEHICLE_RECORD_STATUSES),
    check('vehicle_models_key_shape_check', sql`${t.key} ~ ${sql.raw(`'${VEHICLE_KEY_PATTERN}'`)}`),
    check('vehicle_models_name_check', sql`btrim(${t.name}) <> ''`),
    check(
      'vehicle_models_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'vehicle_models_merged_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    uniqueIndex('vehicle_models_make_key_key').on(t.makeId, t.key),
    index('vehicle_models_make_idx').on(t.makeId, t.status, t.name),
  ],
);

/**
 * `vehicle_generations` — one production run of a model.
 *
 * `produced_from_year` / `produced_to_year` are the MODEL's production span, and
 * they are a different fact from `vehicle_configurations`' own span. A generation
 * ran 2012–2019; the 2.0 TDI within it was offered 2012–2016 and the facelift
 * engine 2017–2019. Storing one range and deriving the other would make every
 * configuration inherit a span nobody offered it for, which is precisely what
 * puts a part on the wrong car.
 *
 * `produced_to_year` NULL means still in production. It is not "unknown" — a
 * generation whose end nobody knows is stored with a NULL end and a note, and the
 * fitment resolution treats an open range as open, which errs toward showing the
 * shopper a part they can check rather than hiding it.
 */
export const vehicleGenerations = pgTable(
  'vehicle_generations',
  {
    id: generatedId(),
    modelId: text()
      .notNull()
      .references(() => vehicleModels.id, { onDelete: 'restrict' }),
    key: text().notNull(),
    name: text().notNull(),
    /** The manufacturer's own chassis or platform code — `5G`, `W205`. Display and matching. */
    chassisCode: text(),
    producedFromYear: integer(),
    producedToYear: integer(),
    status: text({ enum: asEnumValues(VEHICLE_RECORD_STATUSES) }).notNull().default('active'),
    mergedIntoId: text().references((): AnyPgColumn => vehicleGenerations.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('vehicle_generations_status_check', t.status, VEHICLE_RECORD_STATUSES),
    check(
      'vehicle_generations_key_shape_check',
      sql`${t.key} ~ ${sql.raw(`'${VEHICLE_KEY_PATTERN}'`)}`,
    ),
    check('vehicle_generations_name_check', sql`btrim(${t.name}) <> ''`),
    yearRangeCheck('vehicle_generations_from_year_check', t.producedFromYear),
    yearRangeCheck('vehicle_generations_to_year_check', t.producedToYear),
    check(
      'vehicle_generations_year_order_check',
      sql`${t.producedFromYear} is null or ${t.producedToYear} is null or ${t.producedToYear} >= ${t.producedFromYear}`,
    ),
    check(
      'vehicle_generations_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'vehicle_generations_merged_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    uniqueIndex('vehicle_generations_model_key_key').on(t.modelId, t.key),
    index('vehicle_generations_model_idx').on(t.modelId, t.status, t.producedFromYear),
  ],
);

/**
 * `vehicle_configurations` — one buildable specification within a generation.
 *
 * Every discriminating column is NULLABLE and that is the design, not laxity: a
 * configuration imported from a feed that publishes engine and body but not
 * transmission is a real, useful row, and defaulting the missing one would put a
 * fabricated fact into the column a shopper filters on. "Unknown is not false"
 * applies to reference data as much as to a fit.
 *
 * `market` is a SINGLE ISO 3166-1 alpha-2 code, not an array, and the asymmetry
 * with `generic_compatibility_relations.markets` is deliberate: a relation's
 * markets scope where a CLAIM holds, while a configuration's market is part of
 * what the configuration IS — the US and European versions of one car are
 * genuinely different specifications with different parts. NULL means the
 * configuration is not market-specific.
 */
export const vehicleConfigurations = pgTable(
  'vehicle_configurations',
  {
    id: generatedId(),
    generationId: text()
      .notNull()
      .references(() => vehicleGenerations.id, { onDelete: 'restrict' }),
    key: text().notNull(),
    name: text().notNull(),
    /** This configuration's OWN availability span — see `vehicle_generations`. */
    yearFrom: integer(),
    yearTo: integer(),
    engineCode: text(),
    engineDisplacementCc: integer(),
    powerKw: integer(),
    fuelType: text({ enum: asEnumValues(VEHICLE_FUEL_TYPES) }),
    drivetrain: text({ enum: asEnumValues(VEHICLE_DRIVETRAINS) }),
    transmission: text({ enum: asEnumValues(VEHICLE_TRANSMISSIONS) }),
    bodyStyle: text({ enum: asEnumValues(VEHICLE_BODY_STYLES) }),
    doors: integer(),
    trim: text(),
    /** ISO 3166-1 alpha-2; NULL = not market-specific. See the doc above. */
    market: text(),
    status: text({ enum: asEnumValues(VEHICLE_RECORD_STATUSES) }).notNull().default('active'),
    mergedIntoId: text().references((): AnyPgColumn => vehicleConfigurations.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('vehicle_configurations_status_check', t.status, VEHICLE_RECORD_STATUSES),
    checkOneOf('vehicle_configurations_fuel_type_check', t.fuelType, VEHICLE_FUEL_TYPES),
    checkOneOf('vehicle_configurations_drivetrain_check', t.drivetrain, VEHICLE_DRIVETRAINS),
    checkOneOf('vehicle_configurations_transmission_check', t.transmission, VEHICLE_TRANSMISSIONS),
    checkOneOf('vehicle_configurations_body_style_check', t.bodyStyle, VEHICLE_BODY_STYLES),
    check(
      'vehicle_configurations_key_shape_check',
      sql`${t.key} ~ ${sql.raw(`'${VEHICLE_KEY_PATTERN}'`)}`,
    ),
    check('vehicle_configurations_name_check', sql`btrim(${t.name}) <> ''`),
    yearRangeCheck('vehicle_configurations_from_year_check', t.yearFrom),
    yearRangeCheck('vehicle_configurations_to_year_check', t.yearTo),
    check(
      'vehicle_configurations_year_order_check',
      sql`${t.yearFrom} is null or ${t.yearTo} is null or ${t.yearTo} >= ${t.yearFrom}`,
    ),
    check(
      'vehicle_configurations_displacement_check',
      sql`${t.engineDisplacementCc} is null or (${t.engineDisplacementCc} > 0 and ${t.engineDisplacementCc} <= 20000)`,
    ),
    check(
      'vehicle_configurations_power_check',
      sql`${t.powerKw} is null or (${t.powerKw} > 0 and ${t.powerKw} <= 2000)`,
    ),
    check(
      'vehicle_configurations_doors_check',
      sql`${t.doors} is null or (${t.doors} >= 1 and ${t.doors} <= 8)`,
    ),
    check(
      'vehicle_configurations_market_shape_check',
      sql`${t.market} is null or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'vehicle_configurations_merged_state_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check(
      'vehicle_configurations_merged_self_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    uniqueIndex('vehicle_configurations_generation_key_key').on(t.generationId, t.key),
    index('vehicle_configurations_generation_idx').on(t.generationId, t.status, t.yearFrom),
    // The vehicle picker's own read: narrow by generation, then by year.
    index('vehicle_configurations_year_idx').on(t.yearFrom, t.yearTo),
  ],
);

// ---------------------------------------------------------------------------
// Automotive fitment
// ---------------------------------------------------------------------------

/**
 * `automotive_fitments` — one statement that a part does (or does not) go on a
 * class of vehicle.
 *
 * ## Why a SCOPE column and four nullable targets rather than a configuration id
 *
 * A brake pad that fits an entire generation is one row here. Exploded to
 * configurations it is forty, which rot independently, disagree after the next
 * import, and make an exclusion ("but not the sport package") impossible to
 * express without editing all forty. The scope ladder in
 * `FITMENT_TARGET_SCOPES` is what lets the broad claim and the narrow exclusion
 * coexist, and `resolveFitment` is what makes the narrow one win.
 *
 * **This is also why there is no exclusions table and no `is_exclusion`
 * boolean.** An exclusion is a fitment row with `applicability = 'does_not_apply'`
 * at a narrower scope. One mechanism, one set of provenance columns, one review
 * path — and a positive statement that a part does NOT fit is exactly as
 * evidenced, verified and auditable as one that it does, which it would not be if
 * it lived in a thinner side table.
 *
 * ## The year override
 *
 * `year_from`/`year_to` narrow the target's own span. NULL means "the target's
 * span", not "every year": a fitment on a generation with no override applies for
 * as long as that generation ran, and the resolver reads the generation. Storing
 * a copy of the generation's years on every fitment would be the second
 * representation that disagrees after the first correction.
 */
export const automotiveFitments = pgTable(
  'automotive_fitments',
  {
    id: generatedId(),

    // ── Subject: exactly one grain, by CHECK ────────────────────────────────
    subjectProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    subjectVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),

    // ── Target: the scope decides which pointers are set ────────────────────
    scope: text({ enum: asEnumValues(FITMENT_TARGET_SCOPES) }).notNull(),
    /**
     * ALWAYS set, at every scope. Denormalized on purpose and it is the one
     * denormalization in this file: "which makes does this part cover" is the
     * first question a fitment surface asks, and without it that read is a
     * three-level join per row. It is also what makes the vehicle picker's top
     * level a single index scan. The trigger in `compatibility.pending.sql`
     * refuses a row whose make does not agree with its narrower target, so the
     * copy cannot disagree with the tree.
     */
    vehicleMakeId: text()
      .notNull()
      .references(() => vehicleMakes.id, { onDelete: 'restrict' }),
    vehicleModelId: text().references(() => vehicleModels.id, { onDelete: 'restrict' }),
    vehicleGenerationId: text().references(() => vehicleGenerations.id, { onDelete: 'restrict' }),
    vehicleConfigurationId: text().references(() => vehicleConfigurations.id, {
      onDelete: 'restrict',
    }),

    // ── The statement ──────────────────────────────────────────────────────
    /**
     * Four-valued, NOT NULL. `does_not_apply` is an EXCLUSION and is the whole
     * of that mechanism; `unknown` is a fitment somebody opened and has not
     * answered. They are different rows and they resolve differently.
     */
    applicability: text({ enum: asEnumValues(COMPATIBILITY_APPLICABILITIES) })
      .notNull()
      .default('unknown'),
    position: text({ enum: asEnumValues(FITMENT_POSITIONS) }).notNull().default('not_applicable'),
    /** Closed vocabulary, CHECKed by containment. `'{}'` = no qualifier. */
    qualifiers: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    conditionKinds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    conditionNote: text(),
    /** Narrows the target's own span. NULL = the target's span. See the doc above. */
    yearFrom: integer(),
    yearTo: integer(),
    /** How many of this part one vehicle takes — two front pads, four spark plugs. */
    quantityPerVehicle: integer(),

    // ── Provenance, verification and the machine number that is not it ──────
    verification: text({ enum: asEnumValues(COMPATIBILITY_VERIFICATION_STATES) })
      .notNull()
      .default('candidate'),
    verificationMethod: text({ enum: asEnumValues(COMPATIBILITY_VERIFICATION_METHODS) }),
    assertedByKind: text({ enum: asEnumValues(COMPATIBILITY_ASSERTED_BY_KINDS) }).notNull(),
    assertedBySourceId: text().references(() => catalogSources.id, { onDelete: 'restrict' }),
    /**
     * The manufacturer's own identifier for THIS fitment record, kept verbatim.
     * D8 asks that manufacturer fitment source be preserved, and the id is what
     * makes a later correction traceable to the row the manufacturer changed —
     * a URL alone goes stale, and a name alone is not an identity (D1).
     */
    manufacturerReference: text(),
    manufacturerPublicationUrl: text(),
    /** Hex sha-256 of the fetched publication, so the claim survives the page changing. */
    contentSha256: text(),
    /** The observation this fitment came from. RESTRICT: provenance blocks a delete. */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    confidence: doublePrecision(),

    /** When the fact was observed in the world — may predate this row. */
    observedAt: timestamptz(),
    verifiedAt: timestamptz(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    verifiedByOxyUserId: text(),
    lastCheckedAt: timestamptz(),
    validFrom: timestamptz()
      .notNull()
      .default(sql`date_trunc('milliseconds', now())`),
    /** NULL = still open. A closed row is history and is never deleted. */
    validTo: timestamptz(),
    revokedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokeReason: text(),
    supersededById: text().references((): AnyPgColumn => automotiveFitments.id, {
      onDelete: 'restrict',
    }),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The duplicate-prevention key. Same device and same reason as
     * `generic_compatibility_relations.relation_key`: the raw columns cannot
     * carry the unique because Postgres treats NULLs as distinct, and three of
     * the four target pointers are NULL on a make-scoped row.
     *
     * `position` is IN the key and the qualifiers are not: one part legitimately
     * has a front fitment and a rear fitment on one car, so two rows differing
     * only by position are two facts. Two rows differing only by qualifier are
     * one fact stated twice, and the second should be a correction.
     */
    fitmentKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("subject_product_id", '') || '|' || coalesce("subject_variant_id", '') || '|' ||
            "vehicle_make_id" || '|' || coalesce("vehicle_model_id", '') || '|' ||
            coalesce("vehicle_generation_id", '') || '|' || coalesce("vehicle_configuration_id", '') || '|' ||
            "position"`,
      ),
  },
  (t) => [
    checkOneOf('automotive_fitments_scope_check', t.scope, FITMENT_TARGET_SCOPES),
    checkOneOf(
      'automotive_fitments_applicability_check',
      t.applicability,
      COMPATIBILITY_APPLICABILITIES,
    ),
    checkOneOf('automotive_fitments_position_check', t.position, FITMENT_POSITIONS),
    checkOneOf(
      'automotive_fitments_verification_check',
      t.verification,
      COMPATIBILITY_VERIFICATION_STATES,
    ),
    checkOneOf(
      'automotive_fitments_verification_method_check',
      t.verificationMethod,
      COMPATIBILITY_VERIFICATION_METHODS,
    ),
    checkOneOf(
      'automotive_fitments_asserted_by_kind_check',
      t.assertedByKind,
      COMPATIBILITY_ASSERTED_BY_KINDS,
    ),
    checkEveryElementOf('automotive_fitments_qualifiers_check', t.qualifiers, FITMENT_QUALIFIERS),
    checkEveryElementOf(
      'automotive_fitments_condition_kinds_check',
      t.conditionKinds,
      COMPATIBILITY_CONDITION_KINDS,
    ),
    check(
      'automotive_fitments_subject_check',
      sql`num_nonnulls(${t.subjectProductId}, ${t.subjectVariantId}) = 1`,
    ),
    /**
     * The scope ladder as a row shape. Each scope requires its own pointer AND
     * every pointer above it, and forbids every pointer below — so a
     * generation-scoped row names its model and its make and cannot name a
     * configuration. `else false` again: an unrecognised scope is
     * unrepresentable even with the scope CHECK dropped.
     *
     * The trigger in `compatibility.pending.sql` is what makes the named
     * ancestors AGREE with the tree; a CHECK cannot read another row.
     */
    check(
      'automotive_fitments_scope_shape_check',
      sql`case ${t.scope}
        when 'vehicle_make' then
          ${t.vehicleModelId} is null and ${t.vehicleGenerationId} is null and ${t.vehicleConfigurationId} is null
        when 'vehicle_model' then
          ${t.vehicleModelId} is not null and ${t.vehicleGenerationId} is null and ${t.vehicleConfigurationId} is null
        when 'vehicle_generation' then
          ${t.vehicleModelId} is not null and ${t.vehicleGenerationId} is not null and ${t.vehicleConfigurationId} is null
        when 'vehicle_configuration' then
          ${t.vehicleModelId} is not null and ${t.vehicleGenerationId} is not null and ${t.vehicleConfigurationId} is not null
        else false
      end`,
    ),
    // `cardinality`, never `array_length` — the latter is NULL on `{}` and a
    // CHECK reads NULL as SATISFIED, so the obvious spelling admits exactly the
    // row it exists to refuse.
    check(
      'automotive_fitments_partial_condition_check',
      sql`${t.applicability} <> 'partially_applies'
        or cardinality(${t.conditionKinds}) >= 1
        or cardinality(${t.qualifiers}) >= 1
        or ${t.conditionNote} is not null`,
    ),
    yearRangeCheck('automotive_fitments_from_year_check', t.yearFrom),
    yearRangeCheck('automotive_fitments_to_year_check', t.yearTo),
    check(
      'automotive_fitments_year_order_check',
      sql`${t.yearFrom} is null or ${t.yearTo} is null or ${t.yearTo} >= ${t.yearFrom}`,
    ),
    check(
      'automotive_fitments_quantity_check',
      sql`${t.quantityPerVehicle} is null or (${t.quantityPerVehicle} > 0 and ${t.quantityPerVehicle} <= 64)`,
    ),
    check(
      'automotive_fitments_verified_state_check',
      sql`${t.verification} <> 'verified'
        or (${t.verificationMethod} is not null and ${t.verifiedAt} is not null and ${t.verifiedByOxyUserId} is not null)`,
    ),
    check(
      'automotive_fitments_revoked_state_check',
      sql`${t.verification} <> 'revoked'
        or (${t.revokedAt} is not null and ${t.revokedByOxyUserId} is not null and ${t.validTo} is not null)`,
    ),
    check(
      'automotive_fitments_confidence_range_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    check(
      'automotive_fitments_confidence_machine_check',
      sql`${t.confidence} is null or ${t.assertedByKind} in ('catalog_source', 'matcher')`,
    ),
    check(
      'automotive_fitments_source_presence_check',
      sql`(${t.assertedByKind} = 'catalog_source') = (${t.assertedBySourceId} is not null)`,
    ),
    /**
     * A manufacturer-verified fitment cites the publication AND its digest —
     * #55's `brand_statement` rule, and for the same reason: without the digest
     * the claim does not survive the page being edited under it.
     */
    check(
      'automotive_fitments_manufacturer_evidence_check',
      sql`${t.verificationMethod} <> 'manufacturer_publication'
        or (${t.manufacturerPublicationUrl} is not null and ${t.contentSha256} is not null)`,
    ),
    check(
      'automotive_fitments_sha256_shape_check',
      sql`${t.contentSha256} is null or ${t.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'automotive_fitments_validity_order_check',
      sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),
    check(
      'automotive_fitments_supersedes_other_check',
      sql`${t.supersededById} is null or ${t.supersededById} <> ${t.id}`,
    ),

    /** ≤1 OPEN fitment per (subject, vehicle target, position). See `fitment_key`. */
    uniqueIndex('automotive_fitments_open_key')
      .on(t.fitmentKey)
      .where(sql`${t.validTo} is null`),

    // ── "Which parts fit this vehicle" — the reverse read, one per scope ─────
    index('automotive_fitments_configuration_idx')
      .on(t.vehicleConfigurationId, t.applicability, t.verification)
      .where(sql`${t.vehicleConfigurationId} is not null`),
    index('automotive_fitments_generation_idx')
      .on(t.vehicleGenerationId, t.applicability, t.verification)
      .where(sql`${t.vehicleGenerationId} is not null`),
    index('automotive_fitments_model_idx')
      .on(t.vehicleModelId, t.applicability, t.verification)
      .where(sql`${t.vehicleModelId} is not null`),
    index('automotive_fitments_make_idx').on(t.vehicleMakeId, t.applicability, t.verification),
    // ── "Which vehicles does this part fit" — the forward read ──────────────
    index('automotive_fitments_subject_product_idx')
      .on(t.subjectProductId, t.applicability)
      .where(sql`${t.subjectProductId} is not null`),
    index('automotive_fitments_subject_variant_idx')
      .on(t.subjectVariantId, t.applicability)
      .where(sql`${t.subjectVariantId} is not null`),
    index('automotive_fitments_review_idx').on(t.verification, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// The claim layer (ADR 0007 D7)
// ---------------------------------------------------------------------------

/**
 * `compatibility_claims` — what a SOURCE said, kept verbatim, whether or not
 * Mercaria could resolve it (ADR 0007 D7).
 *
 * ## One table for both halves of the domain, and why that is not a polymorphic
 * cop-out
 *
 * A claim points at the generic relation it was selected into, OR at the
 * automotive fitment, OR at nothing. Two nullable foreign keys and a CHECK
 * holding at most one — the `orders` shape, not a `{type, id}` pair — so both
 * pointers are REAL constraints and a claim naming a relation that does not
 * exist cannot be stored. The alternative, two claim tables, would put one
 * provenance shape in two places and give "how many claims has this feed made"
 * two answers.
 *
 * ## The raw target is the point of the table
 *
 * `raw_target_text` is what the source actually wrote — `Golf Mk7 2.0 TDI
 * 2013-2016`, `iPhone 15/15 Pro`, `fits most 18mm watches`. It is preserved
 * whether or not it resolved, because the class of claims that resolve to
 * NOTHING is the one an operator most needs to read: a feed whose fitment column
 * Mercaria cannot parse produces thousands of them, and the raw text is the only
 * evidence of what it was trying to say. D6's ruling one domain over is the same
 * one — ambiguous stays text and stays unresolved, visible in a queue.
 *
 * ## No back-pointer from the canonical row
 *
 * `compatibility_claims_selected_relation_key` and its fitment sibling hold at
 * most ONE `selected` claim per canonical row, which is how "which claim is this
 * fact" is answered without the canonical table carrying a `selected_claim_id`.
 * That column would be a circular foreign key, and `drizzle-kit generate`
 * silently drops one — measured in #66, where the declaration type-checked,
 * produced no `ADD CONSTRAINT` and enforced nothing.
 */
export const compatibilityClaims = pgTable(
  'compatibility_claims',
  {
    id: generatedId(),

    // ── What the claim is about ─────────────────────────────────────────────
    subjectProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    subjectVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    /** The compatibility kind the source asserted; NULL on an automotive claim. */
    kind: text({ enum: asEnumValues(COMPATIBILITY_RELATION_KINDS) }),
    /** The source's own words for the target. Preserved verbatim, always. */
    rawTargetText: text().notNull(),
    /** The source's own words for the position, qualifiers or conditions, verbatim. */
    rawQualifierText: text(),

    // ── Where it landed ─────────────────────────────────────────────────────
    state: text({ enum: asEnumValues(COMPATIBILITY_CLAIM_STATES) }).notNull().default('unresolved'),
    /** Why it did not resolve. Present EXACTLY when the state is `unresolved`. */
    unresolvedReason: text({ enum: asEnumValues(COMPATIBILITY_UNRESOLVED_REASONS) }),
    relationId: text().references(() => genericCompatibilityRelations.id, { onDelete: 'restrict' }),
    fitmentId: text().references(() => automotiveFitments.id, { onDelete: 'restrict' }),

    // ── Provenance — this table IS the evidence layer ───────────────────────
    assertedByKind: text({ enum: asEnumValues(COMPATIBILITY_ASSERTED_BY_KINDS) }).notNull(),
    assertedBySourceId: text().references(() => catalogSources.id, { onDelete: 'restrict' }),
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /**
     * Where the claim was read, when it came from a page rather than a feed.
     *
     * There is deliberately no MERCHANT or STORE column beside it. A merchant's
     * assertion arrives through the ingestion path that owns the observation and
     * is identified by `source_record_id`; adding a second, direct seller pointer
     * would give "who said this" two answers — and the one a merchant could write
     * to directly is the one no source-level suspension could ever withdraw.
     */
    sourceUrl: text(),
    contentSha256: text(),
    /** When the source said it — may predate this row by years. */
    observedAt: timestamptz().notNull(),
    /** 0–1, machine only. The same rule as the canonical tables. */
    confidence: doublePrecision(),

    /** An Oxy account id — no foreign key. Who resolved or rejected it. */
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
    reviewNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('compatibility_claims_kind_check', t.kind, COMPATIBILITY_RELATION_KINDS),
    checkOneOf('compatibility_claims_state_check', t.state, COMPATIBILITY_CLAIM_STATES),
    checkOneOf(
      'compatibility_claims_unresolved_reason_check',
      t.unresolvedReason,
      COMPATIBILITY_UNRESOLVED_REASONS,
    ),
    checkOneOf(
      'compatibility_claims_asserted_by_kind_check',
      t.assertedByKind,
      COMPATIBILITY_ASSERTED_BY_KINDS,
    ),
    check(
      'compatibility_claims_subject_check',
      sql`num_nonnulls(${t.subjectProductId}, ${t.subjectVariantId}) <= 1`,
    ),
    check('compatibility_claims_raw_target_check', sql`btrim(${t.rawTargetText}) <> ''`),
    /**
     * A claim lands on at most ONE canonical row, an `unresolved` claim lands on
     * none, and a RESOLVED one lands on exactly one.
     *
     * Written as TWO implications rather than one biconditional, because the six
     * states partition THREE ways and a biconditional can only express two:
     * `unresolved` must have no target, `selected`/`corroborating`/`conflicting`
     * must have exactly one, and `rejected`/`superseded` may legitimately have
     * either — a claim rejected before anybody attached it never had one, and a
     * claim rejected afterwards keeps the pointer that says what it was attached
     * to. The tempting single constraint,
     * `(state = 'unresolved') = (num_nonnulls(...) = 0)`, refuses exactly the
     * first of those: an operator rejecting an unparseable claim. It is
     * mutation-tested in `compatibility.realdb.test.ts`, which goes red on that
     * spelling naming the rejection it broke.
     */
    check(
      'compatibility_claims_target_arity_check',
      sql`num_nonnulls(${t.relationId}, ${t.fitmentId}) <= 1`,
    ),
    check(
      'compatibility_claims_unresolved_shape_check',
      sql`${t.state} <> 'unresolved' or num_nonnulls(${t.relationId}, ${t.fitmentId}) = 0`,
    ),
    check(
      'compatibility_claims_resolved_shape_check',
      sql`${t.state} not in ('selected', 'corroborating', 'conflicting')
        or num_nonnulls(${t.relationId}, ${t.fitmentId}) = 1`,
    ),
    // The reason exists EXACTLY when the state is `unresolved`. A reason on a
    // resolved claim is a leftover that reads as a live problem.
    check(
      'compatibility_claims_unresolved_reason_presence_check',
      sql`(${t.state} = 'unresolved') = (${t.unresolvedReason} is not null)`,
    ),
    check(
      'compatibility_claims_confidence_range_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    check(
      'compatibility_claims_confidence_machine_check',
      sql`${t.confidence} is null or ${t.assertedByKind} in ('catalog_source', 'matcher')`,
    ),
    check(
      'compatibility_claims_source_presence_check',
      sql`(${t.assertedByKind} = 'catalog_source') = (${t.assertedBySourceId} is not null)`,
    ),
    check(
      'compatibility_claims_sha256_shape_check',
      sql`${t.contentSha256} is null or ${t.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    // A rejection is attributable or it is not a rejection.
    check(
      'compatibility_claims_rejected_state_check',
      sql`${t.state} <> 'rejected' or (${t.reviewedByOxyUserId} is not null and ${t.reviewedAt} is not null)`,
    ),

    /** ONE selected claim per canonical row — the back-pointer, held as an index. */
    uniqueIndex('compatibility_claims_selected_relation_key')
      .on(t.relationId)
      .where(sql`${t.state} = 'selected' and ${t.relationId} is not null`),
    uniqueIndex('compatibility_claims_selected_fitment_key')
      .on(t.fitmentId)
      .where(sql`${t.state} = 'selected' and ${t.fitmentId} is not null`),

    index('compatibility_claims_relation_idx')
      .on(t.relationId, t.state)
      .where(sql`${t.relationId} is not null`),
    index('compatibility_claims_fitment_idx')
      .on(t.fitmentId, t.state)
      .where(sql`${t.fitmentId} is not null`),
    index('compatibility_claims_subject_product_idx')
      .on(t.subjectProductId, t.state)
      .where(sql`${t.subjectProductId} is not null`),
    index('compatibility_claims_subject_variant_idx')
      .on(t.subjectVariantId, t.state)
      .where(sql`${t.subjectVariantId} is not null`),
    /**
     * The unresolved queue, and the counter behind "how much of this feed could
     * Mercaria not read". Partial, so the index is the size of the backlog
     * rather than of the table.
     */
    index('compatibility_claims_unresolved_idx')
      .on(t.unresolvedReason, t.assertedBySourceId, t.createdAt)
      .where(sql`${t.state} = 'unresolved'`),
    index('compatibility_claims_source_record_idx')
      .on(t.sourceRecordId)
      .where(sql`${t.sourceRecordId} is not null`),
  ],
);
