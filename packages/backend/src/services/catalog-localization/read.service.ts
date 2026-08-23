/**
 * Localized catalog reads — the batched composition of the repositories and the
 * pure resolver (ADR 0007 D4).
 *
 * Every function here is BOUNDED and BATCHED: a page of categories is three
 * statements whatever its length, because a per-row resolution is an N+1 the
 * moment a category list grows past one screen. The resolution itself is
 * `resolve.ts`'s, unchanged — this file reads rows and hands them over.
 *
 * ## One chain narrows the read for every field
 *
 * The locale narrowing uses the `language_then_base` chain, which is a SUPERSET
 * of the `exact_locale_then_base` and `exact_locale_only` ones for the same
 * request. So a field whose class forbids cross-market fallback is still read
 * (its row is in the narrowed set) and still refused (the resolver applies its
 * own, shorter plan). Narrowing on a shorter one would be the dangerous
 * direction: the resolver would answer `no_text_in_locale` for text that
 * exists, and nothing would say so.
 *
 * ## Nothing here decides what a category IS
 *
 * The reads take ids and return presentation. There is no filter, no ordering
 * and no visibility rule in this file — a caller has already decided which
 * categories a reader may see, and a localization may never become a second
 * answer to that.
 */

import { inArray } from 'drizzle-orm';
import {
  type LocalizedCategoryPresentation,
  type LocalizedResolution,
  type LocalizationCandidate,
  type LocalizedSlugCandidate,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { categories } from '../../db/schema/catalog.js';
import { attributeEnumValues } from '../../db/schema/attributeRegistry.js';
import { attributeValueLocalizations } from '../../db/schema/catalogLocalization.js';
import { findCategoryLocalizations } from '../../db/catalogLocalization/categoryLocalizationRepository.js';
import { findCurrentCategoryLocalizedSlugs } from '../../db/catalogLocalization/categoryLocalizedSlugRepository.js';
import { localeFallbackChain, resolveLocalizedSlug } from './resolve.js';
// The OBSERVED resolver, never `resolve.ts`'s pure one — see
// `read-observation.ts` on why the counter lives outside the pure module and
// why a serving path may not reach past the wrapper (#367 W17 line 771).
import { resolveObservedLocalizedField } from './read-observation.js';

/**
 * Present a set of categories in a reader's locale.
 *
 * Three statements: the categories themselves (for the base name and slug),
 * their localizations, and their current localized slugs. The order of the
 * result follows `categoryIds`, so a caller that already ranked them keeps its
 * ordering — a localization has no business changing one.
 *
 * A category id that does not exist is simply absent from the result rather than
 * present with empty text: "this category has no Spanish name" and "there is no
 * such category" are different facts and only one of them is about localization.
 */
export async function readLocalizedCategories(
  categoryIds: readonly string[],
  requestedLocale: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedCategoryPresentation[]> {
  if (categoryIds.length === 0) return [];
  const chain = localeFallbackChain(requestedLocale, 'language_then_base');

  const baseRows = await db
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(categories)
    .where(inArray(categories.id, [...categoryIds]));
  if (baseRows.length === 0) return [];

  const foundIds = baseRows.map((row) => row.id);
  const [localizations, slugs] = await Promise.all([
    findCategoryLocalizations(foundIds, chain, db),
    findCurrentCategoryLocalizedSlugs(foundIds, chain, db),
  ]);

  // Two candidate lists off one row set: the `status` and `provenance` of a
  // localization row describe the ROW, so both fields carry them, and each field
  // resolves independently — a category can have an approved Spanish name and no
  // Spanish description, and collapsing them would make the second field inherit
  // the first's answer.
  const textByCategory = new Map<string, LocalizationCandidate[]>();
  const descriptionByCategory = new Map<string, LocalizationCandidate[]>();
  for (const row of localizations) {
    const common = { locale: row.locale, status: row.status, provenance: row.provenance };
    const names = textByCategory.get(row.categoryId) ?? [];
    names.push({ ...common, value: row.name });
    textByCategory.set(row.categoryId, names);

    const descriptions = descriptionByCategory.get(row.categoryId) ?? [];
    descriptions.push({ ...common, value: row.description });
    descriptionByCategory.set(row.categoryId, descriptions);
  }

  const slugsByCategory = new Map<string, LocalizedSlugCandidate[]>();
  for (const row of slugs) {
    const bucket = slugsByCategory.get(row.categoryId) ?? [];
    bucket.push({
      locale: row.locale,
      slug: row.slug,
      provenance: row.provenance,
      // The read is already narrowed to live rows; stating it rather than
      // inferring it keeps the resolver's filter meaningful when a future caller
      // hands it a wider set.
      superseded: 'no',
    });
    slugsByCategory.set(row.categoryId, bucket);
  }

  const byId = new Map(baseRows.map((row) => [row.id, row]));
  const presented: LocalizedCategoryPresentation[] = [];
  for (const categoryId of categoryIds) {
    const base = byId.get(categoryId);
    if (base === undefined) continue;
    presented.push({
      categoryId,
      name: resolveObservedLocalizedField({
        field: 'category.name',
        requestedLocale,
        candidates: textByCategory.get(categoryId) ?? [],
        baseValue: base.name,
      }),
      description: resolveObservedLocalizedField({
        field: 'category.description',
        requestedLocale,
        candidates: descriptionByCategory.get(categoryId) ?? [],
        // `categories` carries no description column, so this field falls all
        // the way through unless a locale row holds one. That is the honest
        // answer: a category nobody described has no description, and deriving
        // one from the name is how a catalogue starts asserting things nobody
        // wrote.
        baseValue: null,
      }),
      slug: resolveLocalizedSlug({
        requestedLocale,
        candidates: slugsByCategory.get(categoryId) ?? [],
        baseSlug: base.slug,
      }),
    });
  }
  return presented;
}

/** One controlled value's label, resolved for a reader. */
export interface LocalizedAttributeValue {
  readonly attributeEnumValueId: string;
  readonly label: LocalizedResolution;
}

/**
 * Present a set of #94 controlled values in a reader's locale.
 *
 * The LABEL only. `attribute_enum_values.value` is the canonical string every
 * assignment stores and every alias resolves to, and there is no localized
 * counterpart to it anywhere in this domain — a per-locale value would make a
 * stored fact mean different things in different markets, which is the identity
 * failure ADR 0007 D1 exists to prevent.
 */
export async function readLocalizedAttributeValues(
  attributeEnumValueIds: readonly string[],
  requestedLocale: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedAttributeValue[]> {
  if (attributeEnumValueIds.length === 0) return [];
  const chain = localeFallbackChain(requestedLocale, 'language_then_base');

  const baseRows = await db
    .select({ id: attributeEnumValues.id, label: attributeEnumValues.label })
    .from(attributeEnumValues)
    .where(inArray(attributeEnumValues.id, [...attributeEnumValueIds]));
  if (baseRows.length === 0) return [];

  const localizations = await db
    .select()
    .from(attributeValueLocalizations)
    .where(
      inArray(
        attributeValueLocalizations.attributeEnumValueId,
        baseRows.map((row) => row.id),
      ),
    );

  const byValue = new Map<string, LocalizationCandidate[]>();
  for (const row of localizations) {
    if (!chain.includes(row.locale)) continue;
    const bucket = byValue.get(row.attributeEnumValueId) ?? [];
    bucket.push({
      locale: row.locale,
      status: row.status,
      provenance: row.provenance,
      value: row.label,
    });
    byValue.set(row.attributeEnumValueId, bucket);
  }

  const baseById = new Map(baseRows.map((row) => [row.id, row.label]));
  const presented: LocalizedAttributeValue[] = [];
  for (const id of attributeEnumValueIds) {
    const baseLabel = baseById.get(id);
    if (baseLabel === undefined) continue;
    presented.push({
      attributeEnumValueId: id,
      label: resolveObservedLocalizedField({
        field: 'attribute_value.label',
        requestedLocale,
        candidates: byValue.get(id) ?? [],
        baseValue: baseLabel,
      }),
    });
  }
  return presented;
}

/*
 * A "what is still untranslated" READ is deliberately absent from this file.
 *
 * `findCategoryLocalizationCoverage` in the repository answers it for ONE
 * category, served by the leading column of
 * `category_localizations_locale_key`. The catalogue-wide version — "every
 * category still owing a Spanish name" — is a translation-desk query, it needs
 * an index this schema deliberately does not carry yet (see the schema file's
 * closing note), and it needs a surface to be read from. It arrives with the
 * desk (#367 merge-order step 10), not before it.
 */
