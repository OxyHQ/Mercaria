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
import { Store, type IStore } from '../models/store.js';
import type { ICollection } from '../models/collection.js';
import {
  listCollections,
  getCollectionByHandle,
  listCollectionProducts,
} from '../services/collection.service.js';
import { hydrateListings } from '../services/catalog-hydration.service.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/** Serialize a collection document to the `Collection` DTO. */
export function toCollectionDTO(collection: ICollection): CollectionDTO {
  const dto: CollectionDTO = {
    id: String((collection as { _id: unknown })._id),
    storeId: collection.storeId,
    title: collection.title,
    handle: collection.handle,
    type: collection.type,
    productIds: [...collection.productIds],
    sortOrder: collection.sortOrder,
    isPublished: collection.isPublished,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  };
  if (collection.description !== undefined) dto.description = collection.description;
  if (collection.imageFileId !== undefined) dto.imageFileId = collection.imageFileId;
  if (collection.rules) {
    dto.rules = {
      appliesDisjunctively: collection.rules.appliesDisjunctively,
      conditions: collection.rules.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
      })),
    };
  }
  if (collection.seo && (collection.seo.title || collection.seo.description)) {
    const seo: { title?: string; description?: string } = {};
    if (collection.seo.title) seo.title = collection.seo.title;
    if (collection.seo.description) seo.description = collection.seo.description;
    dto.seo = seo;
  }
  if (collection.publishedAt) dto.publishedAt = collection.publishedAt.toISOString();
  return dto;
}

/** Resolve a public store by handle, else NOT_FOUND (closed stores are hidden). */
async function resolvePublicStore(handle: string): Promise<IStore> {
  const store = await Store.findOne({ handle }).lean<IStore | null>();
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
    const storeId = String((store as { _id: unknown })._id);
    const collections = await listCollections(storeId, { publishedOnly: true });
    sendSuccess(res, collections.map(toCollectionDTO));
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
    const storeId = String((store as { _id: unknown })._id);

    const collection = await getCollectionByHandle(storeId, collectionHandle, {
      publishedOnly: true,
    });
    if (!collection) {
      throw notFound('Collection not found');
    }

    const { page, limit } = parsePagination(req.query);
    const { listings, total } = await listCollectionProducts(collection, { page, limit });
    const products = await hydrateListings(listings, { viewerId: req.user?.id });

    const body: CollectionPageResponse = {
      collection: toCollectionDTO(collection),
      products,
      pagination: buildPagination(page, limit, total),
    };
    sendSuccess(res, body);
  } catch (err) {
    log.general.error({ err, handle, collectionHandle }, 'Failed to load store collection');
    respondWithError(res, err, 'Failed to load collection');
  }
}
