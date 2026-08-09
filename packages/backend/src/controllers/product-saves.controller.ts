/**
 * Product-save controllers (THIN) — the buyer's surface (#80).
 *
 * Every decision lives in `services/product-saves/`. What is here is the
 * request→service→envelope wiring and the one thing a controller must own: the
 * caller's identity, taken from the verified credential with
 * `getRequiredOxyUserId` and never from a body field. #80 stores saves under an
 * Oxy account id, so a request able to name a different one would be an IDOR
 * over other people's saved lists.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  ConditionGroup,
  ProductSaveSourceContext,
  ProductSaveSplitResolution,
} from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import {
  countSavesAwaitingResolution,
  getProductSave,
  saveProduct,
  unsaveProduct,
  updateSavePreferences,
} from '../services/product-saves/product-save.service.js';
import { listSavedItems } from '../services/product-saves/saved-items.service.js';
import { readListingSaveContext } from '../services/product-saves/listing-context.service.js';
import { resolveSplitAmbiguity } from '../services/product-saves/split-resolution.service.js';

interface SaveProductBody {
  canonicalProductId: string;
  sourceContext: ProductSaveSourceContext;
  preferredCanonicalVariantId?: string;
  preferredConditionGroup?: ConditionGroup;
  preferredMerchantId?: string;
}

/** POST /product-saves — save a canonical product (idempotent). */
export async function saveProductHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as SaveProductBody;
    const save = await saveProduct({ oxyUserId, ...body });
    sendSuccess(res, { save });
  } catch (err) {
    log.general.error({ err }, 'Failed to save product');
    respondWithError(res, err, 'Failed to save that product');
  }
}

/** DELETE /product-saves/:canonicalProductId — un-save (idempotent). */
export async function unsaveProductHandler(req: Request, res: Response): Promise<void> {
  const canonicalProductId = routeParam(req, 'canonicalProductId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, await unsaveProduct(oxyUserId, canonicalProductId));
  } catch (err) {
    log.general.error({ err, canonicalProductId }, 'Failed to remove a product save');
    respondWithError(res, err, 'Failed to remove that saved product');
  }
}

/** GET /product-saves/:canonicalProductId — is it saved, and how? */
export async function getProductSaveHandler(req: Request, res: Response): Promise<void> {
  const canonicalProductId = routeParam(req, 'canonicalProductId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const save = await getProductSave(oxyUserId, canonicalProductId);
    sendSuccess(res, { saved: save !== undefined, ...(save ? { save } : {}) });
  } catch (err) {
    log.general.error({ err, canonicalProductId }, 'Failed to read a product save');
    respondWithError(res, err, 'Failed to read that saved product');
  }
}

/** PATCH /product-saves/:canonicalProductId — change the preferences (#80 API rule 5). */
export async function updateProductSaveHandler(req: Request, res: Response): Promise<void> {
  const canonicalProductId = routeParam(req, 'canonicalProductId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const save = await updateSavePreferences(
      oxyUserId,
      canonicalProductId,
      req.body as {
        preferredCanonicalVariantId?: string | null;
        preferredConditionGroup?: ConditionGroup | null;
        preferredMerchantId?: string | null;
      },
    );
    sendSuccess(res, { save });
  } catch (err) {
    log.general.error({ err, canonicalProductId }, 'Failed to update a product save');
    respondWithError(res, err, 'Failed to update that saved product');
  }
}

/** POST /product-saves/:saveId/resolve-split — answer a split ambiguity. */
export async function resolveSplitHandler(req: Request, res: Response): Promise<void> {
  const saveId = routeParam(req, 'saveId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { resolution } = req.body as { resolution: ProductSaveSplitResolution };
    sendSuccess(res, await resolveSplitAmbiguity({ oxyUserId, saveId, resolution }));
  } catch (err) {
    log.general.error({ err, saveId }, 'Failed to resolve a split ambiguity');
    respondWithError(res, err, 'Failed to resolve that saved product');
  }
}

/** GET /product-saves/pending — how many saves are waiting on this buyer. */
export async function pendingResolutionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, { awaitingResolution: await countSavesAwaitingResolution(oxyUserId) });
  } catch (err) {
    log.general.error({ err }, 'Failed to count saves awaiting resolution');
    respondWithError(res, err, 'Failed to read your saved products');
  }
}

/** GET /product-saves/listings/:listingId — the two-button context (#80 listing rules). */
export async function listingSaveContextHandler(req: Request, res: Response): Promise<void> {
  const listingId = routeParam(req, 'listingId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, await readListingSaveContext(oxyUserId, listingId));
  } catch (err) {
    log.general.error({ err, listingId }, 'Failed to read a listing save context');
    respondWithError(res, err, 'Failed to read that listing');
  }
}

/** GET /saved-items — the merged saved list (#80 API rules 3, 4 and 7). */
export async function savedItemsHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { limit, cursor } = req.query as unknown as { limit: number; cursor?: string };
    sendSuccess(
      res,
      await listSavedItems({ oxyUserId, limit, ...(cursor ? { cursor } : {}) }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to list saved items');
    respondWithError(res, err, 'Failed to load your saved items');
  }
}
