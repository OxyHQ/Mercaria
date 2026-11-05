/**
 * The store page's merchandising read (#89, `advanced_merchandising_rules`).
 *
 * PUBLIC, and read by ONE client: the store's own storefront page. It answers
 * which ordering and spotlights apply right now and the merchandised ids of one
 * grid page; the page hydrates them through the free
 * `GET /stores/:handle/listings?ids=`.
 *
 * Deliberately imports NO ordering engine — not `listingRepository`, not
 * `catalog-hydration`, nothing under `services/ranking|search` — so it is not
 * part of the derived ranking surface (`__tests__/ranking-surface.ts`), and the
 * ranking surface does not import it. Plan data reaches this store's own page
 * and nothing that orders across stores. `docs/merchandising-rules.md`.
 */

import type { Request, Response } from 'express';
import { findStoreByHandle, type StoreRow } from '../db/stores/storeRepository.js';
import {
  readMerchandisedPage,
  readStorefrontMerchandising,
} from '../services/merchandising/storefront-merchandising.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/** The grid's default page size, matching the store page's own. */
const DEFAULT_PAGE_LIMIT = 24;

/** The store as the public page resolves it: absent and closed stores are 404. */
async function resolvePublicStore(handle: string): Promise<StoreRow> {
  const store = await findStoreByHandle(handle);
  if (!store || store.status === 'closed') throw notFound('Store not found');
  return store;
}

/** GET /stores/:handle/merchandising */
export async function getStorefrontMerchandising(req: Request, res: Response): Promise<void> {
  const handle = routeParam(req, 'handle');
  try {
    const store = await resolvePublicStore(handle);
    sendSuccess(res, await readStorefrontMerchandising(store.id));
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to load store merchandising');
    respondWithError(res, err, 'Failed to load store merchandising');
  }
}

/** GET /stores/:handle/merchandising/listings?collectionId=&page=&limit= */
export async function getStorefrontMerchandisedPage(req: Request, res: Response): Promise<void> {
  const handle = routeParam(req, 'handle');
  try {
    const store = await resolvePublicStore(handle);
    const query = req.query as { collectionId?: string; page?: number; limit?: number };
    sendSuccess(
      res,
      await readMerchandisedPage(store.id, {
        collectionId: query.collectionId ?? null,
        page: query.page ?? 1,
        limit: query.limit ?? DEFAULT_PAGE_LIMIT,
      }),
    );
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to load the merchandised page');
    respondWithError(res, err, 'Failed to load store merchandising');
  }
}
