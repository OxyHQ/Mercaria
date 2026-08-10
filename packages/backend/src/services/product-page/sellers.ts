/**
 * Who is selling each offer, resolved once for a whole page (#71 offer row 1,
 * relationships 6).
 *
 * ## Two identity systems, and they are not interchangeable
 *
 * An EXTERNAL offer names a canonical merchant and the storefront it is
 * published on — both #55/#56 entities with public Mercaria pages. A NATIVE
 * offer names neither: it projects a listing, whose owner is a Mercaria store
 * or a person with an Oxy account (#92). The two are resolved by different
 * queries against different tables and are returned as different members of a
 * union with no common `id` field, so a person's Oxy id can never be rendered
 * into a merchant route by a template that reached for `seller.id`.
 *
 * `unknown` is a real answer and is what an unresolvable seller produces. A
 * deleted store, a merchant id this read could not resolve, a listing that has
 * gone: each names nobody rather than naming somebody wrong.
 *
 * ## The Oxy read is the one call that can fail, and it fails OPEN
 *
 * `getProfiles` batches (`POST /users/by-ids`) and a person whose profile does
 * not come back is a `native_person` with the handle-fallback display name
 * `toOxyProfile` already applies — never a missing row and never a page-wide
 * failure. A comparison that 500s because an identity service was slow is a
 * worse product than one that shows a seller by their account handle.
 */

import type { Offer, ProductPageSeller } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findProductPageListingSellers,
  findProductPageMerchants,
} from '../../db/productPage/productPageRepository.js';
import { findStorefrontsByIds } from '../../db/commerce-graph/storefrontRepository.js';
import { getProfiles } from '../oxy-user.service.js';

/**
 * Resolve every served offer's seller, in a fixed number of round trips.
 *
 * Returns a map keyed by OFFER id rather than by merchant or listing id: two
 * offers from one merchant on two channels are two different rows with two
 * different storefronts, and a map keyed on the seller would have to be joined
 * again by the caller — which is the join this whole domain exists to do once.
 */
export async function resolveOfferSellers(
  offers: readonly Offer[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlyMap<string, ProductPageSeller>> {
  const merchantIds = [
    ...new Set(offers.map((offer) => offer.merchantId).filter((id): id is string => !!id)),
  ];
  const storefrontIds = [
    ...new Set(offers.map((offer) => offer.storefrontId).filter((id): id is string => !!id)),
  ];
  const listingIds = [
    ...new Set(offers.map((offer) => offer.listingId).filter((id): id is string => !!id)),
  ];

  const [merchantRows, storefrontRows, listingRows] = await Promise.all([
    findProductPageMerchants(db, merchantIds),
    findStorefrontsByIds(db, storefrontIds),
    findProductPageListingSellers(db, listingIds),
  ]);

  const merchantsById = new Map(merchantRows.map((row) => [row.id, row]));
  const storefrontsById = new Map(storefrontRows.map((row) => [row.id, row]));
  const listingsById = new Map(listingRows.map((row) => [row.listingId, row]));

  // The people, in one Oxy call for the whole page.
  const personIds = [
    ...new Set(
      listingRows
        .filter((row) => row.ownerType === 'user')
        .map((row) => row.oxyUserId)
        .filter((id): id is string => !!id),
    ),
  ];
  const profiles = await getProfiles(personIds);

  const sellers = new Map<string, ProductPageSeller>();
  for (const offer of offers) {
    sellers.set(offer.id, resolveOne(offer, { merchantsById, storefrontsById, listingsById, profiles }));
  }
  return sellers;
}

interface ResolutionContext {
  readonly merchantsById: ReadonlyMap<string, { id: string; name: string; slug: string }>;
  readonly storefrontsById: ReadonlyMap<
    string,
    { id: string; name: string; slug: string; domain: string | null }
  >;
  readonly listingsById: ReadonlyMap<
    string,
    {
      listingId: string;
      ownerType: string;
      oxyUserId: string | null;
      storeId: string | null;
      storeName: string | null;
      storeHandle: string | null;
    }
  >;
  readonly profiles: ReadonlyMap<string, { displayName: string }>;
}

/** One offer's seller. Pure over the maps, so the branching is testable alone. */
function resolveOne(offer: Offer, context: ResolutionContext): ProductPageSeller {
  if (offer.merchantId) {
    const merchant = context.merchantsById.get(offer.merchantId);
    if (merchant === undefined) return { kind: 'unknown' };
    const storefront = offer.storefrontId
      ? context.storefrontsById.get(offer.storefrontId)
      : undefined;
    return {
      kind: 'merchant',
      merchantId: merchant.id,
      name: merchant.name,
      slug: merchant.slug,
      ...(storefront === undefined
        ? {}
        : {
            storefront: {
              id: storefront.id,
              name: storefront.name,
              slug: storefront.slug,
              ...(storefront.domain === null ? {} : { domain: storefront.domain }),
            },
          }),
      // Carried from the offer's own DERIVED role (ADR 0002 D8) rather than
      // recomputed here: comparing the two merchant ids in a second place is a
      // second answer to "is this a marketplace offer", and the pair can only
      // disagree in the direction that mislabels who a buyer's warranty is with.
      marketplaceSeller: offer.sellerRole === 'marketplace',
    };
  }

  if (offer.listingId) {
    const listing = context.listingsById.get(offer.listingId);
    if (listing === undefined) return { kind: 'unknown' };
    // `owner_type` is read explicitly rather than inferred from which id is
    // populated — the #92 rule: a store's stock must never read as a person's
    // inventory, and this is the read where a widened exclusivity CHECK would
    // otherwise disclose it.
    if (listing.ownerType === 'store' && listing.storeId && listing.storeName && listing.storeHandle) {
      return {
        kind: 'native_store',
        storeId: listing.storeId,
        name: listing.storeName,
        handle: listing.storeHandle,
      };
    }
    if (listing.ownerType === 'user' && listing.oxyUserId) {
      const profile = context.profiles.get(listing.oxyUserId);
      return {
        kind: 'native_person',
        oxyUserId: listing.oxyUserId,
        // The sanctioned coalesce already applied by `toOxyProfile`; an
        // unresolved profile leaves the account id as the only thing anybody
        // can be shown, which is honest and still links to the seller page.
        displayName: profile?.displayName ?? listing.oxyUserId,
      };
    }
    return { kind: 'unknown' };
  }

  return { kind: 'unknown' };
}
