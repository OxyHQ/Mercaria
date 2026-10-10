import { SHOPPER_VISIBLE_CATALOG_STATUSES, type ProductBundleContents } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { readBundleIdentities, readBundleImages } from '../../db/canonical/bundleContentsRepository.js';

/** Called with a configuration already admitted by the public product read.
 * The merge writer moves component relationships to their winning identities.
 * A stale tombstone, draft or suppressed child must never become a public link.
 */
export async function readPublicBundleContents(variantId: string): Promise<ProductBundleContents | undefined> {
  const db = getDb();
  const rows = await readBundleIdentities(db, variantId);
  if (rows.length === 0) return undefined;
  if (rows.some(row => !SHOPPER_VISIBLE_CATALOG_STATUSES.includes(row.productStatus)
    || !SHOPPER_VISIBLE_CATALOG_STATUSES.includes(row.variantStatus))) {
    return { status: 'withheld', variantId };
  }
  const images = await readBundleImages(db, [...new Set(rows.map(row => row.productId))], rows.map(row => row.variantId));
  return {
    status: 'available', variantId,
    components: rows.map(row => {
      const image = images.find(image => image.variantId === row.variantId)
        ?? images.find(image => image.productId === row.productId);
      return {
        productId: row.productId, productSlug: row.productSlug, variantId: row.variantId,
        name: row.name, quantity: row.quantity,
        ...(row.variantName ? { variantName: row.variantName } : {}),
        ...(image ? { image: {
          ...(image.sourceUrl ? { sourceUrl: image.sourceUrl } : {}),
          ...(image.fileId ? { fileId: image.fileId } : {}),
          ...(image.alt ? { alt: image.alt } : {}),
        } } : {}),
      };
    }),
  };
}
