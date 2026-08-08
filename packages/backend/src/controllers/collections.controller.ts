/**
 * Public store collections controller (THIN).
 *
 * `GET /stores/:handle/collections` lists a store's PUBLISHED collections.
 * `GET /stores/:handle/collections/:collectionHandle` returns one published
 * collection plus a paginated, hydrated page of its active products. Both resolve
 * the store by handle (404 on missing/closed, mirroring `getStoreByHandle`). All
 * business logic lives in `collection.service`; the products are hydrated via
 * `catalog-hydration.service` so they match the public read shape.
 */

import type { Request, Response } from 'express';
import type { Collection as CollectionDTO, Listing, Pagination } from '@mercaria/shared-types';
import { findStoreByHandle, type StoreRecord } from '../db/stores/storeRepository.js';
import type { CollectionRecord } from '../db/merchandising/collectionRepository.js';
import {
  listCollections,
  getCollectionByHandle,
  getProductIdsByCollection,
  listCollectionProducts,
} from '../services/collection.service.js';
import { hydrateListings, resolveMedia } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/**
 * Serialize a collection row to the `Collection` DTO.
 *
 * `productIds` is passed IN rather than read from the row: it was a field on the
 * Mongo document and is a `listing_collections` relation now, so the caller
 * batches it (see `getProductIdsByCollection`) instead of this function issuing a
 * query per collection.
 */
export function toCollectionDTO(
  collection: CollectionRecord,
  productIds: readonly string[] = [],
): CollectionDTO {
  const dto: CollectionDTO = {
    id: collection.id,
    storeId: collection.storeId,
    title: collection.title,
    handle: collection.handle,
    type: collection.type,
    productIds: [...productIds],
    sortOrder: collection.sortOrder,
    isPublished: collection.isPublished,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  };
  if (collection.description !== null) dto.description = collection.description;
  if (collection.imageFileId !== null) dto.imageFileId = collection.imageFileId;
  if (collection.rules.length > 0) {
    dto.rules = {
      appliesDisjunctively: collection.rulesAppliesDisjunctively,
      conditions: collection.rules.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
      })),
    };
  }
  if (collection.seoTitle || collection.seoDescription) {
    const seo: { title?: string; description?: string } = {};
    if (collection.seoTitle) seo.title = collection.seoTitle;
    if (collection.seoDescription) seo.description = collection.seoDescription;
    dto.seo = seo;
  }
  if (collection.publishedAt) dto.publishedAt = collection.publishedAt.toISOString();
  return dto;
}

/**
 * Serialize a collection for the PUBLIC store-collection endpoints: the shared
 * `toCollectionDTO` plus a resolved, absolute `imageUrl` derived from
 * `imageFileId` through the media chokepoint (so store-page tiles/pills render
 * without a second resolve). Admin responses use `toCollectionDTO` directly and
 * are unaffected — they keep only the raw `imageFileId`.
 */
function toPublicCollectionDTO(
  collection: CollectionRecord,
  productIds: readonly string[] = [],
): CollectionDTO {
  const dto = toCollectionDTO(collection, productIds);
  if (collection.imageFileId !== null) {
    dto.imageUrl = resolveMedia(collection.imageFileId);
  }
  return dto;
}

/** Resolve a public store by handle, else NOT_FOUND (closed stores are hidden). */
async function resolvePublicStore(handle: string): Promise<StoreRecord> {
  const store = await findStoreByHandle(handle);
  if (!store || store.status === 'closed') {
    throw notFound('Store not found');
  }
  return store;
}

/** Response shape for the public collection page. */
interface CollectionPageResponse {
  collection: CollectionDTO;
  products: Listing[];
  pagination: Pagination;
}

/** GET /stores/:handle/collections — a store's published collections. */
export async function listStorePublicCollections(req: Request, res: Response): Promise<void> {
  const handle = routeParam(req, 'handle');
  try {
    const store = await resolvePublicStore(handle);
    const storeId = store.id;
    const collections = await listCollections(storeId, { publishedOnly: true });
    const productIds = await getProductIdsByCollection(collections);
    sendSuccess(
      res,
      collections.map((c) => toPublicCollectionDTO(c, productIds.get(c.id) ?? [])),
    );
  } catch (err) {
    log.general.error({ err, handle }, 'Failed to list store collections');
    respondWithError(res, err, 'Failed to load collections');
  }
}

/** GET /stores/:handle/collections/:collectionHandle — one collection + its products. */
export async function getStorePublicCollection(req: Request, res: Response): Promise<void> {
  const handle = routeParam(req, 'handle');
  const collectionHandle = routeParam(req, 'collectionHandle');
  try {
    const store = await resolvePublicStore(handle);
    const storeId = store.id;

    const collection = await getCollectionByHandle(storeId, collectionHandle, {
      publishedOnly: true,
    });
    if (!collection) {
      throw notFound('Collection not found');
    }

    const { page, limit } = parsePagination(req.query);
    const { listings, total } = await listCollectionProducts(collection, { page, limit });
    const products = await hydrateListings(listings, { viewerId: req.user?.id });
    const productIds = await getProductIdsByCollection([collection]);

    const body: CollectionPageResponse = {
      collection: toPublicCollectionDTO(collection, productIds.get(collection.id) ?? []),
      products,
      pagination: buildPagination(page, limit, total),
    };
    sendSuccess(res, body);
  } catch (err) {
    log.general.error({ err, handle, collectionHandle }, 'Failed to load store collection');
    respondWithError(res, err, 'Failed to load collection');
  }
}
