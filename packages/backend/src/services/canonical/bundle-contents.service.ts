import {
  SHOPPER_VISIBLE_CATALOG_STATUSES,
  type ProductBundleContents,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  readBundleIdentities,
  readBundleImages,
} from '../../db/canonical/bundleContentsRepository.js';

/** Called with a configuration already admitted by the public product read.
 * The merge writer moves component relationships to their winning identities.
 * A stale tombstone, draft or suppressed child must never become a public link.
 */
export async function readPublicBundleContents(
  variantId: string,
): Promise<ProductBundleContents | undefined> {
  return (await readPublicBundleContentsForVariants([variantId])).get(variantId);
}

/** A fixed number of reads for all configurations on one detail page. */
export async function readPublicBundleContentsForVariants(
  variantIds: readonly string[],
): Promise<Map<string, ProductBundleContents>> {
  const db = getDb();
  const allRows = await readBundleIdentities(db, variantIds);
  const result = new Map<string, ProductBundleContents>();
  if (allRows.length === 0) return result;
  const images = await readBundleImages(
    db,
    [...new Set(allRows.map((row) => row.productId))],
    allRows.map((row) => row.variantId),
  );
  for (const variantId of new Set(allRows.map((row) => row.bundleVariantId))) {
    const rows = allRows.filter((row) => row.bundleVariantId === variantId);
    if (
      rows.some(
        (row) =>
          !SHOPPER_VISIBLE_CATALOG_STATUSES.includes(row.productStatus) ||
          !SHOPPER_VISIBLE_CATALOG_STATUSES.includes(row.variantStatus),
      )
    ) {
      result.set(variantId, { status: 'withheld', variantId });
      continue;
    }
    result.set(variantId, {
      status: 'available',
      variantId,
      components: rows.map((row) => {
        const image =
          images.find((image) => image.variantId === row.variantId) ??
          images.find((image) => image.productId === row.productId);
        return {
          productId: row.productId,
          productSlug: row.productSlug,
          variantId: row.variantId,
          name: row.name,
          quantity: row.quantity,
          ...(row.variantName ? { variantName: row.variantName } : {}),
          ...(image
            ? {
                image: {
                  ...(image.sourceUrl ? { sourceUrl: image.sourceUrl } : {}),
                  ...(image.fileId ? { fileId: image.fileId } : {}),
                  ...(image.alt ? { alt: image.alt } : {}),
                },
              }
            : {}),
        };
      }),
    });
  }
  return result;
}
