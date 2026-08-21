/**
 * External taxonomy, attribute and value mappings (#367 Workstream 11,
 * ADR 0007 D1/D13/D14).
 *
 * Five tables that turn a provider's own classification into a Mercaria concept
 * — and, mostly, stop it turning into one by accident. #62 already owns source
 * registration, observations, rights policies and provenance; nothing here
 * re-models any of them. `catalog_sources` and `source_records` are referenced,
 * never duplicated.
 *
 * ## Why ONE table for five dimensions
 *
 * A product-type mapping, an attribute mapping, a controlled-value mapping, a
 * unit mapping and a size-system mapping are the same row with a different
 * pointer: an external key, a target, a confidence, a provenance, a review
 * state, a validity window and a version. Five tables would be five copies of
 * that governance, five copies of the fan-out rule and five copies of the
 * reprocessing machinery — and the copy that drifted would be the one nobody was
 * reading. The target is a discriminated pointer with a CHECK forcing every
 * non-selected column NULL, which is ADR 0007 D3's `navigation_nodes` device:
 * "a mapping that means two things" has no row shape.
 *
 * ## Why `category` is NOT one of them
 *
 * ADR 0007 D2 names `category_external_mappings` under "New tables, each owned
 * by the taxonomy module", and the taxonomy workstream built it — versioned,
 * with confidence, review state and validity dates, in `./taxonomy`. There is
 * therefore no `category` dimension and no `target_category_id` column here: a
 * second table answering "what does this source's category mean" is exactly the
 * rival this epic exists to remove, and the isolation gate fails the build on
 * the tuple member OR on any column matching `/category/i`.
 *
 * The cost of the split is real and is stated rather than hidden. It is not "two
 * mechanisms" — nothing is duplicated today — it is that ONE dimension is
 * modelled in the taxonomy module's shape and FIVE in this one, free to diverge
 * on confidence, review state, validity and provenance. Folding it in is an ADR
 * 0007 amendment plus a move migration, in ONE change so that no interval exists
 * where a decision is recorded and its migration is not; the inherited column
 * shape is in `docs/catalog-external-mappings.md` §"The category dimension".
 *
 * ## What has no row shape here
 *
 * - **A mapping established by a NAME.** There is no `target_name`,
 *   `target_label` or `target_slug` column anywhere below, and
 *   `external-mapping-isolation.test.ts` fails the build if one appears. ADR
 *   0007 D1's single invariant is that presentation is never identity; #55
 *   reached the same place by leaving `name_match` out of `verification_method`.
 * - **An executable rule supplied by a row.** `transform_rule` is a member of a
 *   shipped, closed tuple plus a version integer. No column can hold a pattern,
 *   a template, an expression or a value table (#63: a source-supplied pattern
 *   is a small language and a DoS primitive).
 * - **A silent one-to-many.** `catalog_external_mappings_live_primary_key` is a
 *   partial unique over `(source, dimension, normalized key)` restricted to the
 *   rows that actually resolve AND carry no fan-out approval. A second live
 *   target for one key is therefore refused by the DATABASE unless somebody
 *   recorded a fan-out approval on it — and a CHECK makes that approval require
 *   a second operator (`#55`'s four eyes, at the grain where the ambiguity is
 *   created).
 * - **An approved mapping that nobody approved.** Two CHECKs, in the
 *   `attribute_value_reviews` shape: `approved` implies a named approver and an
 *   instant; anything that was never approved carries neither.
 *
 * ## Immutability
 *
 * A mapping's meaning is frozen once it leaves `proposed` — the `fee_schedules`
 * / `attribute_definitions` mechanism. A change is a NEW version plus a
 * `valid_to` on the old row, so an observation recorded under the previous
 * meaning is still interpretable. The trigger is applied in
 * `drizzle/0094_dizzy_makkari.sql` and compares `external_key`, never the
 * GENERATED `external_key_normalized`: a stored generated column is computed
 * AFTER a `BEFORE UPDATE` trigger, so `NEW.external_key_normalized` is NULL
 * there and the comparison would raise on every update (measured in #59).
 *
 * That citation names the migration that CREATED the trigger, which is not the
 * same as the one that defines it today if a later migration ever
 * `CREATE OR REPLACE`s the body. `external-mapping-schema.test.ts` refuses more
 * than one defining migration, so this line cannot go stale silently — but
 * re-derive it rather than copying it forward. (It said
 * `catalogExternalMappings.pending.sql` until #831; that staging file was
 * deleted under CONVENTIONS' two-copies rule once `0094` carried it.)
 *
 * ## No jsonb
 *
 * Not one column here is `jsonb`, so the ADR 0007 D14 register is unchanged.
 * Every external token, path segment, target, verdict and counter is a real
 * column with a real constraint.
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
  CATALOG_EXTERNAL_MAPPING_DIMENSIONS,
  CATALOG_EXTERNAL_MAPPING_PROVENANCES,
  CATALOG_EXTERNAL_MAPPING_STATES,
  CATALOG_EXTERNAL_REPROCESS_MODES,
  CATALOG_EXTERNAL_REPROCESS_OUTCOMES,
  CATALOG_EXTERNAL_REPROCESS_STATES,
  CATALOG_EXTERNAL_RESOLUTION_OUTCOMES,
  CATALOG_EXTERNAL_REVIEW_REASONS,
  CATALOG_EXTERNAL_REVIEW_STATES,
  CATALOG_EXTERNAL_SUBJECT_KINDS,
  CATALOG_EXTERNAL_TOKEN_MAX_LENGTH,
  CATALOG_EXTERNAL_TRANSFORM_RULES,
  CATALOG_EXTERNAL_UNRESOLVED_REASONS,
  UNIT_FAMILIES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { productTypeDefinitions } from './productTypes';
import { catalogSources, sourceRecords } from './provenance';

/** `^[a-z][a-z0-9_]*$` — the `attribute_definitions.key` shape, reused verbatim. */
const ATTRIBUTE_KEY_SHAPE = "'^[a-z][a-z0-9_]*$'";
/** A dotted machine key (`electronics.phones.smartphones`, `size.eu`) — ADR 0007 D1. */
const DOTTED_KEY_SHAPE = "'^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*$'";

/**
 * `catalog_external_mappings` — one versioned, reviewed statement that one
 * source's token means one Mercaria concept.
 *
 * ## The external side is preserved verbatim and normalized separately
 *
 * `external_key` is exactly what the source published. `external_key_normalized`
 * is GENERATED from it (`lower(btrim(...))`, both IMMUTABLE), so the stored
 * spelling and the lookup key cannot disagree — the
 * `attribute_value_aliases.normalized_alias` device. `external_label` and
 * `external_path` are the source's own display text and its own path, kept as
 * they arrived: normalizing what a source said never destroys what it said.
 *
 * ## Every target is a KEY, and NO target column carries a foreign key
 *
 * That is permanent, not a seam waiting on a table. Neither
 * `product_type_definitions` nor `attribute_definitions` has a unique constraint
 * on `key` alone and neither will get one: the one-live-version index is PARTIAL
 * (`WHERE lifecycle = 'published'` / `= 'active'`), PostgreSQL will not accept a
 * foreign key onto a partial unique index, and the house rule additionally
 * forbids one onto a `uniqueIndex()` rather than a `unique()` constraint. The
 * product-type workstream hit exactly that wall making `product_type_fields`
 * cite `attribute_definitions(key, version)` and had to use a trigger instead.
 *
 * It is also the semantically correct target. Each registry row is ONE version,
 * so an id-valued target would bind a reviewed governance decision to a version
 * that will be deprecated — the mapping would cascade away with it or block the
 * deprecation, and neither is what "this source's `memory_size` field means
 * `ram_capacity`" meant. #94's own `attribute_source_mappings.attribute_key`
 * made the same call.
 *
 * What makes a key-valued target safe is that `key` is frozen from INSERT by a
 * trigger on BOTH registries (ADR 0007 D1 rule 2: a renamed key is
 * indistinguishable from a different concept to every mapping that cited it), so
 * a mapping keyed on one cannot be silently re-pointed. Resolution reads the
 * single live version — a single-row lookup on the partial unique, never an
 * `ORDER BY … LIMIT 1`, which is a query with a bug in it the moment two rows
 * exist — and FAILS CLOSED (`target_unresolvable`) when there is none.
 *
 * Mercaria has no unit table and no size-system table at all: units are a code
 * registry (`services/canonical/units.ts`) and size systems are unbuilt, so a
 * `size_system` mapping is storable and reviewable and never resolves.
 */
export const catalogExternalMappings = pgTable(
  'catalog_external_mappings',
  {
    id: generatedId(),
    /** `restrict`: a mapping is evidence about a source and must outlive nothing. */
    catalogSourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    dimension: text({ enum: asEnumValues(CATALOG_EXTERNAL_MAPPING_DIMENSIONS) }).notNull(),

    // ── The external side, verbatim ──────────────────────────────────────────
    /** The source's own token, exactly as published. */
    externalKey: text().notNull(),
    /** The lookup form. GENERATED, so it cannot disagree with `external_key`. */
    externalKeyNormalized: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("external_key"))`),
    /** The source's own display text for the token, when it published one. */
    externalLabel: text(),
    /** The source's own path to the token, outermost first, verbatim. */
    externalPath: text().array().notNull().default(sql`'{}'::text[]`),
    /** The BCP-47 tag `external_label` is written in, when the source states it. */
    externalLocale: text(),

    // ── The Mercaria side: a stable machine KEY, never a name and never an id ─
    targetProductTypeKey: text(),
    targetAttributeKey: text(),
    /** An `attribute_enum_values.value` — already normalized, CHECKed below. */
    targetControlledValue: text(),
    targetUnitFamily: text({ enum: asEnumValues(UNIT_FAMILIES) }),
    /** A canonical unit code from `services/canonical/units.ts`. */
    targetUnitCode: text(),
    targetSizeSystemKey: text(),

    /**
     * Which `product_type_definitions` VERSION this mapping was reviewed
     * against. PROVENANCE, never the resolution target.
     *
     * Resolution reads `target_product_type_key` and the single live published
     * version; this answers the different question "what did the schema look
     * like when somebody approved this", which is what a later correction
     * actually asks. Saying out loud that it is never applied is what stops the
     * two becoming a second answer to one question.
     *
     * A REAL foreign key, `restrict`. It was `DEFERRED_FOREIGN_KEYS`' only entry
     * while `product_type_definitions` (ADR 0007 D5) was not on this branch's
     * base; that gate failed the build the moment the table appeared on the
     * rebase, which is exactly what stops "we will add the constraint later"
     * becoming a condition nobody revisits.
     *
     * `restrict` rather than `cascade`: a version named as the evidence for an
     * approval must not be deletable out from under that record, and a cascade
     * would erase the provenance instead of refusing the delete. Unlike the KEY
     * columns above this one CAN be constrained at all, because it names a row
     * by its opaque primary key rather than by a key with no unique to point at.
     */
    reviewedProductTypeDefinitionId: text().references(() => productTypeDefinitions.id, {
      onDelete: 'restrict',
    }),

    // ── The transformation: a REFERENCE, never a rule ────────────────────────
    transformRule: text({ enum: asEnumValues(CATALOG_EXTERNAL_TRANSFORM_RULES) })
      .notNull()
      .default('identity'),
    transformRuleVersion: integer().notNull().default(1),

    // ── Governance ───────────────────────────────────────────────────────────
    /** Monotonic per `(source, dimension, normalized key)` — every decision about that token, in order. */
    version: integer().notNull().default(1),
    /**
     * The version this one replaced. `restrict`: the superseded row is the
     * evidence for this one's existence, and a mapping's history is the only
     * thing that makes "why does this feed's `Cor` mean colour" answerable
     * later.
     *
     * A SELF reference (the `categories.parent_id` shape), which drizzle-kit
     * emits correctly. The one it drops silently is a CIRCULAR reference between
     * two tables — measured on #66 — and this is not one.
     */
    supersedesMappingId: text().references((): AnyPgColumn => catalogExternalMappings.id, {
      onDelete: 'restrict',
    }),
    state: text({ enum: asEnumValues(CATALOG_EXTERNAL_MAPPING_STATES) })
      .notNull()
      .default('proposed'),
    provenance: text({ enum: asEnumValues(CATALOG_EXTERNAL_MAPPING_PROVENANCES) }).notNull(),
    /**
     * 0..1. INFORMATION for a reviewer, never an authority: there is no
     * confidence at which a mapping resolves without approval, and
     * `resolution.service.ts` does not read this column at all (a gate).
     */
    confidence: doublePrecision().notNull(),
    /** The observation that suggested it, when one did. `restrict` — provenance blocks a delete. */
    evidenceSourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    evidenceNote: text(),

    /** The window in which this mapping resolves. Open-ended when `valid_to` is NULL. */
    validFrom: timestamptz().notNull(),
    validTo: timestamptz(),

    proposedByOxyUserId: text(),
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
    approvedByOxyUserId: text(),
    approvedAt: timestamptz(),
    rejectedReason: text(),

    /**
     * The fan-out approval — present exactly when this mapping is a SECOND live
     * target for a key that already resolves.
     *
     * Three columns rather than a separate decision table: the rationale belongs
     * per TARGET ("why does `shoes` also mean `kids_shoes`" is a different
     * sentence from "why does it also mean `womens_shoes`"), and a table would
     * need a trigger to prove its scope matched the row citing it.
     */
    fanOutApprovedByOxyUserId: text(),
    fanOutApprovedAt: timestamptz(),
    fanOutRationale: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_external_mappings_dimension_check',
      t.dimension,
      CATALOG_EXTERNAL_MAPPING_DIMENSIONS,
    ),
    checkOneOf('catalog_external_mappings_state_check', t.state, CATALOG_EXTERNAL_MAPPING_STATES),
    checkOneOf(
      'catalog_external_mappings_provenance_check',
      t.provenance,
      CATALOG_EXTERNAL_MAPPING_PROVENANCES,
    ),
    checkOneOf(
      'catalog_external_mappings_transform_rule_check',
      t.transformRule,
      CATALOG_EXTERNAL_TRANSFORM_RULES,
    ),
    checkOneOf('catalog_external_mappings_unit_family_check', t.targetUnitFamily, UNIT_FAMILIES),

    // The discriminated target. `else false` is load-bearing: a dimension added
    // to the tuple without a branch here fails every write loudly, rather than
    // admitting a row with no target at all.
    check(
      'catalog_external_mappings_target_shape_check',
      sql`case ${t.dimension}
        when 'product_type' then
          ${t.targetProductTypeKey} is not null
          and num_nonnulls(${t.targetAttributeKey}, ${t.targetControlledValue},
                           ${t.targetUnitFamily}, ${t.targetUnitCode},
                           ${t.targetSizeSystemKey}) = 0
        when 'attribute' then
          ${t.targetAttributeKey} is not null
          and num_nonnulls(${t.targetProductTypeKey}, ${t.targetControlledValue},
                           ${t.targetUnitFamily}, ${t.targetUnitCode},
                           ${t.targetSizeSystemKey}) = 0
        when 'controlled_value' then
          ${t.targetAttributeKey} is not null and ${t.targetControlledValue} is not null
          and num_nonnulls(${t.targetProductTypeKey}, ${t.targetUnitFamily},
                           ${t.targetUnitCode}, ${t.targetSizeSystemKey}) = 0
        when 'unit' then
          ${t.targetUnitFamily} is not null and ${t.targetUnitCode} is not null
          and num_nonnulls(${t.targetProductTypeKey}, ${t.targetAttributeKey},
                           ${t.targetControlledValue}, ${t.targetSizeSystemKey}) = 0
        when 'size_system' then
          ${t.targetSizeSystemKey} is not null
          and num_nonnulls(${t.targetProductTypeKey}, ${t.targetAttributeKey},
                           ${t.targetControlledValue}, ${t.targetUnitFamily},
                           ${t.targetUnitCode}) = 0
        else false
      end`,
    ),

    // The external token: non-empty, bounded rather than truncated (#63 — a
    // truncated key normalizes differently on every delivery, so the convergence
    // key stops converging and one external concept becomes many).
    check(
      'catalog_external_mappings_external_key_shape_check',
      sql`btrim(${t.externalKey}) <> '' and length(${t.externalKey}) <= ${sql.raw(String(CATALOG_EXTERNAL_TOKEN_MAX_LENGTH))}`,
    ),
    check(
      'catalog_external_mappings_external_path_bound_check',
      sql`cardinality(${t.externalPath}) <= 32`,
    ),
    check(
      'catalog_external_mappings_external_locale_shape_check',
      sql`${t.externalLocale} is null or ${t.externalLocale} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),

    // Target key shapes. A key is a machine name; a name is not one.
    check(
      'catalog_external_mappings_attribute_key_shape_check',
      sql`${t.targetAttributeKey} is null or ${t.targetAttributeKey} ~ ${sql.raw(ATTRIBUTE_KEY_SHAPE)}`,
    ),
    check(
      'catalog_external_mappings_product_type_key_shape_check',
      sql`${t.targetProductTypeKey} is null or ${t.targetProductTypeKey} ~ ${sql.raw(DOTTED_KEY_SHAPE)}`,
    ),
    check(
      'catalog_external_mappings_size_system_key_shape_check',
      sql`${t.targetSizeSystemKey} is null or ${t.targetSizeSystemKey} ~ ${sql.raw(DOTTED_KEY_SHAPE)}`,
    ),
    // The same normalization `attribute_enum_values.value` enforces, so a
    // mapping cannot name a controlled value spelled differently from the row it
    // is supposed to select.
    check(
      'catalog_external_mappings_controlled_value_shape_check',
      sql`${t.targetControlledValue} is null
        or (${t.targetControlledValue} = lower(btrim(${t.targetControlledValue}))
            and ${t.targetControlledValue} <> '')`,
    ),
    check(
      'catalog_external_mappings_unit_code_shape_check',
      sql`${t.targetUnitCode} is null or ${t.targetUnitCode} ~ '^[A-Za-z][A-Za-z0-9_/%]*$'`,
    ),

    check(
      'catalog_external_mappings_confidence_range_check',
      sql`${t.confidence} >= 0 and ${t.confidence} <= 1`,
    ),
    check('catalog_external_mappings_version_check', sql`${t.version} >= 1`),
    check(
      'catalog_external_mappings_transform_version_check',
      sql`${t.transformRuleVersion} >= 1`,
    ),
    // The reviewed-against version is a fact about a PRODUCT-TYPE mapping and
    // about nothing else. Without this, a unit mapping could carry one and a
    // reader would have to decide what that meant.
    check(
      'catalog_external_mappings_reviewed_definition_scope_check',
      sql`${t.reviewedProductTypeDefinitionId} is null or ${t.dimension} = 'product_type'`,
    ),
    check(
      'catalog_external_mappings_validity_order_check',
      sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),

    // An approval is a named act at a named instant, or it did not happen.
    check(
      'catalog_external_mappings_approval_pair_check',
      sql`num_nonnulls(${t.approvedAt}, ${t.approvedByOxyUserId}) in (0, 2)`,
    ),
    // BOTH columns named, not just the timestamp. `approval_pair_check` already
    // makes them 0-or-2 so the pair could not be half-set, but stating it here
    // too means the implication does not depend on reading another constraint —
    // the shape a CHECK over a CONJUNCTION gets wrong is an `approved` row
    // carrying one half of its audit.
    check(
      'catalog_external_mappings_approved_audited_check',
      sql`${t.state} <> 'approved'
        or (${t.approvedAt} is not null and ${t.approvedByOxyUserId} is not null)`,
    ),
    // Only the two states that WERE approved may carry the stamp. Without this,
    // a `proposed` row could be written already carrying an approver.
    check(
      'catalog_external_mappings_unapproved_clean_check',
      sql`${t.state} in ('approved', 'superseded') or ${t.approvedAt} is null`,
    ),
    check(
      'catalog_external_mappings_rejection_check',
      sql`${t.state} <> 'rejected'
        or (${t.rejectedReason} is not null and ${t.reviewedByOxyUserId} is not null
            and ${t.reviewedAt} is not null)`,
    ),
    check(
      'catalog_external_mappings_review_pair_check',
      sql`num_nonnulls(${t.reviewedAt}, ${t.reviewedByOxyUserId}) in (0, 2)`,
    ),

    // A fan-out is the only decision here that needs FOUR EYES, because it is
    // the only one that creates an ambiguity a later reader has to live with.
    // Stated so that a NULL approver cannot satisfy it: `x <> NULL` is NULL, and
    // a CHECK rejects only FALSE, so the obvious spelling would admit a fan-out
    // on a mapping nobody approved.
    check(
      'catalog_external_mappings_fan_out_triple_check',
      sql`num_nonnulls(${t.fanOutApprovedByOxyUserId}, ${t.fanOutApprovedAt}, ${t.fanOutRationale}) in (0, 3)`,
    ),
    check(
      'catalog_external_mappings_fan_out_four_eyes_check',
      sql`${t.fanOutApprovedByOxyUserId} is null
        or (${t.approvedByOxyUserId} is not null
            and ${t.fanOutApprovedByOxyUserId} <> ${t.approvedByOxyUserId})`,
    ),

    // ── The one-to-many refusal ──────────────────────────────────────────────
    // At most ONE live approved mapping per token that has no fan-out approval.
    // A second one is refused by the database; the only way to add it is to
    // record a fan-out approval, which the four-eyes CHECK above prices at two
    // operators. That is "one-to-many requires explicit review" as a constraint
    // rather than as a service comparison two workers can race past.
    uniqueIndex('catalog_external_mappings_live_primary_key')
      .on(t.catalogSourceId, t.dimension, t.externalKeyNormalized)
      .where(
        sql`${t.state} = 'approved' and ${t.validTo} is null and ${t.fanOutApprovedAt} is null`,
      ),
    // Every decision about one token, in order, exactly once.
    uniqueIndex('catalog_external_mappings_version_key').on(
      t.catalogSourceId,
      t.dimension,
      t.externalKeyNormalized,
      t.version,
    ),
    // The read path.
    index('catalog_external_mappings_lookup_idx')
      .on(t.catalogSourceId, t.dimension, t.externalKeyNormalized)
      .where(sql`${t.state} = 'approved'`),
    // Reverse lookup and impact: which sources point at this Mercaria concept.
    index('catalog_external_mappings_target_attribute_idx')
      .on(t.targetAttributeKey)
      .where(sql`${t.targetAttributeKey} is not null`),
    index('catalog_external_mappings_queue_idx').on(t.state, t.dimension, t.createdAt),
  ],
);

/**
 * `catalog_external_mapping_reviews` — the queue for a token nobody has decided.
 *
 * An unmapped or ambiguous value goes HERE. There is deliberately no default
 * mapping, no nearest-match fallback and no "use the parent category" rule: #58
 * is shaped around the false merge precisely because it looks exactly like a
 * correct match and is discovered by a customer, and a taxonomy guess is the
 * same failure one layer up.
 *
 * ONE open row per token, held by a partial unique rather than a service
 * read-then-write — two ingestion workers meeting the same unknown value a
 * millisecond apart would otherwise open two rows and a reviewer would settle
 * one of them (`attribute_value_reviews`, verbatim).
 *
 * `occurrences` counts how many observations hit it, which is what makes the
 * queue orderable by something real. `priority` is stored rather than derived
 * for #94's reason: re-deriving a rank against a changed catalogue silently
 * reorders a queue somebody is working through.
 */
export const catalogExternalMappingReviews = pgTable(
  'catalog_external_mapping_reviews',
  {
    id: generatedId(),
    catalogSourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    dimension: text({ enum: asEnumValues(CATALOG_EXTERNAL_MAPPING_DIMENSIONS) }).notNull(),
    externalKey: text().notNull(),
    externalKeyNormalized: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("external_key"))`),
    externalLabel: text(),
    externalPath: text().array().notNull().default(sql`'{}'::text[]`),
    /**
     * The source's value VERBATIM, before any transformation ran.
     *
     * The whole point of the queue is that a person can see what the source
     * actually wrote; a normalized copy would hide the very thing that made it
     * unmappable.
     */
    observedRawValue: text(),
    /** The observation that raised it. `restrict` — the evidence must not vanish. */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    reason: text({ enum: asEnumValues(CATALOG_EXTERNAL_REVIEW_REASONS) }).notNull(),
    state: text({ enum: asEnumValues(CATALOG_EXTERNAL_REVIEW_STATES) }).notNull().default('open'),
    priority: integer().notNull().default(0),
    occurrences: integer().notNull().default(1),
    firstObservedAt: timestamptz().notNull(),
    lastObservedAt: timestamptz().notNull(),
    /** The candidates a reviewer is choosing between. Only ever an ambiguity's. */
    candidateMappingIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** One line naming what is undecided, for a reviewer scanning the queue. */
    summary: text().notNull(),
    /** `restrict`: a resolution cites the mapping that settled it. */
    resolvedMappingId: text().references(() => catalogExternalMappings.id, {
      onDelete: 'restrict',
    }),
    resolvedByOxyUserId: text(),
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_external_mapping_reviews_dimension_check',
      t.dimension,
      CATALOG_EXTERNAL_MAPPING_DIMENSIONS,
    ),
    checkOneOf(
      'catalog_external_mapping_reviews_reason_check',
      t.reason,
      CATALOG_EXTERNAL_REVIEW_REASONS,
    ),
    checkOneOf(
      'catalog_external_mapping_reviews_state_check',
      t.state,
      CATALOG_EXTERNAL_REVIEW_STATES,
    ),
    check(
      'catalog_external_mapping_reviews_external_key_shape_check',
      sql`btrim(${t.externalKey}) <> '' and length(${t.externalKey}) <= ${sql.raw(String(CATALOG_EXTERNAL_TOKEN_MAX_LENGTH))}`,
    ),
    // A closed review names who closed it and when; an open one names neither.
    check(
      'catalog_external_mapping_reviews_resolution_check',
      sql`(${t.state} = 'open') = (${t.resolvedAt} is null and ${t.resolvedByOxyUserId} is null)`,
    ),
    // `resolved` means a mapping now answers it. `dismissed` deliberately does
    // not: "this source publishes a field we do not model" is a real outcome and
    // collapsing the two would make the queue's throughput indistinguishable
    // from its abandonment.
    check(
      'catalog_external_mapping_reviews_resolved_mapping_check',
      sql`(${t.state} = 'resolved') = (${t.resolvedMappingId} is not null)`,
    ),
    check('catalog_external_mapping_reviews_occurrences_check', sql`${t.occurrences} >= 1`),
    check('catalog_external_mapping_reviews_priority_check', sql`${t.priority} >= 0`),
    check(
      'catalog_external_mapping_reviews_observed_order_check',
      sql`${t.lastObservedAt} >= ${t.firstObservedAt}`,
    ),
    // Candidates belong to an ambiguity and nothing else. Written with
    // `cardinality`, never `array_length`, which is NULL on `{}` and would make
    // a CHECK read NULL as satisfied.
    check(
      'catalog_external_mapping_reviews_candidates_check',
      sql`cardinality(${t.candidateMappingIds}) = 0 or ${t.reason} = 'ambiguous_candidates'`,
    ),
    check(
      'catalog_external_mapping_reviews_path_bound_check',
      sql`cardinality(${t.externalPath}) <= 32`,
    ),
    uniqueIndex('catalog_external_mapping_reviews_open_key')
      .on(t.catalogSourceId, t.dimension, t.externalKeyNormalized)
      .where(sql`${t.state} = 'open'`),
    index('catalog_external_mapping_reviews_queue_idx').on(
      t.state,
      t.priority.desc(),
      t.occurrences.desc(),
    ),
    index('catalog_external_mapping_reviews_source_idx').on(
      t.catalogSourceId,
      t.dimension,
      t.state,
    ),
  ],
);

/**
 * `catalog_external_token_observations` — which subject carried which token, and
 * what it resolved to at the time.
 *
 * This is the table that makes a preview honest. "What would this mapping
 * change?" is not answerable from the mapping alone, and it is not answerable by
 * reading another domain's `jsonb` payloads either — that would couple this
 * layer to a shape #62 owns and may change. So the resolver records the question
 * it was asked, and the preview counts over the answers.
 *
 * The consequence is stated rather than hidden: until ingestion calls the
 * resolver (a named seam), this table is EMPTY, and the preview reports
 * `no_observations_recorded` instead of a confident zero. A number nobody
 * measured is not zero — #82's `unmeasured`, applied to an impact estimate.
 *
 * ## The row IS the reprocessing job
 *
 * There is deliberately no outbox row pointing at an observation row — #48's
 * decision for `payment_provider_events`, for the same reason: a second durable
 * record of one job is a second thing that can be wrong. An `apply` run stamps
 * `reprocess_requested_at`; a consumer claims with a lease and an owner check.
 * Nothing consumes it today, which is a gated LOOP and never a gated record.
 */
export const catalogExternalTokenObservations = pgTable(
  'catalog_external_token_observations',
  {
    id: generatedId(),
    catalogSourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    dimension: text({ enum: asEnumValues(CATALOG_EXTERNAL_MAPPING_DIMENSIONS) }).notNull(),
    externalKey: text().notNull(),
    externalKeyNormalized: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("external_key"))`),
    subjectKind: text({ enum: asEnumValues(CATALOG_EXTERNAL_SUBJECT_KINDS) }).notNull(),
    /**
     * The subject's own id, with no foreign key.
     *
     * One polymorphic column cannot reference two tables, and the alternative
     * (two nullable columns plus a CHECK) would buy a constraint on rows that
     * are legitimately retired out from under this evidence — the
     * `attribute_value_reviews.entity_id` reasoning, one domain over.
     */
    subjectKey: text().notNull(),
    /** The source's value verbatim, before any transformation. */
    observedRawValue: text(),
    /** `restrict`: the resolution's authority must not vanish under it. */
    resolvedMappingId: text().references(() => catalogExternalMappings.id, {
      onDelete: 'restrict',
    }),
    /** `resolved` | `unresolved` — a string discriminant, for the `strict: false` reason. */
    resolutionOutcome: text({ enum: asEnumValues(CATALOG_EXTERNAL_RESOLUTION_OUTCOMES) }).notNull(),
    unresolvedReason: text({ enum: asEnumValues(CATALOG_EXTERNAL_UNRESOLVED_REASONS) }),
    firstObservedAt: timestamptz().notNull(),
    lastObservedAt: timestamptz().notNull(),
    occurrences: integer().notNull().default(1),

    // ── The row is the job ───────────────────────────────────────────────────
    reprocessRequestedAt: timestamptz(),
    reprocessClaimedAt: timestamptz(),
    reprocessClaimedBy: text(),
    reprocessClaimExpiresAt: timestamptz(),
    reprocessedAt: timestamptz(),
    reprocessAttempts: integer().notNull().default(0),
    reprocessLastError: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_external_token_observations_dimension_check',
      t.dimension,
      CATALOG_EXTERNAL_MAPPING_DIMENSIONS,
    ),
    checkOneOf(
      'catalog_external_token_observations_subject_kind_check',
      t.subjectKind,
      CATALOG_EXTERNAL_SUBJECT_KINDS,
    ),
    checkOneOf(
      'catalog_external_token_observations_unresolved_reason_check',
      t.unresolvedReason,
      CATALOG_EXTERNAL_UNRESOLVED_REASONS,
    ),
    checkOneOf(
      'catalog_external_token_observations_outcome_check',
      t.resolutionOutcome,
      CATALOG_EXTERNAL_RESOLUTION_OUTCOMES,
    ),
    // TWO biconditionals rather than one over their conjunction. The obvious
    // single spelling is SATISFIED by a row that is `unresolved` AND carries a
    // mapping id, because both sides evaluate false — the shape #126 and #81
    // each hit, so it is written out long-hand here.
    check(
      'catalog_external_token_observations_resolved_shape_check',
      sql`(${t.resolutionOutcome} = 'resolved') = (${t.resolvedMappingId} is not null)`,
    ),
    check(
      'catalog_external_token_observations_unresolved_shape_check',
      sql`(${t.resolutionOutcome} = 'unresolved') = (${t.unresolvedReason} is not null)`,
    ),
    check(
      'catalog_external_token_observations_external_key_shape_check',
      sql`btrim(${t.externalKey}) <> '' and length(${t.externalKey}) <= ${sql.raw(String(CATALOG_EXTERNAL_TOKEN_MAX_LENGTH))}`,
    ),
    check('catalog_external_token_observations_occurrences_check', sql`${t.occurrences} >= 1`),
    check(
      'catalog_external_token_observations_observed_order_check',
      sql`${t.lastObservedAt} >= ${t.firstObservedAt}`,
    ),
    check('catalog_external_token_observations_attempts_check', sql`${t.reprocessAttempts} >= 0`),
    // A claim is a lease: an owner and a deadline travel together, and neither
    // is meaningful alone (`attribute_reindex_requests`, verbatim).
    check(
      'catalog_external_token_observations_claim_check',
      sql`num_nonnulls(${t.reprocessClaimedAt}, ${t.reprocessClaimedBy}, ${t.reprocessClaimExpiresAt}) in (0, 3)`,
    ),
    // Nothing is reprocessed that was never requested.
    check(
      'catalog_external_token_observations_reprocess_order_check',
      sql`${t.reprocessedAt} is null or ${t.reprocessRequestedAt} is not null`,
    ),
    // One row per token per subject. `ON CONFLICT DO UPDATE` on this key is what
    // makes a repeated observation converge instead of accumulating — an
    // ingestion re-delivery must not multiply the impact figures.
    uniqueIndex('catalog_external_token_observations_subject_key').on(
      t.catalogSourceId,
      t.dimension,
      t.externalKeyNormalized,
      t.subjectKind,
      t.subjectKey,
    ),
    // The preview's read: every observation of one token.
    index('catalog_external_token_observations_token_idx').on(
      t.catalogSourceId,
      t.dimension,
      t.externalKeyNormalized,
    ),
    index('catalog_external_token_observations_pending_idx')
      .on(t.reprocessRequestedAt)
      .where(sql`${t.reprocessRequestedAt} is not null and ${t.reprocessedAt} is null`),
  ],
);

/**
 * `catalog_external_mapping_runs` — one reprocessing pass, dry or applied.
 *
 * `mode` is part of the run's identity rather than a parameter beside it (#60):
 * a dry run must never be able to overwrite the record of the apply it
 * predicted, or the comparison that justifies previewing at all is gone.
 *
 * The counters CHECK sums by EQUALITY, never `<=` — #60's
 * `catalog_backfill_runs_counters_total_check`. A page that swallowed a subject
 * cannot write a balancing row, so "the run went fine" and "the run read
 * nothing" stop producing the same output.
 */
export const catalogExternalMappingRuns = pgTable(
  'catalog_external_mapping_runs',
  {
    id: generatedId(),
    catalogSourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** NULL means every dimension of the source. */
    dimension: text({ enum: asEnumValues(CATALOG_EXTERNAL_MAPPING_DIMENSIONS) }),
    /** The mapping whose change prompted this, when one did. `restrict`. */
    mappingId: text().references(() => catalogExternalMappings.id, { onDelete: 'restrict' }),
    /** The mapping VERSION this run was computed against, so a re-read is reproducible. */
    mappingVersion: integer(),
    mode: text({ enum: asEnumValues(CATALOG_EXTERNAL_REPROCESS_MODES) }).notNull(),
    state: text({ enum: asEnumValues(CATALOG_EXTERNAL_REPROCESS_STATES) })
      .notNull()
      .default('pending'),
    requestedByOxyUserId: text().notNull(),
    /** Resumability: the normalized external key the last completed page reached. */
    cursorExternalKey: text(),

    scanned: integer().notNull().default(0),
    unchanged: integer().notNull().default(0),
    retargeted: integer().notNull().default(0),
    newlyMapped: integer().notNull().default(0),
    unmappedNow: integer().notNull().default(0),
    refused: integer().notNull().default(0),
    skipped: integer().notNull().default(0),

    claimedAt: timestamptz(),
    claimedBy: text(),
    claimExpiresAt: timestamptz(),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_external_mapping_runs_dimension_check',
      t.dimension,
      CATALOG_EXTERNAL_MAPPING_DIMENSIONS,
    ),
    checkOneOf('catalog_external_mapping_runs_mode_check', t.mode, CATALOG_EXTERNAL_REPROCESS_MODES),
    checkOneOf(
      'catalog_external_mapping_runs_state_check',
      t.state,
      CATALOG_EXTERNAL_REPROCESS_STATES,
    ),
    // The vacuity floor. Equality, never `<=`.
    check(
      'catalog_external_mapping_runs_counters_total_check',
      sql`${t.scanned} = ${t.unchanged} + ${t.retargeted} + ${t.newlyMapped} + ${t.unmappedNow} + ${t.refused} + ${t.skipped}`,
    ),
    check(
      'catalog_external_mapping_runs_counters_sign_check',
      sql`${t.scanned} >= 0 and ${t.unchanged} >= 0 and ${t.retargeted} >= 0
        and ${t.newlyMapped} >= 0 and ${t.unmappedNow} >= 0 and ${t.refused} >= 0
        and ${t.skipped} >= 0`,
    ),
    check(
      'catalog_external_mapping_runs_claim_check',
      sql`num_nonnulls(${t.claimedAt}, ${t.claimedBy}, ${t.claimExpiresAt}) in (0, 3)`,
    ),
    check(
      'catalog_external_mapping_runs_finished_check',
      sql`(${t.state} in ('completed', 'failed')) = (${t.finishedAt} is not null)`,
    ),
    check(
      'catalog_external_mapping_runs_failure_check',
      sql`${t.state} <> 'failed' or ${t.lastError} is not null`,
    ),
    check(
      'catalog_external_mapping_runs_mapping_version_check',
      sql`${t.mappingVersion} is null or ${t.mappingVersion} >= 1`,
    ),
    // One live run per source per mode. Two concurrent applies over one source
    // would interleave their cursors and each would report a partial pass as a
    // whole one.
    uniqueIndex('catalog_external_mapping_runs_active_key')
      .on(t.catalogSourceId, t.mode)
      .where(sql`${t.state} in ('pending', 'running')`),
    index('catalog_external_mapping_runs_source_idx').on(
      t.catalogSourceId,
      t.mode,
      t.createdAt.desc(),
    ),
  ],
);

/**
 * `catalog_external_mapping_run_items` — what a run concluded about one subject.
 *
 * The evidence beside the counter: #60's `scannedFromRecords` device, so a
 * metrics surface can report the run's own tally AND a count taken from the rows
 * it wrote, with `countsAgree` between them. A counter that only ever agrees
 * with itself measures nothing.
 *
 * `UNIQUE(run_id, subject_key)` is what makes a run RESUMABLE and IDEMPOTENT: a
 * reclaimed run skips every subject already recorded, and a repeated page writes
 * nothing new. Append-only by trigger — a run's conclusions are not editable
 * after the fact, or the dry run and the apply stop being comparable.
 */
export const catalogExternalMappingRunItems = pgTable(
  'catalog_external_mapping_run_items',
  {
    id: generatedId(),
    /** `cascade`: an item is meaningless without its run, and a run is never deleted. */
    runId: text()
      .notNull()
      .references(() => catalogExternalMappingRuns.id, { onDelete: 'cascade' }),
    subjectKind: text({ enum: asEnumValues(CATALOG_EXTERNAL_SUBJECT_KINDS) }).notNull(),
    /** No foreign key — the `catalog_external_token_observations.subject_key` reasoning. */
    subjectKey: text().notNull(),
    externalKey: text().notNull(),
    outcome: text({ enum: asEnumValues(CATALOG_EXTERNAL_REPROCESS_OUTCOMES) }).notNull(),
    /** What it resolved to before this run. `restrict`. */
    previousMappingId: text().references(() => catalogExternalMappings.id, {
      onDelete: 'restrict',
    }),
    /** What it resolves to after. `restrict`. */
    nextMappingId: text().references(() => catalogExternalMappings.id, { onDelete: 'restrict' }),
    /** Why, when the outcome was `refused` or `skipped`. */
    detail: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_external_mapping_run_items_subject_kind_check',
      t.subjectKind,
      CATALOG_EXTERNAL_SUBJECT_KINDS,
    ),
    checkOneOf(
      'catalog_external_mapping_run_items_outcome_check',
      t.outcome,
      CATALOG_EXTERNAL_REPROCESS_OUTCOMES,
    ),
    // Each outcome word has to match the pointers, or the counters above are a
    // tally of something the items do not say.
    check(
      'catalog_external_mapping_run_items_outcome_shape_check',
      sql`case ${t.outcome}
        when 'unchanged' then ${t.previousMappingId} is not distinct from ${t.nextMappingId}
        when 'retargeted' then ${t.previousMappingId} is not null and ${t.nextMappingId} is not null
                              and ${t.previousMappingId} <> ${t.nextMappingId}
        when 'newly_mapped' then ${t.previousMappingId} is null and ${t.nextMappingId} is not null
        when 'unmapped_now' then ${t.previousMappingId} is not null and ${t.nextMappingId} is null
        when 'refused' then ${t.nextMappingId} is null and ${t.detail} is not null
        when 'skipped' then ${t.nextMappingId} is null and ${t.detail} is not null
        else false
      end`,
    ),
    uniqueIndex('catalog_external_mapping_run_items_subject_key').on(t.runId, t.subjectKey),
    index('catalog_external_mapping_run_items_outcome_idx').on(t.runId, t.outcome),
  ],
);
