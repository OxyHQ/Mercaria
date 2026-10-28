import type { Request, Response } from 'express';
import {
  featuredCollections,
  replaceFeaturedCollections,
} from '../../db/merchandising/featuredCollectionRepository.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
export async function getFeaturedCollections(req: Request, res: Response) {
  try {
    if (!req.store) throw notFound('Store not found');
    sendSuccess(res, {
      collectionIds: (await featuredCollections(req.store.id, false)).map((row) => row.id),
    });
  } catch (error) {
    respondWithError(res, error, 'Unable to update featured collections');
  }
}
export async function setFeaturedCollections(req: Request, res: Response) {
  try {
    if (!req.store) throw notFound('Store not found');
    await replaceFeaturedCollections(req.store.id, req.store.oxyAccountId, req.body.collectionIds);
    sendSuccess(res, { collectionIds: req.body.collectionIds });
  } catch (error) {
    respondWithError(res, error, 'Unable to update featured collections');
  }
}
