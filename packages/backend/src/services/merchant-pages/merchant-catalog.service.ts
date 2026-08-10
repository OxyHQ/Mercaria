/**
 * The merchant catalogue browse — deduplicated product cards, and the
 * offer-level view beside it (#73 catalogue-browse rules 1–6).
 *
 * ## Two views, one projection
 *
 * The PRODUCT view answers "what does this merchant sell", one card per
 * canonical product however many variants, channels and countries it is listed
 * in. The OFFER view answers "which of its channels, or which seller on this
 * channel, has it" and is deliberately NOT deduplicated. Both hydrate their
 * offers through #70's `loadOffersWithChannel` and project them through #57's
 * `projectOffer` with #57's own context builder, so the freshness verdict, the
 * seller role, the channel operator and the checkout eligibility a merchant
 * page shows are the same objects `GET /offers` shows. There is no
 * merchant-shaped copy of any of them.
 *
 * ## The live derivation still has the last word
 *
 * The SQL narrows on `stale_at`, the indexed stored deadline. What a page
 * SHOWS is then filtered by the live per-source freshness verdict #68 derives
 * inside `projectOffer` — so a contractual cache cap that shortened a lifetime
 * this morning bites here with no sweep having run, and a page may return fewer
 * rows than its limit. That cost is #68's, stated rather than hidden, and the
 * keyset cursor is unaffected because it is a cursor over the SQL order.
 *
 * ## Nothing here ranks
 *
 * The order is `max(last_seen_at) desc` — most recently confirmed first, which
 * is a fact about when Mercaria last heard from the source and the order
 * `offers_merchant_browse_idx` was built to serve. No relevance score, no
 * verification, no rating, no fee, no plan and no commission is consulted;
 * `merchant-page-isolation.test.ts` fails the build if this domain learns to
 * reach any of them. #74 owns ranking.
 */

import type {
  MerchantCatalogEmptyReason,
  MerchantCatalogEntry,
  MerchantCatalogFilters,
  MerchantCatalogPage,
  MerchantCatalogScope,
  MerchantOfferPage,
  Offer,
} from '@mercaria/shared-types';
import { mayAppearInComparison } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  countScopedOffers,
  listMerchantCatalogProductIds,
  listMerchantOfferIds,
  rankScopedProductOfferIds,
} from '../../db/merchantPages/merchantCatalogRepository.js';
import {
  loadBrandRefs,
  loadPrimaryProductImages,
  loadProductResultRows,
} from '../../db/search/searchCandidateRepository.js';
import { loadOffersWithChannel } from '../../db/search/searchOfferRepository.js';
import { SUMMARY_OFFER_LIMIT } from '../offer-freshness/product-summary.js';
import { buildOfferProjectionContext } from '../offers/offer.service.js';
import { projectOffer } from '../offers/offer-projection.js';
import { validationError } from '../../lib/errors/error-codes.js';
import { toMerchantCatalogEntry, type CatalogEntryProduct } from './catalog-entry.js';

/**
 * Encode a keyset cursor.
 *
 * `<epoch microseconds>.<id>` — digits, a dot, then an id that contains none.
 * Deliberately not base64: an encoding that only LOOKS opaque invites somebody
 * to decode and hand-craft one, and both halves are validated on the way back
 * in anyway (#57's `encodeCursor` states the same reasoning). The timestamp
 * half is exact rather than a millisecond `Date`, because a truncated boundary
 * in a DESCENDING keyset SKIPS rows rather than repeating them.
 */
function encodeCursor(cursorKey: string, id: string): string {
  return `${cursorKey}.${id}`;
}

function decodeCursor(cursor: string): { cursorKey: string; id: string } | undefined {
  const separator = cursor.indexOf('.');
  if (separator <= 0) return undefined;
  const cursorKey = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (id === '' || !/^-?\d+$/.test(cursorKey)) return undefined;
  return { cursorKey, id };
}

/**
 * Why an empty page is empty (#73 catalogue-browse rule 6).
 *
 * Asked ONLY when the page came back empty, which is the only time the answer
 * is needed and the only time a second count is worth issuing. The order of the
 * branches matters: SQL having found products that the LIVE freshness
 * derivation then refused is `stale_sources` and not `filtered_out`, because
 * the filters demonstrably admitted them.
 */
async function resolveEmptyReason(input: {
  merchantId: string;
  scope: MerchantCatalogScope;
  sqlFoundRows: boolean;
  now: Date;
}): Promise<MerchantCatalogEmptyReason> {
  if (input.sqlFoundRows) return 'stale_sources';
  const counts = await countScopedOffers(getDb(), {
    merchantId: input.merchantId,
    scope: input.scope,
    now: input.now,
  });
  if (counts.active === 0) return 'no_offers';
  if (counts.current === 0) return 'stale_sources';
  return 'filtered_out';
}

/** How a caller asks for a catalogue page. */
export interface MerchantCatalogQuery {
  merchantId: string;
  scope: MerchantCatalogScope;
  filters?: MerchantCatalogFilters;
  limit: number;
  cursor?: string;
  now?: Date;
}

/**
 * One page of deduplicated canonical-product cards.
 *
 * Five statements regardless of page size, and none of them per card: the
 * product ids, the offers those products' cards are priced from, the product
 * rows, their brands and their images. The offer projection context is built
 * once over the whole page, exactly as `listOffers` does — a per-card context
 * would be four extra round trips per card.
 */
export async function getMerchantCatalog(
  query: MerchantCatalogQuery,
): Promise<MerchantCatalogPage> {
  const now = query.now ?? new Date();
  const db = getDb();
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && after === undefined) throw validationError('Malformed cursor');

  const productRows = await listMerchantCatalogProductIds(db, {
    merchantId: query.merchantId,
    scope: query.scope,
    ...(query.filters === undefined ? {} : { filters: query.filters }),
    limit: query.limit + 1,
    ...(after === undefined
      ? {}
      : { after: { cursorKey: after.cursorKey, canonicalProductId: after.id } }),
    now,
  });

  const page = productRows.slice(0, query.limit);
  const canonicalProductIds = page.map((row) => row.canonicalProductId);

  const ranked = await rankScopedProductOfferIds(db, {
    merchantId: query.merchantId,
    scope: query.scope,
    ...(query.filters === undefined ? {} : { filters: query.filters }),
    canonicalProductIds,
    limitPerProduct: SUMMARY_OFFER_LIMIT,
    now,
  });

  const offerRows = await loadOffersWithChannel(db, ranked.map((row) => row.offerId));
  const context = await buildOfferProjectionContext(offerRows, now, db);
  const projectedById = new Map<string, Offer>(
    offerRows.map((row) => [
      row.offer.id,
      projectOffer(row.offer, row.storefrontOperatorMerchantId, context),
    ]),
  );

  const offersByProduct = new Map<string, Offer[]>();
  for (const row of ranked) {
    const projected = projectedById.get(row.offerId);
    if (projected === undefined) continue;
    const list = offersByProduct.get(row.canonicalProductId);
    if (list === undefined) offersByProduct.set(row.canonicalProductId, [projected]);
    else list.push(projected);
  }

  const [productRowsById, images] = await Promise.all([
    loadProductResultRows(db, canonicalProductIds),
    loadPrimaryProductImages(db, canonicalProductIds),
  ]);
  const brandIds = [
    ...new Set(productRowsById.flatMap((row) => (row.brandId === null ? [] : [row.brandId]))),
  ];
  const brands = await loadBrandRefs(db, brandIds);
  const brandById = new Map(brands.map((brand) => [brand.id, brand]));
  const imageByProduct = new Map(images.map((image) => [image.productId, image]));
  const productById = new Map(productRowsById.map((row) => [row.id, row]));

  const entries: MerchantCatalogEntry[] = [];
  for (const row of page) {
    const product = productById.get(row.canonicalProductId);
    if (product === undefined) continue;
    const brand = product.brandId === null ? undefined : brandById.get(product.brandId);
    const image = imageByProduct.get(product.id);
    const entryProduct: CatalogEntryProduct = {
      canonicalProductId: product.id,
      slug: product.slug,
      name: product.name,
      ...(brand === undefined
        ? {}
        : { brand: { id: brand.id, slug: brand.slug, name: brand.name } }),
      ...(product.categoryId === null ? {} : { categoryId: product.categoryId }),
      ...(image === undefined
        ? {}
        : { image: { fileId: image.fileId, sourceUrl: image.sourceUrl, alt: image.alt } }),
    };
    const entry = toMerchantCatalogEntry({
      product: entryProduct,
      projected: offersByProduct.get(row.canonicalProductId) ?? [],
      pageMerchantId: query.merchantId,
    });
    // A card with no CURRENT offer is not a product this merchant is offering:
    // every observation of it failed the live freshness derivation. Rendering
    // it would be a card a shopper can tap and find nothing behind, which is
    // the dishonest empty state rule 6 is about.
    if (entry.currentOfferCount > 0) entries.push(entry);
  }

  const last = page[page.length - 1];
  const emptyReason =
    entries.length > 0
      ? undefined
      : await resolveEmptyReason({
          merchantId: query.merchantId,
          scope: query.scope,
          sqlFoundRows: productRows.length > 0,
          now,
        });

  return {
    merchantId: query.merchantId,
    scope: query.scope,
    entries,
    ...(productRows.length > query.limit && last !== undefined
      ? { nextCursor: encodeCursor(last.cursorKey, last.canonicalProductId) }
      : {}),
    ...(emptyReason === undefined ? {} : { emptyReason }),
  };
}

/**
 * One page of the offer-level view (#73 catalogue-browse rule 4).
 *
 * The reader `offers_merchant_browse_idx` and `offers_storefront_browse_idx`
 * were built for and had none until now (#61 recorded exactly that).
 * `graph-plan-regression.realdb.test.ts` asserts the plan still names one of
 * them, so a future filter that made the index unusable fails a build rather
 * than a page.
 */
export async function getMerchantOffers(query: MerchantCatalogQuery): Promise<MerchantOfferPage> {
  const now = query.now ?? new Date();
  const db = getDb();
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && after === undefined) throw validationError('Malformed cursor');

  const rows = await listMerchantOfferIds(db, {
    merchantId: query.merchantId,
    scope: query.scope,
    ...(query.filters === undefined ? {} : { filters: query.filters }),
    limit: query.limit + 1,
    ...(after === undefined ? {} : { after: { cursorKey: after.cursorKey, offerId: after.id } }),
    now,
  });

  const page = rows.slice(0, query.limit);
  const offerRows = await loadOffersWithChannel(db, page.map((row) => row.offerId));
  const context = await buildOfferProjectionContext(offerRows, now, db);
  const byId = new Map(
    offerRows.map((row) => [
      row.offer.id,
      projectOffer(row.offer, row.storefrontOperatorMerchantId, context),
    ]),
  );

  // Re-ordered to the SQL order, because `loadOffersWithChannel` reads by id
  // set and returns whatever order the planner produced — a page whose rows
  // arrived in an arbitrary order would contradict its own cursor.
  const projected = page.flatMap((row) => {
    const offer = byId.get(row.offerId);
    return offer !== undefined && mayAppearInComparison(offer.freshness) ? [offer] : [];
  });

  const last = page[page.length - 1];
  const emptyReason =
    projected.length > 0
      ? undefined
      : await resolveEmptyReason({
          merchantId: query.merchantId,
          scope: query.scope,
          sqlFoundRows: rows.length > 0,
          now,
        });

  return {
    merchantId: query.merchantId,
    scope: query.scope,
    offers: projected,
    ...(rows.length > query.limit && last !== undefined
      ? { nextCursor: encodeCursor(last.cursorKey, last.offerId) }
      : {}),
    ...(emptyReason === undefined ? {} : { emptyReason }),
  };
}
