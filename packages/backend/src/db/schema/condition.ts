/**
 * The condition domain (#90): `listing_condition_details`,
 * `listing_condition_photos`, `listing_condition_revisions`,
 * `condition_mapping_rulesets`, `condition_source_mappings` and
 * `condition_category_policies`.
 *
 * The condition KEY itself is not here — it is a column on `listings` and on
 * `offers`, because it is a property of the thing being sold and a join to read
 * it would be a join on every catalogue page. What lives here is everything that
 * makes the key TRUSTWORTHY: the structured facts behind it, the photographic
 * evidence with its ownership and moderation state, the audit trail of every
 * correction, the versioned rules that map an external source's own words, and
 * the categories in which a condition may not be sold at all.
 *
 * ## The two constraints a reviewer must not remove
 *
 * 1. **`listing_condition_photos` has no representation of a catalogue image,
 *    and a TRIGGER refuses a file id one already claims** (#90 acceptance 4).
 *    The provenance tuple covers only seller-owned sources, which stops the
 *    obvious mistake; the trigger stops the real attack, which is a seller
 *    attaching the manufacturer's own product shot — a file id that is
 *    perfectly valid, belongs to them in no sense, and shows nothing about the
 *    unit in their hands.
 * 2. **An active mapping ruleset is FROZEN by trigger** (#90 migration rule 5).
 *    Correcting a mapping is publishing a new version, so an offer observed
 *    last month keeps citing the rules it was actually read under and nothing
 *    retroactively re-reads a source's words.
 *
 * Category-specific condition facts (battery health, activation lock, garment
 * alterations) are NOT tables here. They belong to #94's versioned attribute
 * registry, and `condition-isolation.test.ts` fails the build if this domain
 * grows a column for one.
 */

import { sql } from 'drizzle-orm';
import {
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
  CONDITION_DETAIL_KINDS,
  CONDITION_DETAIL_KINDS_REQUIRING_NOTE,
  CONDITION_DETAIL_KINDS_WITH_SEVERITY,
  CONDITION_DETAIL_SEVERITIES,
  CONDITION_MAPPING_CONFIDENCE_FLOOR,
  CONDITION_MAPPING_RULESET_STATES,
  CONDITION_PHOTO_MODERATION_STATES,
  CONDITION_PHOTO_PROVENANCES,
  CONDITION_RESTRICTION_REASONS,
  CONDITION_REVISION_ACTORS,
  CONDITION_ASSERTIONS,
  CONDITION_MAPPING_PROVIDER_IDS,
  IDENTIFIED_CONDITION_REVISION_ACTORS,
  ITEM_CONDITION_KEYS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { categories, listings } from './catalog';

/**
 * `listing_condition_details` — the structured facts a seller states about the
 * item's condition (#90 condition details 1, 2, 4, 5, 6, 7, 10).
 *
 * A real table rather than `jsonb`, for the reason `CONVENTIONS.md` gives
 * everywhere else: the shape is entirely known, the rows are queried by kind,
 * and a `jsonb` bag would let a write path invent a fourteenth kind that no
 * disclosure gate knows to look for.
 *
 * `UNIQUE(id, listing_id)` exists only to be the target of the composite foreign
 * key on `listing_condition_photos`. That is what makes "a photo may only
 * evidence a defect on ITS OWN listing" a relational fact rather than a check
 * somebody has to write, and there is no trigger doing the same job twice.
 */
export const listingConditionDetails = pgTable(
  'listing_condition_details',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(CONDITION_DETAIL_KINDS) }).notNull(),
    /** How bad it is, in the seller's own assessment. NULL on kinds that have no severity. */
    severity: text({ enum: asEnumValues(CONDITION_DETAIL_SEVERITIES) }),
    /** The seller's own words. Required on the kinds where a bare flag says nothing. */
    note: text(),
    /** Display order within the listing's disclosure list. */
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('listing_condition_details_kind_check', t.kind, CONDITION_DETAIL_KINDS),
    checkOneOf('listing_condition_details_severity_check', t.severity, CONDITION_DETAIL_SEVERITIES),
    // A severity on a kind that has none would be a number nobody can read: what
    // does a `heavy` warranty mean? Rendered from the shared tuple so adding a
    // kind with a severity is one edit, not two that can disagree.
    check(
      'listing_condition_details_severity_scope_check',
      sql`${t.severity} is null or ${t.kind} in (${sql.raw(
        CONDITION_DETAIL_KINDS_WITH_SEVERITY.map((k) => `'${k}'`).join(', '),
      )})`,
    ),
    // "There is a fault" with no description is not a disclosure. `btrim` rather
    // than `<> ''`: a note of three spaces is the same absence with extra steps.
    check(
      'listing_condition_details_note_required_check',
      sql`${t.kind} not in (${sql.raw(
        CONDITION_DETAIL_KINDS_REQUIRING_NOTE.map((k) => `'${k}'`).join(', '),
      )}) or (${t.note} is not null and length(btrim(${t.note})) > 0)`,
    ),
    // A table-level UNIQUE CONSTRAINT rather than a unique INDEX, and the
    // difference is not cosmetic: drizzle-kit emits constraints INSIDE the
    // `CREATE TABLE` and indexes AFTER every `ADD CONSTRAINT ... FOREIGN KEY`,
    // so the composite foreign key on `listing_condition_photos` would be
    // created before its target key existed and the migration would fail with
    // "there is no unique constraint matching given keys". Measured, not
    // assumed — that is exactly how it failed first time.
    unique('listing_condition_details_id_listing_id_key').on(t.id, t.listingId),
    index('listing_condition_details_listing_id_position_idx').on(t.listingId, t.position),
  ],
);

/**
 * `listing_condition_photos` — seller-owned photographic evidence of THIS unit
 * (#90 evidence rules 1–4, acceptance 4).
 *
 * ## Why the columns are what they are
 *
 * `uploaded_by_oxy_user_id` and `uploaded_at` are NOT NULL because #90 evidence
 * rule 3 asks for ownership and upload time, and because a row that cannot say
 * who produced it is not evidence of anything. `moderation_state` is the third
 * of the three, and `EVIDENTIAL_CONDITION_PHOTO_STATES` is what decides whether
 * a row still counts — so a listing whose photos are rejected stops meeting its
 * own condition's requirement instead of keeping a pass it earned once.
 *
 * ## Acceptance 4, in two independent places
 *
 * The `provenance` tuple has only seller-owned members, so there is no VALUE
 * meaning "a catalogue image" and no code path can record one. That alone is not
 * enough: a seller can attach the manufacturer's own product shot, whose file id
 * is a perfectly ordinary Oxy media id. The second half is
 * `mercaria_reject_canonical_condition_photo()`, a trigger that refuses a
 * `file_id` any `canonical_images` row already claims — hand-written, since
 * drizzle-kit cannot model a trigger, and therefore RE-APPLIED after any
 * regeneration of the migration.
 */
export const listingConditionPhotos = pgTable(
  'listing_condition_photos',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    fileId: text().notNull(),
    provenance: text({ enum: asEnumValues(CONDITION_PHOTO_PROVENANCES) }).notNull(),
    /** An Oxy account id — no foreign key. The person who attached it. */
    uploadedByOxyUserId: text().notNull(),
    uploadedAt: timestamptz().notNull(),
    moderationState: text({ enum: asEnumValues(CONDITION_PHOTO_MODERATION_STATES) })
      .notNull()
      .default('pending'),
    /** Set when moderation moved the state; NULL while it is still `pending`. */
    moderatedAt: timestamptz(),
    /** Whether the seller flagged this as showing a defect (#90 evidence rule 4). */
    showsDefect: boolean().notNull().default(false),
    /**
     * The disclosed defect this photo evidences, when the seller named one.
     *
     * Constrained by a COMPOSITE foreign key onto `(id, listing_id)` rather than
     * by a plain one onto `id`, so a photo can only point at a detail of its OWN
     * listing. `cascade`: the annotation is meaningless once the defect it
     * annotates is gone, and leaving a dangling pointer would make a photo claim
     * to show something no longer disclosed.
     */
    conditionDetailId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'listing_condition_photos_provenance_check',
      t.provenance,
      CONDITION_PHOTO_PROVENANCES,
    ),
    checkOneOf(
      'listing_condition_photos_moderation_state_check',
      t.moderationState,
      CONDITION_PHOTO_MODERATION_STATES,
    ),
    // A moderated photo has a moderation time and a pending one does not — the
    // biconditional, so neither half can drift into a state where "when was this
    // decided" has no answer.
    check(
      'listing_condition_photos_moderated_at_check',
      sql`(${t.moderationState} = 'pending') = (${t.moderatedAt} is null)`,
    ),
    foreignKey({
      name: 'listing_condition_photos_detail_fk',
      columns: [t.conditionDetailId, t.listingId],
      foreignColumns: [listingConditionDetails.id, listingConditionDetails.listingId],
    }).onDelete('cascade'),
    // One evidence row per (listing, file). A seller re-submitting the same photo
    // must converge rather than double the count the evidence gate reads.
    uniqueIndex('listing_condition_photos_listing_id_file_id_key').on(t.listingId, t.fileId),
    index('listing_condition_photos_listing_id_idx').on(t.listingId),
    index('listing_condition_photos_condition_detail_id_idx').on(t.conditionDetailId),
    // The moderation queue reads pending rows oldest first.
    index('listing_condition_photos_moderation_state_uploaded_at_idx').on(
      t.moderationState,
      t.uploadedAt,
    ),
  ],
);

/**
 * `listing_condition_revisions` — the audit trail of every condition change
 * (#90 evidence rule 8).
 *
 * APPEND-ONLY by trigger, which is the whole value: a correction that could be
 * edited afterwards is not an audit trail, it is a second mutable copy of the
 * current state. The `procurement`/`order_fee_snapshots` mechanism.
 *
 * There is deliberately no `reverted_revision_id`. Reverting a condition is
 * simply another revision naming the value it moves to — making it a function of
 * what is stored would let a chain of reversions become unreadable in exactly
 * the dispute where somebody needs to read it.
 */
export const listingConditionRevisions = pgTable(
  'listing_condition_revisions',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** The key before the change. NULL only on the row recording the first assertion. */
    fromCondition: text({ enum: asEnumValues(ITEM_CONDITION_KEYS) }),
    toCondition: text({ enum: asEnumValues(ITEM_CONDITION_KEYS) }).notNull(),
    fromAssertion: text({ enum: asEnumValues(CONDITION_ASSERTIONS) }),
    toAssertion: text({ enum: asEnumValues(CONDITION_ASSERTIONS) }).notNull(),
    actorKind: text({ enum: asEnumValues(CONDITION_REVISION_ACTORS) }).notNull(),
    /** An Oxy account id — no foreign key. Present exactly for the human actors. */
    actorOxyUserId: text(),
    /** Why. Free text by nature, and required: an unexplained correction is not one. */
    reason: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('listing_condition_revisions_from_condition_check', t.fromCondition, ITEM_CONDITION_KEYS),
    checkOneOf('listing_condition_revisions_to_condition_check', t.toCondition, ITEM_CONDITION_KEYS),
    checkOneOf(
      'listing_condition_revisions_from_assertion_check',
      t.fromAssertion,
      CONDITION_ASSERTIONS,
    ),
    checkOneOf(
      'listing_condition_revisions_to_assertion_check',
      t.toAssertion,
      CONDITION_ASSERTIONS,
    ),
    checkOneOf('listing_condition_revisions_actor_kind_check', t.actorKind, CONDITION_REVISION_ACTORS),
    // A person is named; a backfill is not. Both directions, because recording a
    // user id against a migration is a lie in an audit table and an anonymous
    // operator correction is an unattributable one.
    check(
      'listing_condition_revisions_actor_identity_check',
      sql`(${t.actorKind} in (${sql.raw(
        IDENTIFIED_CONDITION_REVISION_ACTORS.map((a) => `'${a}'`).join(', '),
      )})) = (${t.actorOxyUserId} is not null)`,
    ),
    // A revision must record a change. A row where nothing moved is noise in the
    // one place noise is most expensive to read.
    check(
      'listing_condition_revisions_change_check',
      sql`${t.fromCondition} is distinct from ${t.toCondition}
          or ${t.fromAssertion} is distinct from ${t.toAssertion}`,
    ),
    check(
      'listing_condition_revisions_reason_check',
      sql`length(btrim(${t.reason})) > 0`,
    ),
    index('listing_condition_revisions_listing_id_created_at_idx').on(
      t.listingId,
      t.createdAt.desc(),
    ),
  ],
);

/**
 * `condition_mapping_rulesets` — one VERSION of one provider's condition-label
 * rules (#90 migration rule 5, evidence rule 6).
 *
 * The `attribute_definitions` / `fee_schedules` lifecycle, applied to a mapping:
 * a version is editable while `draft`, frozen once `active`, and superseded by
 * publishing the next one. An offer records which version read its label, so
 * correcting a rule is publishing v2 and re-observing — never rewriting what v1
 * decided about an observation nobody re-read.
 *
 * `ONE active version per provider` is a partial unique index rather than a
 * service comparison, so two concurrent publishes cannot both win.
 */
export const conditionMappingRulesets = pgTable(
  'condition_mapping_rulesets',
  {
    id: generatedId(),
    /**
     * The connector or CATALOG SOURCE platform these rules read.
     *
     * Typed from `CONDITION_MAPPING_PROVIDER_IDS` and CHECKed from the same
     * tuple: a ruleset for a provider Mercaria cannot ingest from would be rules
     * nothing ever runs. #90 wrote this as `CONNECTOR_PROVIDER_IDS` because the
     * only sources with condition wording were the connectors a store syncs its
     * own shop from; #62's ingestion framework and #65's eBay adapter added a
     * second kind entirely, and the tuple is a SUPERSET of the connector one so
     * every existing ruleset, rule and offer keeps its provider unchanged.
     */
    provider: text({ enum: asEnumValues(CONDITION_MAPPING_PROVIDER_IDS) }).notNull(),
    /** Monotonic per provider. The number an offer cites. */
    version: integer().notNull(),
    state: text({ enum: asEnumValues(CONDITION_MAPPING_RULESET_STATES) })
      .notNull()
      .default('draft'),
    /** A one-line statement of what changed, for the operator reading the history. */
    note: text(),
    publishedAt: timestamptz(),
    /** An Oxy account id — no foreign key. The operator who published it. */
    publishedByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'condition_mapping_rulesets_provider_check',
      t.provider,
      CONDITION_MAPPING_PROVIDER_IDS,
    ),
    checkOneOf('condition_mapping_rulesets_state_check', t.state, CONDITION_MAPPING_RULESET_STATES),
    check('condition_mapping_rulesets_version_check', sql`${t.version} > 0`),
    // A draft has never been published and everything else has. The publisher is
    // demanded with the timestamp so "who decided this" is never unanswerable.
    check(
      'condition_mapping_rulesets_publication_check',
      sql`(${t.state} = 'draft') = (${t.publishedAt} is null)
          and (${t.publishedAt} is null) = (${t.publishedByOxyUserId} is null)`,
    ),
    uniqueIndex('condition_mapping_rulesets_provider_version_key').on(t.provider, t.version),
    uniqueIndex('condition_mapping_rulesets_provider_active_key')
      .on(t.provider)
      .where(sql`${t.state} = 'active'`),
  ],
);

/**
 * `condition_source_mappings` — one external label, normalized, mapped onto the
 * taxonomy under one ruleset version (#90 evidence rules 5 and 6).
 *
 * `confidence` is recorded whatever its value, INCLUDING below
 * `CONDITION_MAPPING_CONFIDENCE_FLOOR`. That is deliberate and is the whole of
 * evidence rule 6: a sub-floor rule is a real, visible, reviewable statement
 * that a source's wording PROBABLY means something — it simply may not be
 * applied to an offer, which is enforced one table over by
 * `offers_condition_mapping_state_check`. Deleting sub-floor rows instead would
 * make the review queue impossible to build.
 */
export const conditionSourceMappings = pgTable(
  'condition_source_mappings',
  {
    id: generatedId(),
    rulesetId: text()
      .notNull()
      .references(() => conditionMappingRulesets.id, { onDelete: 'cascade' }),
    /** The source's own wording, exactly as published. Never normalized in place. */
    sourceLabel: text().notNull(),
    /** `normalizeSourceConditionLabel(sourceLabel)` — the lookup key. */
    sourceLabelNormalized: text().notNull(),
    conditionKey: text({ enum: asEnumValues(ITEM_CONDITION_KEYS) }).notNull(),
    /** 0–1. Below the floor the rule is visible and unappliable, never deleted. */
    confidence: doublePrecision().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('condition_source_mappings_condition_key_check', t.conditionKey, ITEM_CONDITION_KEYS),
    check(
      'condition_source_mappings_confidence_check',
      sql`${t.confidence} >= 0 and ${t.confidence} <= 1`,
    ),
    check(
      'condition_source_mappings_source_label_check',
      sql`length(btrim(${t.sourceLabel})) > 0 and length(btrim(${t.sourceLabelNormalized})) > 0`,
    ),
    // One verdict per (ruleset, label). Two rows disagreeing about one wording
    // inside one version would make the mapping non-deterministic, which is the
    // one property a mapping has to have.
    uniqueIndex('condition_source_mappings_ruleset_id_label_key').on(
      t.rulesetId,
      t.sourceLabelNormalized,
    ),
  ],
);

/**
 * `condition_category_policies` — the conditions a category refuses (#90 policy
 * rule 5).
 *
 * Rows name what is FORBIDDEN and absence means allowed. Default-allow is the
 * honest direction here, and it is not the fail-open reflex it looks like: the
 * taxonomy is universal, a restriction is a statement somebody made about a
 * specific category, and a category with no rows means "nobody has restricted
 * this" — which is true — rather than "everything is forbidden until an
 * operator enumerates nine permissions per category", which would refuse the
 * entire catalogue on the day this ships.
 *
 * `include_descendants` follows `attribute_definition_categories`: a safety
 * restriction on `electronics` should reach `electronics/phones` without an
 * operator re-entering it per leaf, and the cases where it should not are real
 * enough to need the flag.
 */
export const conditionCategoryPolicies = pgTable(
  'condition_category_policies',
  {
    id: generatedId(),
    /**
     * `cascade`: this row is a statement ABOUT that category and means nothing
     * without it. Nothing deletes a category today; if that changes, a policy
     * naming a category that no longer exists would silently restrict nothing
     * while still appearing in the operator list.
     */
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    conditionKey: text({ enum: asEnumValues(ITEM_CONDITION_KEYS) }).notNull(),
    restriction: text({ enum: asEnumValues(CONDITION_RESTRICTION_REASONS) }).notNull(),
    includeDescendants: boolean().notNull().default(true),
    /** Why this category refuses this condition. Shown to the seller, so it is required. */
    reason: text().notNull(),
    /** An Oxy account id — no foreign key. The operator who recorded it. */
    createdByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'condition_category_policies_condition_key_check',
      t.conditionKey,
      ITEM_CONDITION_KEYS,
    ),
    checkOneOf(
      'condition_category_policies_restriction_check',
      t.restriction,
      CONDITION_RESTRICTION_REASONS,
    ),
    check('condition_category_policies_reason_check', sql`length(btrim(${t.reason})) > 0`),
    uniqueIndex('condition_category_policies_category_id_condition_key_key').on(
      t.categoryId,
      t.conditionKey,
    ),
    index('condition_category_policies_condition_key_idx').on(t.conditionKey),
  ],
);

/**
 * The floor rendered into `offers_condition_mapping_state_check`.
 *
 * Exported so the migration's CHECK and `condition-mapping.service.ts` read ONE
 * number. `toFixed(2)` rather than the raw float: `0.75` serializes cleanly, but
 * a future value like `0.7000000000000001` would land a constraint text nobody
 * can read and that no test would notice was wrong.
 */
export const CONDITION_MAPPING_CONFIDENCE_FLOOR_SQL =
  CONDITION_MAPPING_CONFIDENCE_FLOOR.toFixed(2);
