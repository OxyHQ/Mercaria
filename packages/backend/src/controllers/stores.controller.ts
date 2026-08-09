/**
 * Stores controller (THIN).
 *
 * `GET /stores/:handle` resolves a store by handle and returns its public
 * `MerchantSummary` projection together with a paginated page of its active
 * listings.
 */

import type { Request, Response } from 'express';
import type { MerchantSummary, Listing, Pagination } from '@mercaria/shared-types';
import { findStoreByHandle } from '../db/stores/storeRepository.js';
import {
  findActiveStoreListingsPage,
  findListingChildren,
} from '../db/catalog/listingRepository.js';
import { hydrateListings, toMerchantSummary } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { resolveStoreRatingSource } from '../services/reviews/review-aggregate.service.js';
import { log } from '../lib/logger.js';

/** Response shape for the public store page. */
interface StorePageResponse {
  store: MerchantSummary;
  listings: Listing[];
  pagination: Pagination;
}

/** GET /stores/:handle — public store page (merchant summary + active listings). */
export async function getStoreByHandle(req: Request, res: Response): Promise<void> {
  // `routeParam` rather than `req.params.handle`: Express types a param as
  // `string | string[]`, and the repository takes a single handle.
  const handle = routeParam(req, 'handle');
  try {
    const store = await findStoreByHandle(handle);
    if (!store || store.status === 'closed') {
      throw notFound('Store not found');
    }

    const storeId = store.id;
    const { page, limit } = parsePagination(req.query);

    const { rows, total } = await findActiveStoreListingsPage(storeId, page, limit);

    // The merchant card's thumbnails come from this page's own galleries, which
    // hydration is about to load anyway — one extra batched read rather than a
    // per-listing lookup inside `toMerchantSummary`.
    const { images } = await findListingChildren(rows.map((row) => row.id));
    const listings = await hydrateListings(rows, { viewerId: req.user?.id });

    /**
     * Where this store's public rating comes from (#76 migration rule 6).
     *
     * ONE call, one value: the merchant aggregate when the store resolves to a
     * canonical merchant, its own legacy aggregate otherwise. Never both, and
     * never a sum — which is what makes "merchant and native-store linkage must
     * not double-count one review in two public aggregates" a property of the
     * code rather than a rule somebody has to remember.
     */
    const ratingSource = await resolveStoreRatingSource(storeId);
    const summary = toMerchantSummary(store, rows, images);

    const body: StorePageResponse = {
      store: ratingSource
        ? {
            ...summary,
            // The rating SHOWN is the one the source names — not the store row's
            // own figures, which are the legacy projection and are stale for a
            // linked store by construction.
            rating: ratingSource.rating,
            reviewCount: ratingSource.reviewCount,
            ratingSource,
          }
        : summary,
      listings,
      pagination: buildPagination(page, limit, total),
    };
    sendSuccess(res, body);
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to load store');
    respondWithError(res, err, 'Failed to load store');
  }
}
