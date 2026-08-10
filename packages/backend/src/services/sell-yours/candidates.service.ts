/**
 * Finding the canonical product a seller means (#91 entry paths 3 and 4).
 *
 * ## A scan resolves; a search suggests. The DTO says which
 *
 * `foundBy` is the whole of what a client may render about how a candidate was
 * found, and it is deliberately a LABEL rather than a score. A number beside a
 * product somebody is about to claim reads as a probability that they are right,
 * and there is nothing here that could honestly produce one: an identifier match
 * is certain (a check digit and one active owner), and a trigram similarity is a
 * retrieval rank rather than a statement about the object in their hands.
 *
 * ## Nothing here decides a match
 *
 * These are candidates a person picks from. What happens to their pick is
 * `match-gate.ts`'s, at publication, against #58's own blockers — so a scan that
 * resolves to the wrong product is caught by the same guard that catches a
 * mis-tap, rather than by trusting the scan because a scan feels precise.
 */

import type { SellerMatchCandidateDTO } from '@mercaria/shared-types';
import { IDENTIFIER_SCHEMES } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { listCanonicalImages } from '../../db/canonical/attributeRepository.js';
import { findBrandsByIds } from '../../db/canonical/brandRepository.js';
import {
  findCanonicalProductsByIds,
  searchCanonicalProductsByNameSimilarity,
} from '../../db/canonical/canonicalProductRepository.js';
import { findCanonicalVariantsByIds } from '../../db/canonical/canonicalVariantRepository.js';
import { findActiveCanonicalOwner } from '../../db/canonical/productIdentifierRepository.js';
import { getDb } from '../../db/postgres.js';
import { normalizeEntityName } from '../canonical/normalization.js';
import { normalizeIdentifier } from '../canonical/identifiers.js';

/** Compose the wire shape for a set of products, with one picture each. */
async function toCandidates(
  productIds: readonly string[],
  foundBy: SellerMatchCandidateDTO['foundBy'],
  variantByProduct: ReadonlyMap<string, string>,
): Promise<SellerMatchCandidateDTO[]> {
  if (productIds.length === 0) return [];
  const db = getDb();
  const products = await findCanonicalProductsByIds(db, productIds);
  const active = products.filter((product) => product.status === 'active');
  if (active.length === 0) return [];

  const brands = await findBrandsByIds(
    db,
    active.map((product) => product.brandId).filter((id): id is string => id !== null),
  );
  const brandsById = new Map(brands.map((brand) => [brand.id, brand]));

  const candidates: SellerMatchCandidateDTO[] = [];
  for (const product of active) {
    const images = await listCanonicalImages(db, { kind: 'product', id: product.id });
    const image = images.find((row) => row.status === 'active' && row.fileId);
    const brand = product.brandId ? brandsById.get(product.brandId) : undefined;
    const variantId = variantByProduct.get(product.id);
    candidates.push({
      canonicalProductId: product.id,
      ...(variantId ? { canonicalVariantId: variantId } : {}),
      title: product.name,
      ...(brand ? { brand: brand.name } : {}),
      ...(image?.fileId ? { imageFileId: image.fileId } : {}),
      foundBy,
    });
  }
  return candidates;
}

/**
 * Resolve a scanned identifier to its canonical owner.
 *
 * Every scheme in the registry is tried, and the FIRST that both validates and
 * resolves wins. Trying them all rather than asking the client which scheme it
 * scanned is what makes a barcode reader that reports `ean13` for a UPC-A label
 * work: the value normalizes to the same GTIN-14 either way, and a client's
 * guess about the symbology is not a fact worth trusting.
 *
 * An INVALID value produces no candidate and no error. A mistyped check digit is
 * evidence somebody typed it wrong, never evidence about a product — #58's own
 * rule, and inventing a near-match here would be the false merge with a scanner
 * in front of it.
 */
export async function findCandidatesByIdentifier(
  rawValue: string,
): Promise<SellerMatchCandidateDTO[]> {
  const db = getDb();
  for (const scheme of IDENTIFIER_SCHEMES) {
    const normalized = normalizeIdentifier(scheme, rawValue);
    if (normalized.kind !== 'valid') continue;
    const { identifier } = normalized;
    if (identifier.canonicalScheme === undefined || identifier.canonicalValue === undefined) {
      continue;
    }
    const owner = await findActiveCanonicalOwner(
      db,
      identifier.canonicalScheme,
      identifier.canonicalValue,
    );
    if (!owner) continue;

    if (owner.variantId) {
      const [variant] = await findCanonicalVariantsByIds(db, [owner.variantId]);
      if (!variant) continue;
      return toCandidates([variant.productId], 'identifier', new Map([[variant.productId, variant.id]]));
    }
    if (owner.productId) {
      return toCandidates([owner.productId], 'identifier', new Map());
    }
  }
  return [];
}

/** Canonical products whose name is similar to what the seller typed. */
export async function findCandidatesByText(query: string): Promise<SellerMatchCandidateDTO[]> {
  const rows = await searchCanonicalProductsByNameSimilarity(
    getDb(),
    normalizeEntityName(query),
    config.sellYours.candidateLimit,
  );
  return toCandidates(
    rows.map((row) => row.product.id),
    'search',
    new Map(),
  );
}
