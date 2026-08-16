/**
 * `category_localized_slugs` — the only writer of a category's localized URLs
 * (ADR 0007 D4).
 *
 * ## Issuing a slug is three statements, and their ORDER is the constraint
 *
 * `category_localized_slugs_current_key` is a partial unique on
 * `(category_id, locale) WHERE superseded_at IS NULL`, so the outgoing slug has
 * to be retired BEFORE the incoming one exists. The successor pointer is
 * therefore written last, as an update of the row that was just retired — which
 * is permitted because `mercaria_category_localized_slug_frozen` freezes the
 * category, the locale and the slug and nothing else.
 *
 * All three run in ONE transaction, and the read that starts it takes
 * `FOR UPDATE` on the outgoing row. Without the lock two concurrent renames both
 * read "current = X", both retire it, and both insert — the partial unique
 * refuses the second, which is safe, but the loser has already retired the live
 * slug and rolls back with the category's URL momentarily gone. With the lock
 * the second waits and then sees its own starting point.
 *
 * ## Reviving a retired slug is an UPDATE, and it is the only one permitted
 *
 * `UNIQUE(locale, slug)` covers retired rows, so re-issuing a slug a category
 * used to have cannot insert a second row. Reviving the original one is not a
 * workaround for that constraint — it is the correct answer: the row that every
 * old link resolves through becomes current again, and the redirect chain that
 * pointed at its replacement simply ends.
 */

import { and, eq, inArray, isNull, sql, type InferSelectModel } from 'drizzle-orm';
import type { LocalizationProvenance, SupportedLocale } from '@mercaria/shared-types';
import { conflict } from '../../lib/errors/index.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { categoryLocalizedSlugs } from '../schema/catalogLocalization.js';

/** One row of `category_localized_slugs`. */
export type CategoryLocalizedSlugRow = InferSelectModel<typeof categoryLocalizedSlugs>;

/** Everything a caller supplies when issuing one localized slug. */
export interface CategoryLocalizedSlugInput {
  readonly categoryId: string;
  /** Lowercase BCP 47, never the base locale — `categories.slug` is that one. */
  readonly locale: SupportedLocale;
  readonly slug: string;
  readonly provenance: LocalizationProvenance;
  readonly issuedByOxyUserId?: string | null;
}

/**
 * The CURRENT localized slugs for a set of categories, in the locales a fallback
 * chain can use. One statement for the whole page.
 */
export async function findCurrentCategoryLocalizedSlugs(
  categoryIds: readonly string[],
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryLocalizedSlugRow[]> {
  if (categoryIds.length === 0 || locales.length === 0) return [];
  return db
    .select()
    .from(categoryLocalizedSlugs)
    .where(
      and(
        inArray(categoryLocalizedSlugs.categoryId, [...categoryIds]),
        inArray(categoryLocalizedSlugs.locale, [...locales]),
        isNull(categoryLocalizedSlugs.supersededAt),
      ),
    );
}

/**
 * Resolve a localized URL to the category it names — RETIRED slugs included.
 *
 * Retired rows are the point of the lookup, not an edge case: a link somebody
 * shared two years ago still carries the slug that was current then, and the row
 * that survives it is the only thing that can say which category it meant. What
 * the caller does with a retired hit is a redirect, and composing that redirect
 * is `category_redirects`' job (ADR 0007 D2, the taxonomy module's) — this
 * function answers which category, and nothing about what to send back.
 */
export async function findCategoryByLocalizedSlug(
  locale: SupportedLocale,
  slug: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryLocalizedSlugRow | undefined> {
  const [row] = await db
    .select()
    .from(categoryLocalizedSlugs)
    .where(and(eq(categoryLocalizedSlugs.locale, locale), eq(categoryLocalizedSlugs.slug, slug)))
    .limit(1);
  return row;
}

/**
 * Give a category a new localized URL, retiring whatever it had.
 *
 * Idempotent on the slug itself: issuing the slug a category already carries in
 * that locale returns the existing row and writes nothing, so a retrying client
 * does not produce a retirement chain of identical URLs.
 *
 * A slug another category holds — current or retired — is refused by NAME rather
 * than left to the unique index. The index would raise a bare 23505 that reads
 * like a race, and the remedy is different: the caller has to pick a different
 * slug, not retry.
 */
export async function issueCategoryLocalizedSlug(
  input: CategoryLocalizedSlugInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryLocalizedSlugRow> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(categoryLocalizedSlugs)
      .where(
        and(
          eq(categoryLocalizedSlugs.categoryId, input.categoryId),
          eq(categoryLocalizedSlugs.locale, input.locale),
          isNull(categoryLocalizedSlugs.supersededAt),
        ),
      )
      .limit(1)
      .for('update');

    if (current !== undefined && current.slug === input.slug) return current;

    const existing = await findCategoryByLocalizedSlug(input.locale, input.slug, tx);
    if (existing !== undefined && existing.categoryId !== input.categoryId) {
      throw conflict(
        `The slug "${input.slug}" is already held in locale "${input.locale}" by another category.`,
      );
    }

    if (current !== undefined) {
      await tx
        .update(categoryLocalizedSlugs)
        .set({ supersededAt: sql`date_trunc('milliseconds', now())` })
        .where(eq(categoryLocalizedSlugs.id, current.id));
    }

    const [issued] =
      existing === undefined
        ? await tx
            .insert(categoryLocalizedSlugs)
            .values({
              categoryId: input.categoryId,
              locale: input.locale,
              slug: input.slug,
              provenance: input.provenance,
              issuedByOxyUserId: input.issuedByOxyUserId ?? null,
            })
            .returning()
        : // Reviving this category's own retired slug. The frozen trigger permits
          // exactly this: the retirement columns move and the identity does not.
          await tx
            .update(categoryLocalizedSlugs)
            .set({
              supersededAt: null,
              supersededBySlugId: null,
              provenance: input.provenance,
              issuedByOxyUserId: input.issuedByOxyUserId ?? null,
            })
            .where(eq(categoryLocalizedSlugs.id, existing.id))
            .returning();

    if (current !== undefined) {
      await tx
        .update(categoryLocalizedSlugs)
        .set({ supersededBySlugId: issued.id })
        .where(eq(categoryLocalizedSlugs.id, current.id));
    }

    return issued;
  });
}
