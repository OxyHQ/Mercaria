/**
 * Turning a native variant or a source observation into a {@link MatchSubject}.
 *
 * The ONE place shape differences between the two are absorbed, which is what
 * lets `pipeline.ts` be genuinely identical for both rather than
 * identical-looking with a branch in the middle.
 *
 * ## Attribute normalization goes through #56's own functions
 *
 * `normalizeAttributeKey`, `normalizeOptionValue` and `normalizeQuantity` are
 * imported, never reimplemented. They are the SAME functions
 * `canonical-variant.service` used to compute the signature a candidate variant
 * is stored under, so "256 GB" on a listing and "0.256 TB" on a feed reduce to
 * the value the canonical row actually holds. A second normalization here would
 * be a copy that drifts, and the failure would look like a matcher that suddenly
 * stops matching things it matched last week.
 *
 * ## What a native listing does NOT carry, and why that is fine
 *
 * `listings` has a free-text `vendor` and no MPN column at all;
 * `product_variants` has a `barcode` with no validation and a globally-unique
 * `sku`. So a native subject asserts its barcode as an `ean` for validation to
 * accept or refuse, declares no model, and carries its SKU as a fact nothing
 * compares (#58 rule 6). Every one of those absences becomes a NULL feature and
 * lowers confidence honestly, which is exactly what rule 5 asks for.
 */

import type { IdentifierScheme, MatchSubjectKind } from '@mercaria/shared-types';
import { normalizeAttributeKey, normalizeOptionValue } from '../canonical/variant-signature.js';
import { normalizeQuantity } from '../canonical/units.js';
import { findListingById } from '../../db/catalog/listingRepository.js';
import {
  findVariantById,
  findVariantOptionValues,
} from '../../db/catalog/variantRepository.js';
import { findSourceRecordById } from '../../db/canonical/provenanceRepository.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { categories } from '../../db/schema/catalog.js';
import { eq } from 'drizzle-orm';
import {
  matchSubjectKey,
  type MatchSubject,
  type MatchSubjectAttribute,
  type MatchSubjectIdentifier,
} from './subject.js';

/**
 * Normalize one observed option value the way the canonical signature does.
 *
 * A quantity reduces to its base-unit magnitude so `256 GB` and `0.256 TB`
 * collapse; anything else folds case and whitespace. The `unknown_unit` and
 * `unparsed` states both fall through to the text folding deliberately — an
 * unrecognised unit is still a value worth comparing verbatim, and refusing it
 * would drop a real axis rather than compare it conservatively.
 */
export function normalizeSubjectAttributeValue(displayValue: string): string {
  const quantity = normalizeQuantity(displayValue);
  if (quantity.state === 'normalized' && quantity.baseMagnitude !== undefined) {
    return `${String(quantity.baseMagnitude)}${quantity.baseUnit ?? ''}`;
  }
  return normalizeOptionValue(displayValue);
}

function toAttribute(name: string, value: string): MatchSubjectAttribute {
  return {
    key: normalizeAttributeKey(name),
    normalizedValue: normalizeSubjectAttributeValue(value),
    displayValue: value,
  };
}

/**
 * Load a native `product_variants` row as a subject.
 *
 * @returns `null` when the variant or its listing is gone. A deleted listing is
 *   not an error for the matcher — the queue row CASCADEs with the variant, so
 *   this is the narrow window where a claim outran a delete, and the honest
 *   answer is that there is nothing to match.
 */
export async function loadNativeVariantSubject(
  productVariantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MatchSubject | null> {
  const variant = await findVariantById(productVariantId, db);
  if (!variant) return null;
  const listing = await findListingById(variant.listingId, db);
  if (!listing) return null;

  const optionValues = (await findVariantOptionValues([variant.id], db)).get(variant.id) ?? [];
  const attributes = optionValues.map((row) => toAttribute(row.name, row.value));

  const identifiers: MatchSubjectIdentifier[] = [];
  if (variant.barcode !== null && variant.barcode.trim().length > 0) {
    // A native barcode is asserted as an EAN and VALIDATED like any other
    // identifier. `product_variants.barcode` carries no check digit rule and no
    // normalization, so a value that does not validate is refused here rather
    // than becoming a canonical identity two tables away.
    identifiers.push({ scheme: 'ean' satisfies IdentifierScheme, rawValue: variant.barcode });
  }

  const categoryKey =
    listing.categoryId === null
      ? undefined
      : ((
          await db
            .select({ slug: categories.slug })
            .from(categories)
            .where(eq(categories.id, listing.categoryId))
            .limit(1)
        )[0]?.slug ?? undefined);

  return {
    kind: 'native_variant' satisfies MatchSubjectKind,
    key: matchSubjectKey({ kind: 'native_variant', productVariantId: variant.id }),
    productVariantId: variant.id,
    listingId: listing.id,
    title: listing.title,
    variantText: variant.title,
    ...(listing.vendor === null ? {} : { brandText: listing.vendor }),
    ...(categoryKey === undefined ? {} : { categoryKey }),
    identifiers,
    ...(variant.sku === null ? {} : { merchantSku: variant.sku }),
    attributes,
    condition: listing.condition === 'used' ? 'used' : 'new',
  };
}

/**
 * The product-shaped fields a `source_records.payload` may carry.
 *
 * The payload is `jsonb` and source-shaped BY DEFINITION (ADR 0002 D19), so this
 * is a READ contract and not a schema: every field is optional, every one is
 * checked for its type at the boundary, and anything unrecognised is ignored
 * rather than coerced. A source that sends `{"gtin": 12345}` as a number has
 * sent a number, and reading it as a GTIN would be inventing a normalization
 * nobody asked for.
 */
interface SourceProductPayload {
  readonly title?: unknown;
  readonly brand?: unknown;
  readonly model?: unknown;
  readonly mpn?: unknown;
  readonly gtin?: unknown;
  readonly ean?: unknown;
  readonly upc?: unknown;
  readonly isbn?: unknown;
  readonly sku?: unknown;
  readonly category?: unknown;
  readonly condition?: unknown;
  readonly attributes?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The payload's `attributes` map, taking only string→string entries. */
function readPayloadAttributes(value: unknown): MatchSubjectAttribute[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const attributes: MatchSubjectAttribute[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const display = asString(raw);
    if (display === undefined) continue;
    attributes.push(toAttribute(key, display));
  }
  return attributes;
}

/**
 * Load a `source_records` observation as a subject.
 *
 * @returns `null` when the record is gone or carries no stored payload. The
 *   second case is ordinary and not an error: `catalog_sources.may_store` is a
 *   RIGHT, and a source Mercaria may read but not store has a `source_records`
 *   row with a NULL payload (D19). There is nothing to match, and inventing a
 *   subject from an absent payload is the one thing that would be worse.
 */
export async function loadSourceRecordSubject(
  sourceRecordId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MatchSubject | null> {
  const record = await findSourceRecordById(db, sourceRecordId);
  if (!record || record.payload === null) return null;
  if (typeof record.payload !== 'object' || Array.isArray(record.payload)) return null;

  const payload = record.payload as SourceProductPayload;
  const title = asString(payload.title);
  if (title === undefined) return null;

  const identifiers: MatchSubjectIdentifier[] = [];
  const push = (scheme: IdentifierScheme, raw: unknown): void => {
    const value = asString(raw);
    if (value !== undefined) identifiers.push({ scheme, rawValue: value });
  };
  // Each field is asserted under the scheme its NAME claims, and validation
  // decides whether the claim holds. A 12-digit value in a `gtin` field is
  // refused as an EAN rather than silently re-read as a UPC: guessing which
  // scheme a source meant is how a valid identifier for one product becomes an
  // invalid assertion about another.
  push('ean', payload.gtin);
  push('ean', payload.ean);
  push('upc', payload.upc);
  push('isbn13', payload.isbn);
  push('mpn', payload.mpn);

  return {
    kind: 'source_record' satisfies MatchSubjectKind,
    key: matchSubjectKey({
      kind: 'source_record',
      sourceId: record.sourceId,
      externalType: record.externalType,
      externalId: record.externalId,
    }),
    sourceRecordId: record.id,
    title,
    ...(asString(payload.brand) === undefined ? {} : { brandText: asString(payload.brand) ?? '' }),
    ...(asString(payload.model) === undefined ? {} : { modelText: asString(payload.model) ?? '' }),
    ...(asString(payload.category) === undefined
      ? {}
      : { categoryKey: asString(payload.category) ?? '' }),
    identifiers,
    ...(asString(payload.sku) === undefined ? {} : { merchantSku: asString(payload.sku) ?? '' }),
    attributes: readPayloadAttributes(payload.attributes),
    condition: asString(payload.condition) === 'used' ? 'used' : 'new',
  };
}
