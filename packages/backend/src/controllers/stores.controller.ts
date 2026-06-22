/**
 * Stores controller (THIN).
 *
 * `GET /stores/:handle` resolves a store by handle and returns its public
 * `MerchantSummary` projection together with a paginated page of its active
 * listings.
 */

import type { Request, Response } from 'express';
import type { MerchantSummary, Listing, Pagination } from '@mercaria/shared-types';
import { Store, type IStore } from '../models/store.js';
import { Listing as ListingModel, type IListing } from '../models/listing.js';
import { hydrateListings, toMerchantSummary } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/** Response shape for the public store page. */
interface StorePageResponse {
  store: MerchantSummary;
  listings: Listing[];
  pagination: Pagination;
}

/** GET /stores/:handle — public store page (merchant summary + active listings). */
export async function getStoreByHandle(req: Request, res: Response): Promise<void> {
  const handle = req.params.handle;
  try {
    const store = await Store.findOne({ handle }).lean<IStore | null>();
    if (!store || store.status === 'closed') {
      sendError(res, ErrorCodes.NOT_FOUND, 'Store not found', 404);
      return;
    }

    const storeId = String((store as { _id: unknown })._id);
    const { page, limit } = parsePagination(req.query);
    const filter = { ownerType: 'store' as const, storeId, status: 'active' as const };

    const [listingDocs, total] = await Promise.all([
      ListingModel.find(filter)
        .sort({ publishedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<IListing[]>(),
      ListingModel.countDocuments(filter),
    ]);

    const listings = await hydrateListings(listingDocs, { viewerId: req.user?.id });

    const body: StorePageResponse = {
      store: toMerchantSummary(store, listingDocs),
      listings,
      pagination: buildPagination(page, limit, total),
    };
    sendSuccess(res, body);
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to load store');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to load store', 500);
  }
}
