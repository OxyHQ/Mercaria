/**
 * Side-by-side source and target review (#367 merge-order step 10).
 *
 * One entity, one locale, every registered field: what the base locale says
 * beside what the translation says, with the provenance and the review audit a
 * reviewer needs to decide whether to settle it.
 *
 * ## It reads what is STORED and resolves nothing
 *
 * This is the one localized read in the codebase that deliberately does NOT go
 * through `resolve.ts`. The resolver exists to answer "what should a shopper in
 * `es-mx` see", and its whole job is to fall back — through `es`, then to the
 * base locale — so that a reader never sees a raw key. A reviewer asking "is the
 * Spanish approved" must never be shown the English that would be served in its
 * place and told it is the Spanish; that is the one question fallback makes
 * unanswerable.
 *
 * So: an exact-locale row or none, and {@link LocalizedFieldTarget}'s `absent`
 * branch carries no text, no status and no provenance at all — a review screen
 * cannot render a fallback as a translation because there is no field to put one
 * in. `LocalizationCandidate` and `localeFallbackChain` are not imported here,
 * which is what keeps that true for whoever edits this next.
 *
 * ## Some fields have no source to show at all
 *
 * `LOCALIZED_FIELD_BASE_SOURCES` records which entity column holds each field's
 * base text and which fields have none — `categories` has no description and
 * `product_type_definitions` has no help text. The descriptor travels on every
 * comparison, so an empty source box is explained rather than ambiguous.
 * `product_type_field` (#633) is the one domain where every registered field has
 * a base column, so its review screen never shows one for a structural reason.
 */

import { eq, inArray, and } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  CATALOG_LOCALIZED_FIELDS,
  LOCALIZED_FIELD_BASE_SOURCES,
  LOCALIZED_FIELD_KEYS,
  MERCARIA_BASE_LOCALE,
  type LocalizedEntityComparison,
  type LocalizedEntityKind,
  type LocalizedFieldComparison,
  type LocalizedFieldTarget,
  type SupportedLocale,
} from '@mercaria/shared-types';
import { categories } from '../../db/schema/catalog.js';
import { productTypeDefinitions, productTypeFields } from '../../db/schema/productTypes.js';
import {
  canonicalProductFamilies,
  canonicalProducts,
} from '../../db/schema/canonicalCatalog.js';
import { attributeEnumValues } from '../../db/schema/attributeRegistry.js';
import {
  attributeValueLocalizations,
  canonicalProductFamilyLocalizations,
  canonicalProductLocalizations,
  categoryLocalizations,
  productTypeFieldLocalizations,
  productTypeLocalizations,
} from '../../db/schema/catalogLocalization.js';
import { stalenessDetectionFor } from './completeness.service.js';

/** The localization row shape the three domains share, as far as review needs. */
interface ReviewRow {
  readonly status: string;
  readonly provenance: string;
  readonly sourceLocale: string | null;
  readonly sourceRevision: string | null;
  readonly reviewedByOxyUserId: string | null;
  readonly reviewedAt: Date | null;
  readonly texts: Readonly<Record<string, string | null>>;
}

/**
 * Turn a stored row and one field's column into a reviewable target.
 *
 * The `declared_missing` branch is why this is not a ternary. A row with
 * `status = 'missing'` is somebody having OPENED the work — the schema's
 * `<table>_missing_text_check` makes that row's text NULL by construction — and
 * a reviewer needs it distinguished from no row at all, because only one of the
 * two means a person has already looked.
 */
function targetFor(row: ReviewRow | undefined, column: string): LocalizedFieldTarget {
  if (!row) return { kind: 'absent' };
  if (row.status === 'missing') {
    return { kind: 'declared_missing', status: 'missing', provenance: row.provenance };
  }
  const text = row.texts[column];
  // A row that is not `missing` may still hold NULL in a SECONDARY column — only
  // the primary text is tied to the status by a CHECK. `category_localizations`
  // with an approved `name` and no `description` is an ordinary, valid row, and
  // that field is genuinely untranslated.
  if (text === null || text === undefined) return { kind: 'absent' };
  return {
    kind: 'present',
    text,
    status: row.status,
    provenance: row.provenance,
    sourceLocale: row.sourceLocale,
    sourceRevision: row.sourceRevision,
    reviewedByOxyUserId: row.reviewedByOxyUserId,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
  };
}

/** The registered fields of one domain, in `LOCALIZED_FIELD_KEYS` order. */
function fieldsOf(domain: LocalizedEntityKind): readonly string[] {
  return LOCALIZED_FIELD_KEYS.filter((key) => CATALOG_LOCALIZED_FIELDS[key].entity === domain);
}

function compose(
  domain: LocalizedEntityKind,
  entityId: string,
  locale: SupportedLocale,
  row: ReviewRow | undefined,
  baseTexts: Readonly<Record<string, string | null>>,
): LocalizedEntityComparison {
  const fields: LocalizedFieldComparison[] = fieldsOf(domain).map((field) => {
    const descriptor = CATALOG_LOCALIZED_FIELDS[field];
    const baseSource = LOCALIZED_FIELD_BASE_SOURCES[field];
    return {
      field,
      baseSource,
      source: baseSource.kind === 'column' ? (baseTexts[baseSource.column] ?? null) : null,
      target: targetFor(row, descriptor.column),
    };
  });
  return {
    domain,
    entityId,
    locale,
    baseLocale: MERCARIA_BASE_LOCALE,
    fields,
    stalenessDetection: stalenessDetectionFor(domain),
  };
}

/**
 * One category, source beside target, in one locale.
 *
 * Returns `undefined` for a category that does not exist — "this category has no
 * Spanish name" and "there is no such category" are different facts and only one
 * of them is about localization, which is `readLocalizedCategories`' ruling one
 * file over and holds for the same reason.
 */
export async function reviewCategoryLocalization(
  categoryId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedEntityComparison | undefined> {
  const [base] = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  if (!base) return undefined;

  const [row] = await db
    .select()
    .from(categoryLocalizations)
    .where(
      and(
        eq(categoryLocalizations.categoryId, categoryId),
        eq(categoryLocalizations.locale, locale),
      ),
    )
    .limit(1);

  return compose(
    'category',
    categoryId,
    locale,
    row && { ...row, texts: { name: row.name, description: row.description } },
    { name: base.name },
  );
}

/** One product-type VERSION, source beside target, in one locale. */
export async function reviewProductTypeLocalization(
  productTypeDefinitionId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedEntityComparison | undefined> {
  const [base] = await db
    .select({
      id: productTypeDefinitions.id,
      name: productTypeDefinitions.name,
      description: productTypeDefinitions.description,
    })
    .from(productTypeDefinitions)
    .where(eq(productTypeDefinitions.id, productTypeDefinitionId))
    .limit(1);
  if (!base) return undefined;

  const [row] = await db
    .select()
    .from(productTypeLocalizations)
    .where(
      and(
        eq(productTypeLocalizations.productTypeDefinitionId, productTypeDefinitionId),
        eq(productTypeLocalizations.locale, locale),
      ),
    )
    .limit(1);

  return compose(
    'product_type',
    productTypeDefinitionId,
    locale,
    row && {
      ...row,
      texts: { name: row.name, description: row.description, helpText: row.helpText },
    },
    { name: base.name, description: base.description },
  );
}

/** One controlled value, source beside target, in one locale. */
export async function reviewAttributeValueLocalization(
  attributeEnumValueId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedEntityComparison | undefined> {
  const [base] = await db
    .select({ id: attributeEnumValues.id, label: attributeEnumValues.label })
    .from(attributeEnumValues)
    .where(eq(attributeEnumValues.id, attributeEnumValueId))
    .limit(1);
  if (!base) return undefined;

  const [row] = await db
    .select()
    .from(attributeValueLocalizations)
    .where(
      and(
        eq(attributeValueLocalizations.attributeEnumValueId, attributeEnumValueId),
        eq(attributeValueLocalizations.locale, locale),
      ),
    )
    .limit(1);

  return compose(
    'attribute_value',
    attributeEnumValueId,
    locale,
    row && { ...row, texts: { label: row.label, description: row.description } },
    { label: base.label },
  );
}

/** One product-type FIELD's authoring copy, source beside target (#633). */
export async function reviewProductTypeFieldLocalization(
  productTypeFieldId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedEntityComparison | undefined> {
  const [base] = await db
    .select({
      id: productTypeFields.id,
      label: productTypeFields.label,
      helpText: productTypeFields.helpText,
      placeholder: productTypeFields.placeholder,
      example: productTypeFields.example,
    })
    .from(productTypeFields)
    .where(eq(productTypeFields.id, productTypeFieldId))
    .limit(1);
  if (!base) return undefined;

  const [row] = await db
    .select()
    .from(productTypeFieldLocalizations)
    .where(
      and(
        eq(productTypeFieldLocalizations.productTypeFieldId, productTypeFieldId),
        eq(productTypeFieldLocalizations.locale, locale),
      ),
    )
    .limit(1);

  return compose(
    'product_type_field',
    productTypeFieldId,
    locale,
    row && {
      ...row,
      texts: {
        label: row.label,
        helpText: row.helpText,
        placeholder: row.placeholder,
        example: row.example,
      },
    },
    // Keyed by SQL column name, which is what `LOCALIZED_FIELD_BASE_SOURCES`
    // names — `help_text`, not `helpText`.
    {
      label: base.label,
      help_text: base.helpText,
      placeholder: base.placeholder,
      example: base.example,
    },
  );
}

/** One canonical product, source beside target, in one locale (#367 L2). */
export async function reviewCanonicalProductLocalization(
  canonicalProductId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedEntityComparison | undefined> {
  const [base] = await db
    .select({
      id: canonicalProducts.id,
      name: canonicalProducts.name,
      description: canonicalProducts.description,
    })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, canonicalProductId))
    .limit(1);
  if (!base) return undefined;

  const [row] = await db
    .select()
    .from(canonicalProductLocalizations)
    .where(
      and(
        eq(canonicalProductLocalizations.canonicalProductId, canonicalProductId),
        eq(canonicalProductLocalizations.locale, locale),
      ),
    )
    .limit(1);

  return compose(
    'canonical_product',
    canonicalProductId,
    locale,
    row && { ...row, texts: { name: row.name, description: row.description } },
    { name: base.name, description: base.description },
  );
}

/** One product family, source beside target, in one locale (#367 L2). */
export async function reviewCanonicalProductFamilyLocalization(
  canonicalProductFamilyId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedEntityComparison | undefined> {
  const [base] = await db
    .select({
      id: canonicalProductFamilies.id,
      name: canonicalProductFamilies.name,
      description: canonicalProductFamilies.description,
    })
    .from(canonicalProductFamilies)
    .where(eq(canonicalProductFamilies.id, canonicalProductFamilyId))
    .limit(1);
  if (!base) return undefined;

  const [row] = await db
    .select()
    .from(canonicalProductFamilyLocalizations)
    .where(
      and(
        eq(
          canonicalProductFamilyLocalizations.canonicalProductFamilyId,
          canonicalProductFamilyId,
        ),
        eq(canonicalProductFamilyLocalizations.locale, locale),
      ),
    )
    .limit(1);

  return compose(
    'canonical_product_family',
    canonicalProductFamilyId,
    locale,
    row && { ...row, texts: { name: row.name, description: row.description } },
    { name: base.name, description: base.description },
  );
}

/**
 * One entity in one locale, dispatched on the domain.
 *
 * A `switch` over {@link LocalizedEntityKind} rather than a lookup table, so a
 * domain added to the union is a compile error here rather than a runtime
 * `undefined` — the review surface silently not covering a domain is the same
 * class of failure the completeness census exists to prevent.
 */
export async function reviewLocalization(
  domain: LocalizedEntityKind,
  entityId: string,
  locale: SupportedLocale,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizedEntityComparison | undefined> {
  switch (domain) {
    case 'category':
      return reviewCategoryLocalization(entityId, locale, db);
    case 'product_type':
      return reviewProductTypeLocalization(entityId, locale, db);
    case 'product_type_field':
      return reviewProductTypeFieldLocalization(entityId, locale, db);
    case 'canonical_product':
      return reviewCanonicalProductLocalization(entityId, locale, db);
    case 'canonical_product_family':
      return reviewCanonicalProductFamilyLocalization(entityId, locale, db);
    case 'attribute_value':
      return reviewAttributeValueLocalization(entityId, locale, db);
    default: {
      const unreachable: never = domain;
      throw new Error(`unhandled localized entity kind: ${String(unreachable)}`);
    }
  }
}

/**
 * Every locale's translation of one entity, for a reviewer comparing a set.
 *
 * Two statements whatever the locale count — the `readLocalizedCategories`
 * discipline — because a reviewer opening a category typically wants all eleven
 * launch locales at once and a per-locale call would be eleven round trips.
 */
export async function reviewCategoryLocalizationsAcrossLocales(
  categoryId: string,
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalizedEntityComparison[]> {
  if (locales.length === 0) return [];
  const [base] = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  if (!base) return [];

  const rows = await db
    .select()
    .from(categoryLocalizations)
    .where(
      and(
        eq(categoryLocalizations.categoryId, categoryId),
        inArray(categoryLocalizations.locale, [...locales]),
      ),
    );
  const byLocale = new Map(rows.map((row) => [row.locale, row]));

  // Driven by the REQUESTED locales rather than by the rows found, so a locale
  // with no translation appears with an `absent` target instead of vanishing.
  // Iterating the rows would make "nothing to review" and "nothing translated"
  // render identically, which is this whole domain's recurring failure.
  return locales.map((locale) => {
    const row = byLocale.get(locale);
    return compose(
      'category',
      categoryId,
      locale,
      row && { ...row, texts: { name: row.name, description: row.description } },
      { name: base.name },
    );
  });
}
