/**
 * A saved PRODUCT, projected for a buyer's list (#80 API rules 3, 4 and 6).
 *
 * Four facts per entry and each one is deliberate:
 *
 *  - the SAVE itself, including its split ambiguity and the job that caused it;
 *  - the PRODUCT, with a save count run through the disclosure policy — #80
 *    privacy rules 1 and 4, applied here rather than at the edge so no route can
 *    ship a raw count by forgetting to;
 *  - the current best OFFER, or a reasoned absence (`best-offer.ts`);
 *  - the PRICE CHANGE against the reference observed when the save was made.
 *
 * ## The price change is a comparison, never a history
 *
 * #78 owns price history and this file must not become a second one. What is
 * stored is ONE immutable observation on the save row; what is computed is the
 * difference between it and the price right now. A comparison across DIFFERENT
 * currencies is refused rather than converted (`currency_changed`): running it
 * through FX would report a rate movement as a price movement, and a buyer
 * reading "12% cheaper" would be reading about the euro.
 */

import type {
  ProductSaveResolution,
  SavedProductEntry,
  SavedProductOffer,
  SavedProductPriceChange,
  SavedProductSummary,
} from '@mercaria/shared-types';
import {
  discloseProductSaveCount,
  PRODUCT_SAVE_PRICE_ALERT_DISABLED,
  PRODUCT_SAVE_PRICE_ALERT_SUPPORTED,
} from '@mercaria/shared-types';
import { eq, inArray, sql } from 'drizzle-orm';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { canonicalImages, canonicalProducts } from '../../db/schema/canonicalCatalog.js';
import { catalogSplitJobs } from '../../db/schema/curation.js';
import { findProductSaveAggregates } from '../../db/productSaves/productSaveAggregateRepository.js';
import type { ProductSaveRow } from '../../db/productSaves/productSaveRepository.js';
import { toProductSaveDTO } from './product-save.service.js';
import { readBestOfferForProduct } from './best-offer.js';

/**
 * Project a page of saves.
 *
 * Keyed by SAVE id rather than product id, because the caller merges these with
 * listing entries under one ordering and needs to look each one up by the row
 * it came from. A save whose product is a tombstone is OMITTED — see
 * `saved-items.service.ts`, where the reason that is safe rather than lossy
 * belongs.
 */
export async function projectSavedProducts(
  saves: readonly ProductSaveRow[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, SavedProductEntry>> {
  if (saves.length === 0) return new Map();

  const productIds = [...new Set(saves.map((save) => save.canonicalProductId))];
  const splitJobIds = [
    ...new Set(
      saves
        .map((save) => save.ambiguousSplitJobId)
        .filter((jobId): jobId is string => jobId !== null),
    ),
  ];

  const [products, images, aggregates, splitTargets, offers] = await Promise.all([
    db
      .select({
        id: canonicalProducts.id,
        slug: canonicalProducts.slug,
        name: canonicalProducts.name,
        brandId: canonicalProducts.brandId,
        status: canonicalProducts.status,
      })
      .from(canonicalProducts)
      .where(inArray(canonicalProducts.id, productIds)),
    readPrimaryImages(productIds, db),
    findProductSaveAggregates(productIds, db),
    readSplitTargets(splitJobIds, db),
    readBestOffers(saves),
  ]);

  const productById = new Map(products.map((product) => [product.id, product]));
  const entries = new Map<string, SavedProductEntry>();

  for (const save of saves) {
    const product = productById.get(save.canonicalProductId);
    if (!product || product.status === 'merged') continue;

    const offer = offers.get(save.id) ?? { state: 'none' as const, reason: 'no_offers_recorded' as const };
    const summary: SavedProductSummary = {
      id: product.id,
      slug: product.slug,
      name: product.name,
      ...(product.brandId ? { brandId: product.brandId } : {}),
      ...(images.get(product.id) ? { imageFileId: images.get(product.id) as string } : {}),
      saveCount: discloseProductSaveCount(aggregates.get(product.id)?.saveCount ?? 0),
    };

    const dto = toProductSaveDTO(save, splitTargets);
    entries.set(save.id, {
      kind: 'product',
      save: dto,
      product: summary,
      offer,
      priceChange: derivePriceChange(dto.referencePrice, offer),
      // #79 CLOSED the seam #80 opened, and this is still one value for the
      // whole page rather than a per-save read: whether alerts are MOUNTED is a
      // deployment fact, and reading anything per-save would mean this domain
      // reaching #79's, which `product-save-isolation.test.ts` refuses. The
      // client asks `/price-alerts` what the buyer has actually set.
      priceAlert: config.priceAlerts.enabled
        ? PRODUCT_SAVE_PRICE_ALERT_SUPPORTED
        : PRODUCT_SAVE_PRICE_ALERT_DISABLED,
    });
  }

  return entries;
}

/**
 * The best offer per SAVE, because two saves of one product by two people can
 * carry different preferences and therefore different best offers.
 *
 * Sequential rather than `Promise.all` over the page: each call runs #57's
 * comparison read, and firing a page's worth concurrently would turn one buyer
 * opening their saved list into a burst against the offer index.
 */
async function readBestOffers(
  saves: readonly ProductSaveRow[],
): Promise<Map<string, SavedProductOffer>> {
  const offers = new Map<string, SavedProductOffer>();
  for (const save of saves) {
    offers.set(
      save.id,
      await readBestOfferForProduct(save.canonicalProductId, {
        preferredCanonicalVariantId: save.preferredCanonicalVariantId,
        preferredConditionGroup: save.preferredConditionGroup,
        preferredMerchantId: save.preferredMerchantId,
      }),
    );
  }
  return offers;
}

/**
 * The lowest-positioned ACTIVE image of each product.
 *
 * `distinct on` rather than a per-product query, and `position, id` so two
 * images sharing a position resolve deterministically instead of alternating
 * between page loads.
 */
async function readPrimaryImages(
  productIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([canonicalImages.productId], {
      productId: canonicalImages.productId,
      fileId: canonicalImages.fileId,
    })
    .from(canonicalImages)
    .where(
      sql`${canonicalImages.productId} = any(${sql.param([...productIds])}::text[])
          and ${canonicalImages.status} = 'active'
          and ${canonicalImages.fileId} is not null`,
    )
    .orderBy(canonicalImages.productId, canonicalImages.position, canonicalImages.id);

  const byProduct = new Map<string, string>();
  for (const row of rows) {
    if (row.productId && row.fileId) byProduct.set(row.productId, row.fileId);
  }
  return byProduct;
}

/** The OTHER candidate of each split that made a save ambiguous. */
async function readSplitTargets(
  jobIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .select({ id: catalogSplitJobs.id, targetEntityId: catalogSplitJobs.targetEntityId })
    .from(catalogSplitJobs)
    .where(inArray(catalogSplitJobs.id, [...jobIds]));
  const byJob = new Map<string, string>();
  for (const row of rows) {
    if (row.targetEntityId) byJob.set(row.id, row.targetEntityId);
  }
  return byJob;
}

/**
 * How the current best price compares with the price observed at save time.
 *
 * Every branch that cannot answer says WHY, and none of them falls back to
 * "unchanged": a buyer told a saved product has not moved when nothing was ever
 * compared has been given a wrong answer, where "we have no earlier price" is a
 * true one.
 */
export function derivePriceChange(
  reference: { readonly amount: number; readonly currency: string; readonly observedAt: string } | undefined,
  offer: SavedProductOffer,
): SavedProductPriceChange {
  if (offer.state !== 'available' || !offer.price) {
    return { known: false, reason: 'no_current_offer' };
  }
  if (!reference) return { known: false, reason: 'no_reference_price' };
  if (reference.currency !== offer.price.currency) {
    return { known: false, reason: 'currency_changed' };
  }
  const deltaMinor = offer.price.amount - reference.amount;
  return {
    known: true,
    direction: deltaMinor < 0 ? 'down' : deltaMinor > 0 ? 'up' : 'unchanged',
    deltaMinor,
    currency: reference.currency,
    since: reference.observedAt,
  };
}

/** One saved product, for the single-save read. */
export async function projectSavedProduct(
  save: ProductSaveRow,
): Promise<SavedProductEntry | undefined> {
  const entries = await projectSavedProducts([save]);
  return entries.get(save.id);
}

/** A save's resolution state, for a caller that only needs the ambiguity. */
export async function readSaveResolution(save: ProductSaveRow): Promise<ProductSaveResolution> {
  if (save.resolutionState !== 'ambiguous_after_split' || !save.ambiguousSplitJobId) {
    return { state: 'resolved' };
  }
  const db = getDb();
  const rows = await db
    .select({ targetEntityId: catalogSplitJobs.targetEntityId })
    .from(catalogSplitJobs)
    .where(eq(catalogSplitJobs.id, save.ambiguousSplitJobId))
    .limit(1);
  const target = rows[0]?.targetEntityId;
  return {
    state: 'ambiguous_after_split',
    splitJobId: save.ambiguousSplitJobId,
    sourceCanonicalProductId: save.canonicalProductId,
    ...(target ? { targetCanonicalProductId: target } : {}),
  };
}
