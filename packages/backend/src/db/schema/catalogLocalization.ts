/**
 * Catalog localization (ADR 0007 D4, epic #367 merge-order step 2) — the
 * per-entity localization family and the localized-slug record.
 *
 * Four tables: `category_localizations`, `category_localized_slugs`,
 * `product_type_localizations` and `attribute_value_localizations`.
 * `attribute_labels` (#94) is the family's fourth TEXT member and is ADOPTED
 * rather than duplicated — it lives in `attributeRegistry.ts` and owes the
 * family columns; `LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS` in
 * `@mercaria/shared-types` names it, with the reason, and the count of
 * exemptions is asserted so the list cannot quietly grow.
 *
 * ## Why four tables and not one
 *
 * A polymorphic `(entity_type, entity_id, locale, field, value)` table was
 * rejected by the ADR, and the reason is not tidiness: `entity_id` could carry
 * no foreign key, so an orphaned translation of a deleted category would be
 * invisible — no constraint could refuse it and no join could find it. Per
 * entity, `cascade` is a real constraint that actually works, `UNIQUE(entity_id,
 * locale)` is a real index, and the planner sees a two-column lookup instead of
 * a discriminator it cannot use.
 *
 * The cost is that four tables can drift into four slightly different shapes.
 * `LOCALIZATION_FAMILY_COLUMNS` is stated once in shared-types and
 * `db/__tests__/catalog-localization.test.ts` walks the real drizzle tables and
 * asserts every non-exempt member carries exactly it — which is the census a
 * polymorphic table gets for free and a per-entity family has to earn.
 *
 * ## The base locale is not a row here, and that is a CHECK
 *
 * `categories.name` IS the base-locale name. If a `category_localizations` row
 * could carry `locale = 'en'` there would be two representations of one string
 * and nothing saying which wins — the failure this schema spends most of its
 * length avoiding elsewhere. `<table>_locale_not_base_check` is rendered from
 * `MERCARIA_BASE_LOCALE`, so the second representation has no row shape.
 *
 * The consequence is deliberate and shows up in the resolver's signature: the
 * base value is read from the ENTITY's own column and passed in, so a fallback
 * all the way to base is answered from the one place that text lives.
 *
 * ## What this layer structurally cannot hold
 *
 * - **No machine translation over human work.** Two CHECKs make the ROW
 *   unrepresentable (`_machine_status_check`, `_machine_reviewer_check`) and one
 *   trigger refuses the TRANSITION. Neither covers the other: a machine write
 *   that also downgrades the status passes both CHECKs, and an INSERT claiming
 *   `machine` + `approved` never fires an UPDATE trigger.
 * - **No mutable slug.** A slug change is a new row plus a redirect;
 *   `mercaria_category_localized_slug_frozen` refuses an UPDATE of the category,
 *   the locale or the slug outright, so a link somebody shared cannot be broken
 *   by an edit.
 * - **No `status` on a slug row.** `superseded_at` already answers "is this the
 *   current one", and a `deprecated` status beside it would be a second answer
 *   to that question.
 * - **No jsonb.** Every localized string, its status, its provenance and its
 *   review audit are real columns with real constraints (ADR 0007 D14).
 */

import { sql, type SQL } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import {
  LOCALIZATION_PROVENANCES,
  LOCALIZATION_REVISION_ACTIONS,
  LOCALIZATION_REVISION_FIELD_PAIRS,
  LOCALIZATION_STATUSES,
  LOCALIZED_ENTITY_KINDS,
  LOCALIZED_FIELD_KEYS,
  MERCARIA_BASE_LOCALE,
  SUPPORTED_LOCALES,
  UNANALYZED_TEXT_SEARCH_CONFIGURATION,
  localesByTextSearchConfiguration,
  type PostgresTextSearchConfiguration,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import {
  LOCALE_VALUES,
  localizationChecks,
  localizationColumns,
} from './localizationFamily';
import { categories, listings } from './catalog';
import { attributeEnumValues } from './attributeRegistry';
import { productTypeDefinitions, productTypeFields } from './productTypes';
import { canonicalProductFamilies, canonicalProducts } from './canonicalCatalog';




/**
 * `category_localizations` — one locale's presentation of one category.
 *
 * `cascade`: a translation of a deleted category is meaningless, and nothing
 * else points at it. That is the opposite of the decision `categories.parent_id`
 * makes one table over (`restrict`, because re-parenting or destroying a subtree
 * silently are both worse than refusing) and the difference is what the row IS —
 * a subtree is a thing, a translation is a facet of one.
 *
 * `description` has no base-locale counterpart on `categories` today, so a
 * resolution of `category.description` can fall all the way through and answer
 * `unavailable`. That is correct: a category with no description in any locale
 * has none, and inventing one from the name is how a catalogue starts asserting
 * things nobody wrote.
 */
export const categoryLocalizations = pgTable(
  'category_localizations',
  {
    id: generatedId(),
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    ...localizationColumns(),
    /** The localized category name. NULL exactly when `status = 'missing'`. */
    name: text(),
    /** Optional in every locale, including the base one. */
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...localizationChecks('category_localizations', { ...t, primaryText: t.name }),
    uniqueIndex('category_localizations_locale_key').on(t.categoryId, t.locale),
    // The translation desk's index — see the closing note. `locale` leads
    // because every desk read narrows to a locale first; `status` follows so the
    // per-status counts are answered from the index rather than the heap.
    index('category_localizations_locale_status_idx').on(t.locale, t.status),
  ],
);

/**
 * `category_localized_slugs` — one locale's URL for one category, and every URL
 * it ever had.
 *
 * ## A slug change is a new row, never an UPDATE
 *
 * `mercaria_category_localized_slug_frozen` refuses an UPDATE of `category_id`,
 * `locale` or `slug`. The retirement columns are the only thing that moves. That
 * is what makes "a slug change never breaks a link somebody shared" a property
 * of the table rather than of whoever wrote the update: the old row survives,
 * still pointing at its category, and `category_redirects` (ADR 0007 D2, the
 * taxonomy module's) is what turns it into a 301.
 *
 * ## Two uniques, and the full one is the interesting half
 *
 * `UNIQUE(locale, slug)` covers superseded rows too, so a retired slug can never
 * be reissued to a DIFFERENT category. Without that, `zapatos` retired from
 * category A and granted to category B would make every link to A's old URL
 * resolve to B — a redirect that silently lies, which is worse than a 404. The
 * partial unique beside it is what makes "the current one" a single row rather
 * than a query with a bug in it.
 *
 * ## No `status` column
 *
 * The family's `status` vocabulary describes how settled a TRANSLATION is;
 * `superseded_at` already answers the only lifecycle question a slug has, and a
 * `deprecated` status beside it would be a second answer to it. `provenance`
 * stays, because "a person chose this URL" and "it was generated from the
 * localized name" are genuinely different facts about a slug.
 */
export const categoryLocalizedSlugs = pgTable(
  'category_localized_slugs',
  {
    id: generatedId(),
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** Lowercase BCP 47, never the base locale — `categories.slug` is that one. */
    locale: text({ enum: LOCALE_VALUES }).notNull(),
    slug: text().notNull(),
    provenance: text({ enum: asEnumValues(LOCALIZATION_PROVENANCES) }).notNull(),
    /** An Oxy account id — no foreign key. */
    issuedByOxyUserId: text(),
    supersededAt: timestamptz(),
    /**
     * The slug that replaced this one, when one did.
     *
     * `restrict`, and self-referencing: the successor of a retired slug is the
     * chain a redirect follows, so deleting the row somebody was pointed AT must
     * be refused rather than silently emptying the pointer.
     */
    supersededBySlugId: text().references((): AnyPgColumn => categoryLocalizedSlugs.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('category_localized_slugs_locale_check', t.locale, SUPPORTED_LOCALES),
    checkOneOf(
      'category_localized_slugs_provenance_check',
      t.provenance,
      LOCALIZATION_PROVENANCES,
    ),
    check(
      'category_localized_slugs_locale_not_base_check',
      sql`${t.locale} <> ${sql.raw(`'${MERCARIA_BASE_LOCALE}'`)}`,
    ),
    // No backslash appears in this pattern deliberately: a regex written into a
    // JS string loses its escapes on the way to the migration, and a `\.` that
    // becomes `.` is a CHECK that admits what it exists to refuse.
    check(
      'category_localized_slugs_shape_check',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    // A successor implies a retirement. The reverse is not implied: the LAST
    // slug of a deprecated category is retired with nothing to point at.
    check(
      'category_localized_slugs_supersede_check',
      sql`${t.supersededBySlugId} is null or ${t.supersededAt} is not null`,
    ),
    // A slug never points at itself; a self-successor is an infinite redirect.
    check(
      'category_localized_slugs_self_supersede_check',
      sql`${t.supersededBySlugId} is null or ${t.supersededBySlugId} <> ${t.id}`,
    ),
    // Covers RETIRED rows too. See the doc above — this is the one that stops a
    // redirect quietly resolving to somebody else's category.
    uniqueIndex('category_localized_slugs_locale_slug_key').on(t.locale, t.slug),
    uniqueIndex('category_localized_slugs_current_key')
      .on(t.categoryId, t.locale)
      .where(sql`${t.supersededAt} is null`),
    index('category_localized_slugs_category_idx').on(t.categoryId, t.locale),
  ],
);

/**
 * `product_type_localizations` — one locale's presentation of one product-type
 * version (ADR 0007 D5, merge-order step 3).
 *
 * `cascade`, for the reason `category_localizations` cascades: a translation of a
 * deleted definition version is meaningless and nothing else points at it. The
 * relation spent one branch in `DEFERRED_FOREIGN_KEYS` while D5 was built in
 * parallel, and `schema-conventions.test.ts` refused the deferral the moment
 * `product_type_definitions` entered the barrel — which is what turned it into
 * the real reference below rather than a note nobody revisited.
 *
 * A product-type localization is per VERSION, not per key, because D5 freezes a
 * published version's meaning — and a translation is of a meaning. Sharing one
 * translation across versions would let a v2 that changed what a field asks for
 * inherit the v1 help text that described the old question. Confirmed against
 * what D5 shipped: `product_type_definitions_key_version_key` is unique on
 * `(key, version)`, so a version IS a row with its own id.
 */
export const productTypeLocalizations = pgTable(
  'product_type_localizations',
  {
    id: generatedId(),
    productTypeDefinitionId: text()
      .notNull()
      .references(() => productTypeDefinitions.id, { onDelete: 'cascade' }),
    ...localizationColumns(),
    /** The localized product-type name. NULL exactly when `status = 'missing'`. */
    name: text(),
    description: text(),
    /** Authoring guidance — what a merchant is being asked for, in their language. */
    helpText: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...localizationChecks('product_type_localizations', { ...t, primaryText: t.name }),
    uniqueIndex('product_type_localizations_locale_key').on(t.productTypeDefinitionId, t.locale),
    index('product_type_localizations_locale_status_idx').on(t.locale, t.status),
  ],
);

/**
 * `product_type_field_localizations` — one locale's authoring copy for ONE
 * FIELD of one product-type version (ADR 0007 D10).
 *
 * ## Why this is a different subject from `product_type_localizations`
 *
 * That table localizes the FORM — what a smartphone schema is and what it is
 * for. This one localizes a QUESTION on it. Folding the two together would make
 * "what is this form for" and "what does this box want" the same string, and the
 * second is the one a merchant is actually stuck on.
 *
 * ## What it replaces, and the direction the old behaviour was wrong in
 *
 * Before this table a field's label and help were read off the cited
 * ATTRIBUTE's `attribute_labels` row. That table is the family's one
 * exemption — it carries no `status` and no `provenance` — so
 * `services/catalog-authoring/schema.service.ts` walks the fallback chain for
 * those rows and then reports every hit as `step: 'base'`, `status: 'approved'`,
 * counting it as UNRESOLVED in the coverage figure.
 *
 * That is worth stating precisely, because the tempting description is the
 * wrong one: the service **under**-claims. A label genuinely found in the
 * requested locale is reported as base and counted as a gap. It is not a
 * confident 100% over machine output — it is the honest reading of a table that
 * records neither fact, with a counter that errs toward showing an operator
 * work rather than hiding it. Nothing here is fixing a lie; it is giving the
 * field somewhere to record what the attribute registry structurally cannot.
 *
 * ## Four localized columns, and the base of each lives on the FIELD
 *
 * `product_type_fields` gained nullable `label`, `help_text`, `placeholder` and
 * `example` in the same change, because `_locale_not_base_check` refuses a row
 * here carrying the base locale — the base string lives on the entity's own
 * column, family-wide. Without those four the base-locale placeholder and
 * example would have had no row shape at all, which is exactly the state
 * `schema.service.ts` recorded in-code: "the field arrives when a column does."
 *
 * `label` is the `primaryText`, so a `missing` row is one somebody opened to say
 * a translation is owed. `placeholder` and `example` are deliberately NOT
 * primary: a field can be perfectly well translated and legitimately have
 * neither, and making either define `missing` would fill the translation queue
 * with work nobody owes.
 *
 * ## Not frozen, unlike the field it hangs off
 *
 * `mercaria_product_type_child_frozen` freezes `product_type_fields` once the
 * version leaves `draft`/`review`. These rows are deliberately outside it — the
 * split `product_type_localizations` already makes. A published contract is
 * fixed; its wording in Catalan is still a translator's to finish, and freezing
 * the translations with the contract would mean a version could never be
 * localized after it went live, which is when localizing it matters.
 *
 * `cascade`: a translation of a deleted field is meaningless and nothing else
 * points at it.
 */
export const productTypeFieldLocalizations = pgTable(
  'product_type_field_localizations',
  {
    id: generatedId(),
    productTypeFieldId: text()
      .notNull()
      .references(() => productTypeFields.id, { onDelete: 'cascade' }),
    ...localizationColumns(),
    /** The localized field label. NULL exactly when `status = 'missing'`. */
    label: text(),
    /** Authoring guidance for this one question, in the merchant's language. */
    helpText: text(),
    /** Shown INSIDE an empty input. Never a value, never submitted. */
    placeholder: text(),
    /** A worked illustration shown BESIDE the input. Also never submitted. */
    example: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...localizationChecks('product_type_field_localizations', { ...t, primaryText: t.label }),
    uniqueIndex('product_type_field_localizations_locale_key').on(t.productTypeFieldId, t.locale),
    // The desk's index, for the reason the other three carry one: its read
    // narrows on `locale` and the unique above leads with the FIELD id, so it
    // cannot serve that predicate. This table is the largest of the four by
    // construction — (fields × locales) rather than (entities × locales) — which
    // makes it the one where the scan it removes matters most.
    index('product_type_field_localizations_locale_status_idx').on(t.locale, t.status),
  ],
);

/**
 * `attribute_value_localizations` — one locale's label for one controlled value
 * (#94's `attribute_enum_values`).
 *
 * It localizes the LABEL and never the `value`. `attribute_enum_values.value` is
 * the canonical, normalized string every assignment stores and every alias
 * resolves to; a per-locale `value` would make a stored fact mean different
 * things in different markets, which is the identity failure ADR 0007 D1 exists
 * to prevent. There is no column here that could hold one.
 */
export const attributeValueLocalizations = pgTable(
  'attribute_value_localizations',
  {
    id: generatedId(),
    attributeEnumValueId: text()
      .notNull()
      .references(() => attributeEnumValues.id, { onDelete: 'cascade' }),
    ...localizationColumns(),
    /** The localized label. NULL exactly when `status = 'missing'`. */
    label: text(),
    /** Optional disambiguation for a reviewer or a shopper — `Ash (tree)`. */
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...localizationChecks('attribute_value_localizations', { ...t, primaryText: t.label }),
    uniqueIndex('attribute_value_localizations_locale_key').on(t.attributeEnumValueId, t.locale),
    index('attribute_value_localizations_locale_status_idx').on(t.locale, t.status),
  ],
);

/*
 * The `(locale, status)` indexes above arrived with their reader (#367 step 10).
 *
 * They were deliberately absent until it did: the note this replaces recorded
 * that "the translation desk that asks it is #367 merge-order step 10", that
 * three indexes over three tables each carrying roughly (entities × locales)
 * rows is a real write cost paid on every translation save, and that an index
 * whose reader arrives later is a one-statement additive migration while one
 * whose reader never arrives is permanent. The desk is that reader:
 * `db/catalogLocalization/completenessRepository.ts` joins each of the three
 * tables on `locale` for every locale in scope, and `<table>_locale_key` cannot
 * serve that — its leading column is the ENTITY id, not the locale. The write
 * cost is now paid for a query somebody runs rather than banked against one
 * nobody does.
 *
 * `findCategoryLocalizationCoverage`'s one-category read is still served by the
 * leading column of `category_localizations_locale_key` and is unaffected.
 *
 * A `localization_coverage_runs` table is deliberately ABSENT, and the desk
 * landing did NOT change that.
 *
 * "How much of the catalogue is translated into Spanish" is a QUERY over these
 * tables — the indexes above are what serve it — and storing its answer would be
 * a second representation of a fact the rows already carry, going stale the
 * moment a translator saves. `attribute_coverage_runs`' absence one file over is
 * the precedent and the reasoning is identical.
 *
 * (The sentence this note replaces cited
 * `category_localizations_locale_status_idx` as though it existed while the
 * paragraph above it said the index was absent. The two halves contradicted each
 * other from the day they were written; the index named there is the one now
 * created, so the citation is true for the first time rather than merely tidied.)
 */

/**
 * `catalog_localization_revisions` — what a localized string used to say
 * (#367 merge-order step 10, box 4).
 *
 * ## Written by TRIGGERS, which is what makes it complete
 *
 * A set of `AFTER INSERT OR UPDATE` triggers, one on each COVERED text table,
 * are the only writers — enumerated in `services/catalog-event-contracts.ts`
 * under `CATALOG_EVENT_CONTRACTS.translation_change`, whose gate derives the
 * same set from the migration SQL. This docblock said "four, one per text
 * table" and there were eight by the time anybody read it — and "one per text
 * table" was wrong in a second way, because three of the eleven localized
 * tables are deliberately NOT covered (`LOCALIZED_TABLE_TRAIL_COVERAGE` in the
 * same module carries each reason). Both numbers now live where they can fail.
 * A trail written by a repository records what the service did and
 * misses a backfill script, an operator at a `psql` prompt and the stale
 * triggers this same file already installs — and the gaps are invisible,
 * because a missing revision looks exactly like a field nobody edited. Writing
 * it at the row is the same reasoning the append-only guards elsewhere give for
 * being triggers rather than service discipline.
 *
 * ## It is NOT a governance subject, deliberately
 *
 * Widening `CATALOG_GOVERNANCE_SUBJECT_KINDS` was considered and refused.
 * `catalog_governance_audit_events` records THAT a translation's status changed
 * and deliberately omits the body — "a translation body in an audit row is a
 * copy of the text a correction can never reach" — which is correct for an
 * audit trail and is exactly why it cannot be the home for a history whose
 * point is the text. And a governance subject carries the operator gate, four
 * eyes and the change-request flow, which would attach an operator's cadence to
 * work translators and store staff do. `catalog_revisions` (#59) and
 * `review_target_migrations` (#76) are the precedent: an append-only trail owned
 * by its own domain.
 *
 * ## One row per FIELD, not per save
 *
 * A save that changes a name and a description writes two rows. That is what
 * makes a per-field diff a `lag()` over one partition rather than a comparison
 * of two blobs, and it is why there is no `jsonb` here — ADR 0007 D14 keeps
 * every localized string a real column, and a revision of a string is a string.
 *
 * ## No foreign key on `entity_id`, permanently
 *
 * `catalog_revisions`' ruling, for its reason: this table spans four entity
 * types and its rows must OUTLIVE their subject. A localization row is deleted
 * only by cascade when its entity is, and the history of what a category used
 * to be called in Spanish is precisely the thing that must survive the category
 * going away. The family's own header rejects a polymorphic LOCALIZATION table
 * because an orphaned translation would be invisible — that argument is about
 * CURRENT state, and it inverts for a history, which is worthless if it dies
 * with its subject.
 */
export const catalogLocalizationRevisions = pgTable(
  'catalog_localization_revisions',
  {
    id: generatedId(),
    action: text({ enum: asEnumValues(LOCALIZATION_REVISION_ACTIONS) }).notNull(),
    entityKind: text({ enum: asEnumValues(LOCALIZED_ENTITY_KINDS) }).notNull(),
    /** No foreign key, permanently. See the header. */
    entityId: text().notNull(),
    locale: text({ enum: LOCALE_VALUES }).notNull(),
    fieldKey: text({ enum: asEnumValues(LOCALIZED_FIELD_KEYS) }).notNull(),
    /** What the field said AFTER this revision. NULL is a real value. */
    value: text(),
    status: text({ enum: asEnumValues(LOCALIZATION_STATUSES) }).notNull(),
    provenance: text({ enum: asEnumValues(LOCALIZATION_PROVENANCES) }).notNull(),
    /**
     * Who the ROW credited at this moment, never who ran the statement — a
     * trigger sees the row and not the session. See the DTO's own note.
     */
    creditedOxyUserId: text(),
    /**
     * The revision this one undoes. `restrict`: the row somebody was pointed at
     * must not vanish out from under the pointer, which is
     * `category_localized_slugs.superseded_by_slug_id`'s reasoning one table up.
     */
    rollbackOfRevisionId: text().references((): AnyPgColumn => catalogLocalizationRevisions.id, {
      onDelete: 'restrict',
    }),
    // Append-only: no `updated_at`, the `catalog_revisions` contract.
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_localization_revisions_action_check',
      t.action,
      LOCALIZATION_REVISION_ACTIONS,
    ),
    checkOneOf(
      'catalog_localization_revisions_entity_kind_check',
      t.entityKind,
      LOCALIZED_ENTITY_KINDS,
    ),
    checkOneOf('catalog_localization_revisions_locale_check', t.locale, SUPPORTED_LOCALES),
    checkOneOf('catalog_localization_revisions_field_key_check', t.fieldKey, LOCALIZED_FIELD_KEYS),
    checkOneOf('catalog_localization_revisions_status_check', t.status, LOCALIZATION_STATUSES),
    checkOneOf(
      'catalog_localization_revisions_provenance_check',
      t.provenance,
      LOCALIZATION_PROVENANCES,
    ),
    check('catalog_localization_revisions_entity_id_check', sql`btrim(${t.entityId}) <> ''`),
    // The base locale has no revision because it has no row — the base string
    // lives on the entity's own column, which this trail does not watch.
    check(
      'catalog_localization_revisions_locale_not_base_check',
      sql`${t.locale} <> ${sql.raw(`'${MERCARIA_BASE_LOCALE}'`)}`,
    ),
    /**
     * The entity kind and the field key must describe ONE registered field.
     *
     * A pair membership test and NOT a prefix rule, because a prefix rule is
     * wrong in a way that is easy to miss: `product_type_field.label` begins
     * with `product_type`, so "the key starts with the kind" would admit a
     * `product_type` revision carrying a `product_type_field` column. Rendered
     * from `LOCALIZATION_REVISION_FIELD_PAIRS`, which is derived from the field
     * registry, so a field added there joins this CHECK in the same commit.
     */
    check(
      'catalog_localization_revisions_field_pair_check',
      sql`${t.entityKind} || '|' || ${t.fieldKey} in ${sql.raw(
        `(${LOCALIZATION_REVISION_FIELD_PAIRS.map((pair) => `'${pair}'`).join(', ')})`,
      )}`,
    ),
    // Only a rollback may name what it undoes, and it must. The
    // `catalog_revisions_compensation_shape_check` biconditional.
    check(
      'catalog_localization_revisions_rollback_shape_check',
      sql`(${t.action} = 'rollback') = (${t.rollbackOfRevisionId} is not null)`,
    ),
    check(
      'catalog_localization_revisions_rollback_self_check',
      sql`${t.rollbackOfRevisionId} is null or ${t.rollbackOfRevisionId} <> ${t.id}`,
    ),
    // A machine translation names no reviewer, so it credits nobody either —
    // the family's `_machine_reviewer_check`, carried onto the trail so a
    // revision cannot claim a person stood behind a machine's text.
    check(
      'catalog_localization_revisions_machine_credit_check',
      sql`${t.provenance} <> 'machine' or ${t.creditedOxyUserId} is null`,
    ),
    /**
     * THE HISTORY QUERY: one field's timeline, newest first. The index is that
     * read's own shape, which is why `entity_id` has no foreign key and still
     * has an ordering — `catalog_revisions_entity_idx`'s reasoning.
     */
    index('catalog_localization_revisions_field_idx').on(
      t.entityKind,
      t.entityId,
      t.locale,
      t.fieldKey,
      t.createdAt.desc(),
    ),
    /** The desk's "what changed in Spanish lately" read. */
    index('catalog_localization_revisions_locale_idx').on(t.locale, t.createdAt.desc()),
  ],
);

/**
 * `canonical_product_localizations` — one locale's presentation of one canonical
 * product (#367, Translation model L2).
 *
 * ## What it may hold, and what it structurally cannot
 *
 * `name` and `description`, and nothing else. ADR 0007 states as the single
 * invariant of the whole epic that "a label, name, description or slug is
 * presentation and is never identity" — which settles the general case in the
 * PERMISSIVE direction: translating a canonical product's name is the point.
 *
 * What this table has no column for is the set of fields that read like a name
 * and are not presentation, each for a different reason
 * (`INVARIANT_CATALOG_NAMES` in shared-types states them with those reasons):
 *
 * - **`normalized_name`** is derived FROM the name for matching. A per-locale
 *   one would make one product resolve differently per market, which is the
 *   identity failure ADR 0007 D1 exists to prevent. Note that
 *   `canonical_product_aliases` already carries a `localized_name` KIND and is
 *   NOT presentation — its unique is `(product_id, normalized_alias)` with no
 *   locale column, so it answers alias → product and can never answer "what is
 *   this called in es-MX".
 * - **`model_code`** is the manufacturer's own designation.
 * - **`slug`** is a URL somebody may have shared; a LOCALIZED slug is its own
 *   table with retirement and redirects (`category_localized_slugs`), never a
 *   column here. Deferred, not refused.
 * - a **brand's name** is reached through `brand_id` and is a trademarked proper
 *   noun, so the prohibition is on a `brand_localizations` table that does not
 *   exist rather than on a column here.
 *
 * The enforcement is the ABSENCE of those columns, and
 * `catalog-name-invariance.test.ts` walks this table and fails the build if one
 * appears — because a missing column is invisible, and "nobody added it yet" and
 * "it may never be added" look identical in a schema.
 *
 * ## A merge rehomes it, and the census forced that decision
 *
 * `canonical_products` is one of the seven mergeable entities, so
 * `merge-plan-census.test.ts` refused this table until `merge-plan.ts` said what
 * a merge does with it. The answer is `repoint_if_absent` guarded on this
 * table's own unique — the `product_saves` shape — so a loser-side Spanish name
 * follows its product onto the winner unless the winner already HAS a Spanish
 * name, in which case the loser's stays on the tombstone rather than aborting
 * the phase.
 */
export const canonicalProductLocalizations = pgTable(
  'canonical_product_localizations',
  {
    id: generatedId(),
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    ...localizationColumns(),
    /** The localized product name. NULL exactly when `status = 'missing'`. */
    name: text(),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...localizationChecks('canonical_product_localizations', { ...t, primaryText: t.name }),
    uniqueIndex('canonical_product_localizations_locale_key').on(t.canonicalProductId, t.locale),
    index('canonical_product_localizations_locale_status_idx').on(t.locale, t.status),
  ],
);

/**
 * `canonical_product_family_localizations` — one locale's presentation of one
 * product family (#367, Translation model L2).
 *
 * The same shape and the same prohibitions as the product table above, because
 * `canonical_product_families` carries the same columns for the same reasons —
 * `slug`, `name`, `normalized_name`, `description`, `brand_id`. A family is a
 * mergeable entity too, so it carries its own merge disposition.
 *
 * Separate from the product table rather than polymorphic, for the reason the
 * whole family is per-entity: `entity_id` could carry no foreign key, and an
 * orphaned translation of a deleted family would be invisible.
 */
export const canonicalProductFamilyLocalizations = pgTable(
  'canonical_product_family_localizations',
  {
    id: generatedId(),
    canonicalProductFamilyId: text()
      .notNull()
      .references(() => canonicalProductFamilies.id, { onDelete: 'cascade' }),
    ...localizationColumns(),
    /** The localized family name. NULL exactly when `status = 'missing'`. */
    name: text(),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...localizationChecks('canonical_product_family_localizations', {
      ...t,
      primaryText: t.name,
    }),
    uniqueIndex('canonical_product_family_localizations_locale_key').on(
      t.canonicalProductFamilyId,
      t.locale,
    ),
    index('canonical_product_family_localizations_locale_status_idx').on(t.locale, t.status),
  ],
);

/**
 * A DDL token this module inlines with `sql.raw`, refused unless it is shaped
 * like one.
 *
 * Every value that reaches here comes from a closed `as const` tuple
 * (`SUPPORTED_LOCALES`, `POSTGRES_TEXT_SEARCH_CONFIGURATIONS`), so nothing a
 * request could influence is reachable — but the two positions this feeds are a
 * quoted SQL literal inside a stored generated expression, which is the one
 * place in the schema where a stray apostrophe would be a syntax error nobody
 * sees until a migration runs. The guard is cheap and makes the property local
 * to the function rather than an argument about who calls it.
 */
function ddlToken(value: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new Error(`Refusing to inline "${value}" into DDL: not a plain lowercase token`);
  }
  return value;
}

/** `to_tsvector` over a localization row's two text columns, under one configuration. */
function analyseListingLocalizationText(configuration: PostgresTextSearchConfiguration): SQL {
  const literal = sql.raw(`'${ddlToken(configuration)}'`);
  return sql`to_tsvector(${literal}, coalesce(${listingLocalizations.title}, '')) || to_tsvector(${literal}, coalesce(${listingLocalizations.description}, ''))`;
}

/**
 * The `CASE` that picks a localization row's analyser from its own locale.
 *
 * Rendered from `localesByTextSearchConfiguration()` — the one map
 * `listingRepository.textMatch` also reads — with deterministic ordering, so a
 * regeneration that changed nothing produces a byte-identical expression. That
 * matters more here than tidiness: drizzle-kit treats any change to a stored
 * generated expression as `DROP COLUMN` + `ADD COLUMN`, which silently takes the
 * column's GIN index with it and emits nothing about the index
 * (`db/schema/CONVENTIONS.md`).
 *
 * `simple` is the `ELSE` and appears in no arm, which is what makes "a language
 * PostgreSQL cannot analyse is analysed by `simple`, never by `english`" a
 * property of the stored column.
 */
function listingLocalizationSearchVector(): SQL {
  const arms = localesByTextSearchConfiguration().map(({ configuration, locales }) => {
    const list = sql.raw(locales.map((locale) => `'${ddlToken(locale)}'`).join(', '));
    return sql`when ${listingLocalizations.locale} in (${list}) then ${analyseListingLocalizationText(configuration)}`;
  });
  return sql`case ${sql.join(arms, sql` `)} else ${analyseListingLocalizationText(UNANALYZED_TEXT_SEARCH_CONFIGURATION)} end`;
}

/**
 * `listing_localizations` — one locale's presentation of one NATIVE LISTING
 * (#367 Translation model, ADR 0007 D6/D7).
 *
 * ## The family's first `seller_authored` member, and what that changes
 *
 * Every other table here localizes Mercaria's copy about a CONCEPT — what a
 * category is, what a field asks for, what a controlled value means. This one
 * localizes a seller's copy about an ITEM they are selling. The row shape is
 * identical; the FIELD CLASS is not, and it decides two things no column here
 * expresses:
 *
 *  - **No cross-market fallback.** `listing.title` is `seller_authored`, so
 *    `fallbackPolicyForFieldClass` gives it `exact_locale_then_base` and an
 *    `es-mx` request never reads the `es` row a DIFFERENT seller wrote for a
 *    different market. That is D4's exclusion, held by the field's class rather
 *    than by every caller remembering.
 *  - **…but the seller's OWN base text still answers.** `listings.title` and
 *    `listings.description` are both `NOT NULL`, so `exact_locale_only` would
 *    have rendered a French shopper a listing page with no title on it. The
 *    seller's own English is not another market's copy; it is the same seller,
 *    the same item, the words they actually wrote.
 *
 * Before this table both of those policies were enforced against zero
 * registered fields. `catalog-localization.test.ts` pins the distribution.
 *
 * ## What carries these rows forward: nothing needs to, and that is measured
 *
 * The failure this question exists to catch (#650) is a localization table
 * whose parent is versioned with nothing copying rows to the successor, so it
 * empties itself on publish while every page still renders. A listing has no
 * successor to be stranded from:
 *
 *  - it is **not versioned** — no path mints a second `listings` row to
 *    supersede a first;
 *  - **archiving is a soft delete on the SAME row** (`status = 'archived'`
 *    plus #390's `archived_by`/`archived_from_status` provenance), so a restore
 *    puts the same row back and its translations were never touched;
 *  - **`listings` is not one of `MERGEABLE_ENTITY_TYPES`**, so there is no
 *    merge form of supersession either and no `MERGE_REHOMING_PLAN` entry is
 *    owed — `merge-plan-census.test.ts` derives its population from foreign
 *    keys targeting a mergeable entity and this one targets none.
 *
 * Variant convergence rewrites `product_variants`, never the listing, so it
 * cannot reach these rows at all.
 *
 * `cascade`, and it is load-bearing rather than conventional: production never
 * hard-deletes a listing, but around twenty realdb suites `delete(listings)` in
 * teardown, and a `restrict` here would turn every one of them into a `23503`
 * in a file that never mentioned localization.
 *
 * ## Full-text search reads this text, under THIS locale's analyser
 *
 * `listings.search_vector` is `GENERATED ALWAYS AS … STORED` over the listing's
 * own `title`, `description` and `tags`, under `'english'`. A generation
 * expression may reference only columns of its own row, so a sibling table's
 * text cannot enter it — a PostgreSQL restriction, not a decision, and the
 * reason the localized index is a SECOND vector here rather than a wider
 * expression there.
 *
 * Until #367 Workstream 5 there was no second vector, and the consequence was
 * stated rather than discovered: **a listing found by its English title was not
 * found by its French one.** {@link listingLocalizations.searchVector} is that
 * fix — one `tsvector` per localization row, analysed by the configuration
 * `LOCALE_TEXT_SEARCH_CONFIGURATIONS` names for the row's OWN locale, with its
 * own GIN index, plus a locale-aware predicate in `listingRepository` reading
 * the SAME map. The base vector is untouched and the predicate is a UNION with
 * it, so a base-locale search behaves exactly as before.
 *
 * The query side matches the EXACT requested locale and never a neighbouring
 * market's, which is not a search decision but this table's own: `listing.title`
 * is `seller_authored`, so `fallbackPolicyForFieldClass` gives it
 * `exact_locale_then_base` and an `es-mx` shopper is never SHOWN the `es` row a
 * different seller wrote. A search that matched it would send them to a page
 * whose text does not contain the word they typed.
 *
 * ## No accessibility-label column, and that is the answer rather than a gap
 *
 * `navigation_node_localizations` carries one legitimately: `navigation_nodes`
 * has no label column at all, so the label IS the localization row and its
 * accessible name has no catalogue string a client could compose from. Every
 * entity in THIS family has one. A client builds an accessible name by
 * interpolating it into a translated template from its own bundle —
 * `t(CATEGORY_BROWSE_KEY, { category: category.name })` in
 * `@mercaria/ui`'s `CategoryCard`, `t(CONDITION_A11Y_LABEL_KEY, { label })` in
 * `ConditionBadge` — so a column here would be a SECOND representation of the
 * title sitting in the same row as the first, drifting from it silently while
 * rendering perfectly. `catalog-localization.test.ts` censuses the family for
 * one, with navigation as the positive control.
 */
export const listingLocalizations = pgTable(
  'listing_localizations',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    ...localizationColumns(),
    /** The localized listing title. NULL exactly when `status = 'missing'`. */
    title: text(),
    /**
     * The localized listing description.
     *
     * Nullable HERE while `listings.description` is `NOT NULL`, and the
     * asymmetry is the family's rule rather than an oversight: `title` is the
     * `primaryText`, so `_missing_text_check` ties `status = 'missing'` to
     * `title is null` alone. A translator who has settled the title and not yet
     * the description holds a row that is genuinely not `missing`.
     */
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * This locale's own full-text index, analysed by this locale's own
     * PostgreSQL text-search configuration (#367 Workstream 5).
     *
     * `listings.search_vector` covers the seller's BASE text under `'english'`.
     * A generation expression may reference only columns of its own row, so a
     * sibling table's text cannot enter it — a PostgreSQL restriction, not a
     * decision, and the reason the localized vector lives HERE rather than as a
     * second expression over there.
     *
     * ## The configuration comes from the ROW's locale, through one map
     *
     * The arms are rendered from `localesByTextSearchConfiguration()`
     * (`@mercaria/shared-types`), which is the SAME map
     * `listingRepository.textMatch` reads to build its `tsquery`. Two mappings
     * would be the failure this column exists to remove: two stemmers sometimes
     * agree on a word and sometimes do not, so a vector and a query built under
     * different configurations punch UNPREDICTABLE holes in a result set rather
     * than merely degrading it (measured over ten configurations: 22 of 30
     * same-configuration pairings match, 96 of 270 cross-configuration ones).
     * The case this column exists for is one of the holes —
     * `to_tsvector('french','une bicyclette') @@ websearch_to_tsquery('english','bicyclettes')`
     * is FALSE — and a predicate that returns nothing is indistinguishable from
     * a term nobody sells.
     *
     * ## `ELSE simple`, never `else english`
     *
     * PostgreSQL ships configurations for nine of Mercaria's twelve catalogue
     * languages; Bengali, Japanese and Chinese have none. Those get the `ELSE`,
     * which is `'simple'` — case folding and token splitting and nothing else,
     * the choice #70's canonical lexical stage already makes for every entity
     * name. Falling them back to `'english'` is the defect being removed: the
     * English stemmer would confidently produce lexemes no query in that
     * language reproduces, so the row would index and never match.
     *
     * `simple` is therefore ABSENT from the arms by construction —
     * `localesByTextSearchConfiguration()` omits it — which is what makes the
     * default true of the stored column and not only of the TypeScript map. A
     * locale added to `SUPPORTED_LOCALES` and left unclassified cannot ship
     * (the map is a total `Record`) and would be analysed by `simple` if it
     * somehow did.
     *
     * ## The literal configuration, and the `coalesce` on both inputs
     *
     * Two-argument `to_tsvector('<config>', …)` with a LITERAL configuration, for
     * the reason `catalog.ts` records: the one-argument form reads
     * `default_text_search_config` and is STABLE, which PostgreSQL refuses in a
     * generated column. A `CASE` whose every arm names a literal is IMMUTABLE and
     * is accepted — verified against a real server, not assumed.
     *
     * `coalesce` on BOTH columns even though only one can be `missing`:
     * concatenating a NULL into a `tsvector` yields NULL for the whole column,
     * so a row with a settled title and no description yet would otherwise index
     * as nothing at all. Measured: a row with both NULL produces the EMPTY
     * vector, which matches no query and is the right answer for a `missing`
     * translation.
     */
    searchVector: tsvector().generatedAlwaysAs((): SQL => listingLocalizationSearchVector()),
  },
  (t) => [
    ...localizationChecks('listing_localizations', { ...t, primaryText: t.title }),
    uniqueIndex('listing_localizations_locale_key').on(t.listingId, t.locale),
    /**
     * The GIN index the locale-aware predicate reads.
     *
     * Named and asserted rather than assumed: a generated-column REWRITE drops
     * every index on the column and `drizzle-kit generate` emits nothing about
     * it (`db/schema/CONVENTIONS.md`), so `listing-localization.realdb.test.ts`
     * both asserts the index exists after the whole chain applies and asserts
     * the predicate PLANS onto it — with a drop-inside-a-rolled-back-transaction
     * mutation proving the assertion can fail.
     */
    index('listing_localizations_search_vector_idx').using('gin', t.searchVector),
    /**
     * The family's `(locale, status)` index, carried for consistency of shape
     * rather than for the translation desk — this domain is deliberately
     * outside the desk's coverage (`LOCALIZATION_COVERAGE_UNCOVERED_TABLES`).
     * Its reader is the same one every sibling has: "what is outstanding in
     * this locale", which an operator tracing one seller's translations runs
     * against the leading column, and which `<table>_locale_key` cannot serve
     * because its leading column is the entity id.
     */
    index('listing_localizations_locale_status_idx').on(t.locale, t.status),
  ],
);
