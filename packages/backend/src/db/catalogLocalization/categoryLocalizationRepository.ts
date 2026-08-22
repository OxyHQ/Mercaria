/**
 * `category_localizations` — the only writer of a category's localized text
 * (ADR 0007 D4).
 *
 * Two things this file deliberately does NOT contain, because the database does
 * them and a service that also did them would be a second answer:
 *
 * - **No machine-overwrite check.** `mercaria_localization_machine_write_guard`
 *   refuses a machine write landing on reviewed or approved text, and two CHECKs
 *   refuse the resulting row. A guard here would be one forgotten call site from
 *   silently degrading a human's work, which is exactly the reason D4 puts it in
 *   a trigger.
 * - **No stale marking.** A source-semantics change marks dependents `stale`
 *   from `mercaria_categories_localization_stale`, in the statement that changes
 *   the source. Nothing has to remember to call anything.
 */

import { and, eq, inArray, type InferSelectModel } from 'drizzle-orm';
import type {
  LocalizationProvenance,
  LocalizationStatus,
  SupportedLocale,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { categoryLocalizations } from '../schema/catalogLocalization.js';
import { assertLocalizedRow } from '../../lib/localized-text.js';

/** One row of `category_localizations`. */
export type CategoryLocalizationRow = InferSelectModel<typeof categoryLocalizations>;

/** Everything a caller may supply when writing one category's localized text. */
export interface CategoryLocalizationInput {
  readonly categoryId: string;
  /**
   * Lowercase BCP 47, never the base locale — a CHECK refuses that row.
   *
   * `SupportedLocale` and not `string`: the column is typed from the same tuple
   * its CHECK is rendered from, so an unauthored tag is a compile error here
   * rather than a constraint violation at the end of a request. An HTTP caller
   * holding a raw string narrows it with `isSupportedLocale` first.
   */
  readonly locale: SupportedLocale;
  readonly status: LocalizationStatus;
  readonly provenance: LocalizationProvenance;
  readonly name?: string | null;
  readonly description?: string | null;
  readonly sourceLocale?: SupportedLocale | null;
  readonly sourceRevision?: string | null;
  readonly reviewedByOxyUserId?: string | null;
  readonly reviewedAt?: Date | null;
}

/**
 * Read the localizations for a set of categories, narrowed to the locales a
 * fallback chain can actually use.
 *
 * ONE statement for the whole page. The chain is at most a handful of locales
 * and the caller already knows it, so passing it in keeps the read to the rows
 * that can answer rather than every translation of every category on the page —
 * which for a forty-locale catalogue is the difference between a page of rows
 * and forty pages of them.
 *
 * An empty `categoryIds` or `locales` returns `[]` without a statement:
 * `inArray(col, [])` renders a predicate Postgres will happily evaluate against
 * every row of the table.
 */
export async function findCategoryLocalizations(
  categoryIds: readonly string[],
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryLocalizationRow[]> {
  if (categoryIds.length === 0 || locales.length === 0) return [];
  return db
    .select()
    .from(categoryLocalizations)
    .where(
      and(
        inArray(categoryLocalizations.categoryId, [...categoryIds]),
        inArray(categoryLocalizations.locale, [...locales]),
      ),
    );
}

/**
 * Write one category's text in one locale, replacing whatever was there.
 *
 * `DO UPDATE` and not `DO NOTHING`, which is the opposite of `product_saves`'
 * decision one domain over and for the opposite reason: a save is a buyer's
 * standing intent that a repeat must not disturb, and a translation is a
 * revision — the second write IS the correction. What stops that becoming a way
 * to destroy reviewed text is the trigger, not this statement.
 *
 * Every column is named in the `set`, including the ones a caller left out, so a
 * revision cannot inherit half of the row it replaced — a machine retranslation
 * that kept the previous reviewer's name would pass every check that looks at
 * one column at a time (and `<table>_machine_reviewer_check` would then refuse
 * the whole write, which is a confusing way to learn about an omission).
 */
export async function upsertCategoryLocalization(
  input: CategoryLocalizationInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryLocalizationRow> {
  const values = {
    categoryId: input.categoryId,
    locale: input.locale,
    status: input.status,
    provenance: input.provenance,
    // See `listingLocalizationRepository.upsertListingLocalization`.
    ...assertLocalizedRow('category_localizations', {
      name: input.name ?? null,
      description: input.description ?? null,
    }),
    sourceLocale: input.sourceLocale ?? null,
    sourceRevision: input.sourceRevision ?? null,
    reviewedByOxyUserId: input.reviewedByOxyUserId ?? null,
    reviewedAt: input.reviewedAt ?? null,
  };
  const [row] = await db
    .insert(categoryLocalizations)
    .values(values)
    .onConflictDoUpdate({
      target: [categoryLocalizations.categoryId, categoryLocalizations.locale],
      set: {
        status: values.status,
        provenance: values.provenance,
        name: values.name,
        description: values.description,
        sourceLocale: values.sourceLocale,
        sourceRevision: values.sourceRevision,
        reviewedByOxyUserId: values.reviewedByOxyUserId,
        reviewedAt: values.reviewedAt,
      },
    })
    .returning();
  return row;
}

/**
 * One category's localizations across every locale — the translation-desk read.
 *
 * Unbounded in locales on purpose, and bounded to one category for the same
 * reason: "which locales does this category have, and how settled is each" is a
 * question about one row, and answering it for a page of categories is what
 * {@link findCategoryLocalizations} is for.
 */
export async function findCategoryLocalizationCoverage(
  categoryId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryLocalizationRow[]> {
  return db
    .select()
    .from(categoryLocalizations)
    .where(eq(categoryLocalizations.categoryId, categoryId));
}
