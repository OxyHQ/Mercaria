/**
 * `listing_localizations` — the only writer of a listing's localized text.
 *
 * The family's fifth text member and the last to get one. #809 landed the table,
 * the `exact_locale_then_base` resolution and two production READS, and scoped
 * the write path out; #814 is that write path, which is what makes epic #367's
 * "listing localization **owned by each store/listing**" an authorisation fact
 * rather than only a column's value.
 *
 * Shaped after `categoryLocalizationRepository`, and the two things it
 * deliberately does NOT contain are the same two, for the same reason — the
 * database does them, and a second answer here would be one forgotten call site
 * away from disagreeing with the first:
 *
 * - **No machine-overwrite check.** `mercaria_localization_machine_write_guard`
 *   refuses a machine write landing on reviewed or approved text, and
 *   `listing_localizations_machine_status_check` /
 *   `listing_localizations_machine_reviewer_check` refuse the resulting row.
 * - **No stale marking.** A source-semantics change marks dependents `stale`
 *   from a trigger, in the statement that changes the source.
 */

import { and, eq, inArray, type InferSelectModel } from 'drizzle-orm';
import type {
  LocalizationProvenance,
  LocalizationStatus,
  SupportedLocale,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listingLocalizations } from '../schema/catalogLocalization.js';

/** One row of `listing_localizations`. */
export type ListingLocalizationRow = InferSelectModel<typeof listingLocalizations>;

/** Everything a caller may supply when writing one listing's localized text. */
export interface ListingLocalizationInput {
  readonly listingId: string;
  /**
   * Lowercase BCP 47, never the base locale — a CHECK refuses that row.
   *
   * `SupportedLocale` and not `string`, the sibling repository's ruling: the
   * column is typed from the same tuple its CHECK is rendered from, so an
   * unauthored tag is a compile error here rather than a constraint violation at
   * the end of a request. An HTTP caller holding a raw string narrows it with
   * `isSupportedLocale` first.
   */
  readonly locale: SupportedLocale;
  readonly status: LocalizationStatus;
  readonly provenance: LocalizationProvenance;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly sourceLocale?: SupportedLocale | null;
  readonly sourceRevision?: string | null;
  readonly reviewedByOxyUserId?: string | null;
  readonly reviewedAt?: Date | null;
}

/**
 * Read the localizations for a set of listings, narrowed to the locales a
 * fallback chain can actually use.
 *
 * ONE statement for the whole page, and an empty `listingIds` or `locales`
 * returns `[]` without one: `inArray(col, [])` renders a predicate Postgres
 * evaluates against every row of the table.
 */
export async function findListingLocalizations(
  listingIds: readonly string[],
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingLocalizationRow[]> {
  if (listingIds.length === 0 || locales.length === 0) return [];
  return db
    .select()
    .from(listingLocalizations)
    .where(
      and(
        inArray(listingLocalizations.listingId, [...listingIds]),
        inArray(listingLocalizations.locale, [...locales]),
      ),
    );
}

/**
 * One listing's localizations across every locale — the seller's own coverage
 * read.
 *
 * Unbounded in locales on purpose, and bounded to one listing for the same
 * reason: "which locales does this listing have, and how settled is each" is a
 * question about one listing, and answering it for a page of them is what
 * {@link findListingLocalizations} is for.
 */
export async function findListingLocalizationCoverage(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingLocalizationRow[]> {
  return db
    .select()
    .from(listingLocalizations)
    .where(eq(listingLocalizations.listingId, listingId));
}

/** One listing's text in one locale, or `null`. */
export async function findListingLocalization(
  listingId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingLocalizationRow | null> {
  const [row] = await db
    .select()
    .from(listingLocalizations)
    .where(
      and(eq(listingLocalizations.listingId, listingId), eq(listingLocalizations.locale, locale)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Write one listing's text in one locale, replacing whatever was there.
 *
 * `DO UPDATE` and not `DO NOTHING`, the sibling's ruling: a translation is a
 * revision and the second write IS the correction. What stops that becoming a
 * way to destroy reviewed text is the trigger, not this statement.
 *
 * Every column is named in the `set`, including the ones a caller left out, so a
 * revision cannot inherit half of the row it replaced — a machine retranslation
 * that kept the previous reviewer's name would pass every check that looks at
 * one column at a time, and `listing_localizations_machine_reviewer_check` would
 * then refuse the whole write, which is a confusing way to learn about an
 * omission.
 *
 * `search_vector` is not named because it cannot be: it is
 * `GENERATED ALWAYS AS … STORED`, so the server recomputes it from the title and
 * description this statement writes, under the row's own locale's analyser.
 */
export async function upsertListingLocalization(
  input: ListingLocalizationInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingLocalizationRow> {
  const values = {
    listingId: input.listingId,
    locale: input.locale,
    status: input.status,
    provenance: input.provenance,
    title: input.title ?? null,
    description: input.description ?? null,
    sourceLocale: input.sourceLocale ?? null,
    sourceRevision: input.sourceRevision ?? null,
    reviewedByOxyUserId: input.reviewedByOxyUserId ?? null,
    reviewedAt: input.reviewedAt ?? null,
  };
  const [row] = await db
    .insert(listingLocalizations)
    .values(values)
    .onConflictDoUpdate({
      target: [listingLocalizations.listingId, listingLocalizations.locale],
      set: {
        status: values.status,
        provenance: values.provenance,
        title: values.title,
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
 * Withdraw one listing's translation in one locale.
 *
 * A DELETE rather than a status write, and the distinction is the family's:
 * `deprecated` is a translation somebody withdrew and KEPT — the row still
 * records who wrote it and when — while this is a seller removing text they
 * authored. Returns whether a row was there, so a repeat converges on 404
 * rather than reporting a deletion that did not happen.
 */
export async function deleteListingLocalization(
  listingId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const deleted = await db
    .delete(listingLocalizations)
    .where(
      and(eq(listingLocalizations.listingId, listingId), eq(listingLocalizations.locale, locale)),
    )
    .returning({ id: listingLocalizations.id });
  return deleted.length > 0;
}
