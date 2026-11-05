/**
 * Stores controller (THIN).
 *
 * `GET /stores/:handle` resolves a store by handle and returns its public
 * `StoreSummary` projection together with a paginated page of its active
 * listings.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { isLiveEntityId } from '@oxy.so/db';
import {
  MAX_LISTINGS_BY_ID,
  type StoreSummary,
  type Listing,
  type Pagination,
} from '@mercaria/shared-types';
import { findStoreByHandle } from '../db/stores/storeRepository.js';
import {
  findActiveStoreListingsPage,
  findListingChildren,
  findListingsByIds,
} from '../db/catalog/listingRepository.js';
import { hydrateListings, toStoreSummary } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { resolveStoreRatingSource } from '../services/reviews/review-aggregate.service.js';
import { log } from '../lib/logger.js';

/** Response shape for the public store page. */
interface StorePageResponse {
  store: StoreSummary;
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
    // per-listing lookup inside `toStoreSummary`.
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
    const summary = toStoreSummary(store, rows, images, { includePolicies: true });

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

/** `?ids=a,b,c` — deduplicated, bounded, each a real id shape. */
const listingIdsQuerySchema = z.object({
  ids: z
    .string()
    .transform((raw) => [
      ...new Set(
        raw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.string().refine(isLiveEntityId)).min(1).max(MAX_LISTINGS_BY_ID)),
});

/**
 * GET /stores/:handle/listings?ids=a,b,c — this store's ACTIVE listings named by
 * id, hydrated, in the order the caller named them.
 *
 * It decides NO order of its own: the caller already has one. Ids that are not
 * an active listing of this store are dropped rather than refused, so a stale id
 * (a listing archived a moment ago) costs one card, never the page — and the set
 * is never wider than the store page's own grid (`status = 'active'`, this
 * `store_id`), so the read cannot surface anything the grid would not.
 */
export async function getStoreListingsByIds(req: Request, res: Response): Promise<void> {
  const handle = routeParam(req, 'handle');
  try {
    const parsed = listingIdsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw validationError(`ids must list 1 to ${MAX_LISTINGS_BY_ID} listing ids`);
    }
    const store = await findStoreByHandle(handle);
    if (!store || store.status === 'closed') {
      throw notFound('Store not found');
    }
    const rows = (await findListingsByIds(parsed.data.ids)).filter(
      (row) => row.storeId === store.id && row.status === 'active',
    );
    const listings = await hydrateListings(rows, { viewerId: req.user?.id });
    sendSuccess(res, { listings });
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to load store listings by id');
    respondWithError(res, err, 'Failed to load listings');
  }
}
