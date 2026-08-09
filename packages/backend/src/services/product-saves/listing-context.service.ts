/**
 * What a listing page needs to render `Save product` and `Save this listing` as
 * two DIFFERENT controls (#80 listing rules, UI requirement).
 *
 * ## One narrow read rather than a widened `Listing`
 *
 * The listing DTO deliberately carries no canonical product id: it is the
 * catalogue's own projection, served on paths #57/#60's canonical read levers
 * do not gate, and adding a canonical id to it would put a graph concern into
 * every consumer of a listing — search, cart, orders, the seller dashboard.
 * This read answers exactly the two questions the two buttons ask and nothing
 * else.
 *
 * ## An unmatched listing gets ONE button, and that is the honest outcome
 *
 * `canonicalProductId` is absent when the listing has no ACTIVE, CONFIDENT
 * canonical attachment — an unmatched P2P item, a handmade piece, anything #58
 * has not resolved. The page then shows `Save this listing` alone, which is
 * #80 listing rules 1 and 2 rendered rather than described, and #80 acceptance
 * 3 holding on the surface a buyer actually touches.
 */

import type { ListingSaveContext } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findFavorite } from '../../db/buyers/favoriteRepository.js';
import { findListingCanonicalMappings } from '../../db/productSaves/listingMappingRepository.js';
import { findProductSave } from '../../db/productSaves/productSaveRepository.js';
import { listingExists } from '../../db/catalog/listingRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { CONFIDENT_LINK_METHODS } from './mapping-version.js';

/**
 * Resolve one listing's save context for one buyer.
 *
 * The confidence rule is the migration's, deliberately: the button a buyer sees
 * and the save a migration would create must agree about which product this
 * listing is, or a buyer who taps `Save product` gets a different answer from
 * the one the migration reached for the same listing — with nothing anywhere
 * saying the two disagreed.
 */
export async function readListingSaveContext(
  oxyUserId: string,
  listingId: string,
): Promise<ListingSaveContext> {
  const db = getDb();
  if (!(await listingExists(listingId))) throw notFound('Listing not found');

  const [mappings, favorite] = await Promise.all([
    findListingCanonicalMappings([listingId], db),
    findFavorite(oxyUserId, listingId, db),
  ]);

  const confident = (mappings.get(listingId) ?? []).filter((mapping) =>
    CONFIDENT_LINK_METHODS.includes(mapping.method),
  );
  const products = new Set(confident.map((mapping) => mapping.canonicalProductId));
  // Two products means the listing is ambiguous, which is #59's queue and not a
  // choice this read may make — the same refusal the migration performs, for the
  // same reason.
  const mapping = products.size === 1 ? confident[0] : undefined;

  const save = mapping
    ? await findProductSave(oxyUserId, mapping.canonicalProductId, db)
    : undefined;

  return {
    listingId,
    ...(mapping
      ? {
          canonicalProductId: mapping.canonicalProductId,
          canonicalVariantId: mapping.canonicalVariantId,
        }
      : {}),
    productSaved: save !== undefined,
    listingSaved: favorite !== undefined,
    ...(favorite ? { listingSaveIntent: favorite.saveIntent } : {}),
  };
}
