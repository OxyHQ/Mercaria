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

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  LOCALIZATION_PROVENANCES,
  LOCALIZATION_STATUSES,
  MERCARIA_BASE_LOCALE,
  SUPPORTED_LOCALES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { categories } from './catalog';
import { attributeEnumValues } from './attributeRegistry';
import { productTypeDefinitions, productTypeFields } from './productTypes';

/** `SUPPORTED_LOCALES` as the tuple both the column type and its CHECK read. */
const LOCALE_VALUES = asEnumValues(SUPPORTED_LOCALES);

/**
 * The seven columns every text member of the family carries.
 *
 * A helper for the same reason `money()` is one: the shape is repeated four
 * times and a hand-copied fourth copy is where the drift starts. The keys are
 * literal rather than generated from a prefix, so TypeScript infers the return
 * type exactly and no assertion is needed — the trap `money()`'s doc comment
 * records does not reach this one.
 *
 * `reviewed_by_oxy_user_id` rather than D4's `reviewed_by`: it is an Oxy account
 * id, Oxy owns identity, and the suffix is what makes it classifiable in
 * `deferredForeignKeys.ts` beside the other ninety.
 */
function localizationColumns() {
  return {
    /** Lowercase BCP 47, never the base locale. See the file header. */
    locale: text({ enum: LOCALE_VALUES }).notNull(),
    status: text({ enum: asEnumValues(LOCALIZATION_STATUSES) }).notNull(),
    provenance: text({ enum: asEnumValues(LOCALIZATION_PROVENANCES) }).notNull(),
    /**
     * The locale this text was translated FROM. Usually the base locale; not
     * always, since a Catalan translation is more usefully made from Spanish.
     */
    sourceLocale: text({ enum: LOCALE_VALUES }),
    /**
     * The source content's revision marker, as its owner spells it — a digest, a
     * version, an `updated_at`. Opaque here, and deliberately NOT what the stale
     * trigger compares: `categories` carries no revision column, so a comparison
     * against it would be a check that can never fire. The trigger watches the
     * source TEXT instead, and this column is what a reviewer reads afterwards
     * to see which revision the translation was made against.
     */
    sourceRevision: text(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
  };
}

/**
 * The CHECKs every text member of the family carries, rendered per table.
 *
 * Stated once so the four tables cannot enforce four slightly different rules.
 * `primaryText` is the column whose absence defines a `missing` row — the one
 * string the entity cannot be presented without.
 */
function localizationChecks(
  table: string,
  columns: {
    locale: AnyPgColumn;
    status: AnyPgColumn;
    provenance: AnyPgColumn;
    sourceLocale: AnyPgColumn;
    reviewedByOxyUserId: AnyPgColumn;
    reviewedAt: AnyPgColumn;
    primaryText: AnyPgColumn;
  },
) {
  return [
    checkOneOf(`${table}_locale_check`, columns.locale, SUPPORTED_LOCALES),
    checkOneOf(`${table}_source_locale_check`, columns.sourceLocale, SUPPORTED_LOCALES),
    checkOneOf(`${table}_status_check`, columns.status, LOCALIZATION_STATUSES),
    checkOneOf(`${table}_provenance_check`, columns.provenance, LOCALIZATION_PROVENANCES),
    // The base-locale string lives on the entity's own column. See the header.
    //
    // `sql.raw` and not an interpolated JS string: a value interpolated normally
    // renders as a BOUND PARAMETER, and drizzle-kit writes the literal `$1` into
    // the migration — which generates cleanly and fails at APPLY time.
    check(
      `${table}_locale_not_base_check`,
      sql`${columns.locale} <> ${sql.raw(`'${MERCARIA_BASE_LOCALE}'`)}`,
    ),
    // A `missing` row is one somebody opened to say a translation is owed; it is
    // not a row with text nobody classified, and it is not the absence of a row.
    check(
      `${table}_missing_text_check`,
      sql`(${columns.status} = 'missing') = (${columns.primaryText} is null)`,
    ),
    // …and an empty string is not text. Without this the CHECK above is
    // satisfied by `status = 'approved'` beside `name = ''`, which is a row
    // claiming a human approved a blank category name — and the resolver would
    // have to guess whether to serve it.
    check(
      `${table}_text_not_blank_check`,
      sql`${columns.primaryText} is null or btrim(${columns.primaryText}) <> ''`,
    ),
    // Machine translation is a SUGGESTION. The trigger refuses the transition;
    // this refuses the resulting row, which an INSERT never gives the trigger a
    // chance to see.
    check(
      `${table}_machine_status_check`,
      sql`${columns.provenance} <> 'machine' or ${columns.status} not in ('reviewed', 'approved')`,
    ),
    // …and it may not wear somebody else's review either. Without this, a
    // machine write that also downgraded the status would keep the human
    // reviewer's name on text they never saw.
    check(
      `${table}_machine_reviewer_check`,
      sql`${columns.provenance} <> 'machine' or (${columns.reviewedByOxyUserId} is null and ${columns.reviewedAt} is null)`,
    ),
    // A reviewer and a review instant travel together; neither means anything
    // alone. The `attribute_value_reviews` resolution shape.
    check(
      `${table}_reviewer_pair_check`,
      sql`(${columns.reviewedByOxyUserId} is null) = (${columns.reviewedAt} is null)`,
    ),
    // Settled text names who settled it. One-way rather than a biconditional, so
    // a row that WAS approved and has since gone `stale` keeps its audit — which
    // is the whole reason `stale` does not blank anything.
    check(
      `${table}_reviewed_audit_check`,
      sql`${columns.status} not in ('reviewed', 'approved') or ${columns.reviewedByOxyUserId} is not null`,
    ),
  ];
}

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
