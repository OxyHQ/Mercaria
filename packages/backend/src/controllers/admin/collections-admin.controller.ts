/**
 * Store collections controller (THIN) — the store merchandising admin path.
 *
 * Every collection operation is scoped to the loaded store (`req.store`, set by
 * `loadStore`): a member may only list/create/get/update/delete collections and set
 * their products on their own store. All business logic + membership materialization
 * live in `collection.service`. Responses are the `Collection` DTO (serialized by the
 * shared `toCollectionDTO`).
 */

import type { Request, Response } from 'express';
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
  SetCollectionProductsInput,
} from '@mercaria/shared-types';
import {
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  setCollectionProducts,
} from '../../services/collection.service.js';
import { Collection, type ICollection } from '../../models/collection.js';
import { toCollectionDTO } from '../collections.controller.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return String((store as { _id: unknown })._id);
}

/** Load a collection scoped to the loaded store, else NOT_FOUND. */
async function loadStoreCollection(req: Request): Promise<ICollection> {
  const collection = await Collection.findOne({
    _id: routeParam(req, 'id'),
    storeId: storeId(req),
  }).lean<ICollection | null>();
  if (!collection) {
    throw notFound('Collection not found');
  }
  return collection;
}

/** GET /admin/stores/:storeId/collections — the store's collections. */
export async function listStoreCollections(req: Request, res: Response): Promise<void> {
  try {
    const collections = await listCollections(storeId(req));
    sendSuccess(res, collections.map(toCollectionDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store collections');
    respondWithError(res, err, 'Failed to load collections');
  }
}

/** POST /admin/stores/:storeId/collections — create a collection. */
export async function createStoreCollection(req: Request, res: Response): Promise<void> {
  try {
    const collection = await createCollection(storeId(req), req.body as CreateCollectionInput);
    sendSuccess(res, toCollectionDTO(collection), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store collection');
    respondWithError(res, err, 'Failed to create collection');
  }
}

/** GET /admin/stores/:storeId/collections/:id — a single collection. */
export async function getStoreCollection(req: Request, res: Response): Promise<void> {
  try {
    const collection = await loadStoreCollection(req);
    sendSuccess(res, toCollectionDTO(collection));
  } catch (err) {
    log.general.error({ err, collectionId: req.params.id }, 'Failed to load store collection');
    respondWithError(res, err, 'Failed to load collection');
  }
}

/** PATCH /admin/stores/:storeId/collections/:id — update a collection. */
export async function patchStoreCollection(req: Request, res: Response): Promise<void> {
  try {
    const collection = await updateCollection(
      storeId(req),
      routeParam(req, 'id'),
      req.body as UpdateCollectionInput,
    );
    sendSuccess(res, toCollectionDTO(collection));
  } catch (err) {
    log.general.error({ err, collectionId: req.params.id }, 'Failed to update store collection');
    respondWithError(res, err, 'Failed to update collection');
  }
}

/** DELETE /admin/stores/:storeId/collections/:id — delete a collection. */
export async function deleteStoreCollection(req: Request, res: Response): Promise<void> {
  try {
    const id = routeParam(req, 'id');
    await deleteCollection(storeId(req), id);
    sendSuccess(res, { id, deleted: true });
  } catch (err) {
    log.general.error({ err, collectionId: req.params.id }, 'Failed to delete store collection');
    respondWithError(res, err, 'Failed to delete collection');
  }
}

/** POST /admin/stores/:storeId/collections/:id/products — set manual products. */
export async function setStoreCollectionProducts(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as SetCollectionProductsInput;
    const collection = await setCollectionProducts(
      storeId(req),
      routeParam(req, 'id'),
      body.productIds,
    );
    sendSuccess(res, toCollectionDTO(collection));
  } catch (err) {
    log.general.error({ err, collectionId: req.params.id }, 'Failed to set collection products');
    respondWithError(res, err, 'Failed to set collection products');
  }
}
