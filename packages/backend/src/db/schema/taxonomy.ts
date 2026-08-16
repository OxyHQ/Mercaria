/**
 * The taxonomy module's own tables: `category_aliases` and `category_redirects`
 * (#367 step 1, ADR 0007 D1/D2).
 *
 * `categories` itself is NOT here. ADR 0007 D2 extends it in place, in
 * `catalog.ts`, because a second category table would give every listing,
 * collection rule, search filter and connector mapping two possible answers to
 * "what is this" — the exact failure the epic is written against. These three
 * are the facts that hang off it and have nowhere else to live.
 *
 * EXTERNAL category mappings are NOT here. `(source, external key) -> category`
 * is one dimension of Workstream 11's `catalog_external_mappings`, whose
 * discriminated target covers all six mapping dimensions under one set of
 * version, confidence, review-state, provenance and validity semantics. A
 * `category_external_mappings` in this module would be a second table
 * answering the identical question.
 *
 * Common to all three: identity is the category's `id`, never its `name` or
 * `slug` (D1). No foreign key here targets a presentation column, and there is
 * no column in this file a reader could mistake for the category's own name.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CATEGORY_ALIAS_KINDS,
  CATEGORY_REDIRECT_REASONS,
  CATEGORY_REDIRECT_SUBJECT_KINDS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { categories } from './catalog';

/**
 * `category_aliases` — internal and search-time alternate names, per locale.
 *
 * ## An alias is never rendered as the category's name, and that is an ABSENCE
 *
 * ADR 0007 D2 keeps aliases "separate from public names". There is no
 * `is_primary`, `is_display` or `preferred` column here and no boolean beside
 * `kind`, so an alias has no way to claim to be the name. The public name is
 * `categories.name`, and from step 2 the localization family; a second answer to
 * that question is what this table must not become.
 *
 * ## Not globally unique, deliberately
 *
 * The unique is `(category_id, locale, normalized_alias)` — one category cannot
 * hold one alias twice in a locale. It is NOT unique on `(locale,
 * normalized_alias)` alone: "phone" legitimately points at more than one shelf,
 * and a constraint that refuses the second one would make the taxonomy unable to
 * record something true. The AMBIGUITY is the reader's to resolve, which is why
 * `findCategoriesByAlias` returns a list rather than a row — the
 * `matchIncomingVariant` ruling, one domain over: a database constraint that has
 * to be wrong sometimes is worse than one that does not exist.
 *
 * `cascade` onto the category: an alias exists only to point at one, and is
 * meaningless without it (CONVENTIONS, foreign keys).
 */
export const categoryAliases = pgTable(
  'category_aliases',
  {
    id: generatedId(),
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** A BCP-47 tag. The localization FAMILY is step 2; this is its key. */
    locale: text().notNull(),
    alias: text().notNull(),
    /** Service-maintained normalization of `alias` — what a lookup compares. */
    normalizedAlias: text().notNull(),
    kind: text({ enum: asEnumValues(CATEGORY_ALIAS_KINDS) }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('category_aliases_category_locale_normalized_key').on(
      t.categoryId,
      t.locale,
      t.normalizedAlias,
    ),
    index('category_aliases_lookup_idx').on(t.locale, t.normalizedAlias),
    checkOneOf('category_aliases_kind_check', t.kind, CATEGORY_ALIAS_KINDS),
    /**
     * An empty or whitespace-only alias matches nothing and is a row that looks
     * like coverage. Both columns, because the normalization is what a lookup
     * actually reads and a normalizer that returned `''` would be invisible.
     */
    check('category_aliases_alias_present_check', sql`length(btrim(${t.alias})) > 0`),
    check(
      'category_aliases_normalized_present_check',
      sql`length(btrim(${t.normalizedAlias})) > 0`,
    ),
    check('category_aliases_locale_present_check', sql`length(btrim(${t.locale})) > 0`),
  ],
);

/**
 * `category_redirects` — an old id or an old localized slug → a live category,
 * so a deprecated or merged node's URLs keep resolving (ADR 0007 D2).
 *
 * ## Append-only, and what that costs
 *
 * `mercaria_category_redirects_append_only` refuses UPDATE and DELETE. The
 * absence of `updated_at` is the same contract stated in the schema
 * (CONVENTIONS, timestamps).
 *
 * The consequence worth stating rather than discovering: **a redirect that
 * points at the wrong category can never be edited.** It is corrected by adding
 * a redirect FROM the wrong target ONWARD, which the resolver follows — subject
 * `S → W` plus `W → C` resolves `S` to `C` in two hops. So a correction is a new
 * row, the mistake stays visible, and nothing rewrites history. It is also why
 * the partial uniques below permit exactly ONE redirect per subject: a second
 * one would be a fork with no rule for choosing.
 *
 * A CYCLE would make that walk non-terminating, so
 * `mercaria_category_redirect_cycle_guard` refuses one at write time,
 * absolutely. Its hop bound is a weaker, separate thing: it sees only the chain
 * AHEAD of a new redirect's target, so tail-extension — which is the documented
 * correction pattern — can build a chain past it. `resolveCategoryRedirect`
 * answers `chain_exhausted` for that, carrying no category.
 *
 * Both foreign keys are `restrict`, matching `categories.parent_id`: nothing
 * deletes a category, and a redirect losing either end silently is worse than
 * refusing.
 */
export const categoryRedirects = pgTable(
  'category_redirects',
  {
    id: generatedId(),
    subjectKind: text({ enum: asEnumValues(CATEGORY_REDIRECT_SUBJECT_KINDS) }).notNull(),
    /** Set iff `subject_kind = 'category_id'`. */
    subjectCategoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    /** Both set iff `subject_kind = 'localized_slug'`. */
    subjectLocale: text(),
    subjectSlug: text(),
    targetCategoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    reason: text({ enum: asEnumValues(CATEGORY_REDIRECT_REASONS) }).notNull(),
    effectiveFrom: timestamptz().notNull().defaultNow(),
    /** No `updated_at`: its ABSENCE is the append-only contract (CONVENTIONS). */
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * One redirect per subject. Partial, because Postgres treats NULLs as
     * DISTINCT and a plain unique over the nullable subject columns would admit
     * any number of rows.
     */
    uniqueIndex('category_redirects_subject_category_key')
      .on(t.subjectCategoryId)
      .where(sql`${t.subjectKind} = 'category_id'`),
    uniqueIndex('category_redirects_subject_slug_key')
      .on(t.subjectLocale, t.subjectSlug)
      .where(sql`${t.subjectKind} = 'localized_slug'`),
    index('category_redirects_target_idx').on(t.targetCategoryId),
    checkOneOf(
      'category_redirects_subject_kind_check',
      t.subjectKind,
      CATEGORY_REDIRECT_SUBJECT_KINDS,
    ),
    checkOneOf('category_redirects_reason_check', t.reason, CATEGORY_REDIRECT_REASONS),
    /**
     * THREE biconditionals, not one over their conjunction. The obvious single
     * CHECK — `(kind = 'localized_slug') = (locale is not null and slug is not
     * null)` — is SATISFIED by a `category_id` row carrying a locale and no
     * slug, because both sides evaluate false. That is the row shape the
     * discriminant exists to forbid.
     */
    check(
      'category_redirects_subject_category_shape_check',
      sql`(${t.subjectKind} = 'category_id') = (${t.subjectCategoryId} is not null)`,
    ),
    check(
      'category_redirects_subject_slug_shape_check',
      sql`(${t.subjectKind} = 'localized_slug') = (${t.subjectSlug} is not null)`,
    ),
    check(
      'category_redirects_subject_locale_shape_check',
      sql`(${t.subjectKind} = 'localized_slug') = (${t.subjectLocale} is not null)`,
    ),
    /** A redirect to itself resolves to itself forever. */
    check(
      'category_redirects_not_self_check',
      sql`${t.subjectCategoryId} is distinct from ${t.targetCategoryId}`,
    ),
  ],
);
