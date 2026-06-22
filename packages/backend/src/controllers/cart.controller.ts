/**
 * Cart controller (THIN) — the buyer's basket.
 *
 * Logic lives in `cart.service`. Every response is the freshly hydrated `Cart`
 * DTO (live prices, availability, subtotal, stale flags), so the client always
 * sees current state after a mutation.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { AddCartItemInput, UpdateCartItemInput } from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { getCart, addItem, updateItem, removeItem } from '../services/cart.service.js';
import { log } from '../lib/logger.js';

/** GET /cart — the buyer's hydrated cart. */
export async function getMyCart(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const cart = await getCart(oxyUserId);
    sendSuccess(res, cart);
  } catch (err) {
    log.general.error({ err }, 'Failed to load cart');
    respondWithError(res, err, 'Failed to load your cart');
  }
}

/** POST /cart/items — add (or increment) a variant in the cart. */
export async function addCartItem(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const cart = await addItem(oxyUserId, req.body as AddCartItemInput);
    sendSuccess(res, cart, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to add cart item');
    respondWithError(res, err, 'Failed to add item to cart');
  }
}

/** PATCH /cart/items/:variantId — set the absolute quantity (0 removes). */
export async function updateCartItem(req: Request, res: Response): Promise<void> {
  const variantId = routeParam(req, 'variantId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { quantity } = req.body as UpdateCartItemInput;
    const cart = await updateItem(oxyUserId, variantId, quantity);
    sendSuccess(res, cart);
  } catch (err) {
    log.general.error({ err, variantId }, 'Failed to update cart item');
    respondWithError(res, err, 'Failed to update cart item');
  }
}

/** DELETE /cart/items/:variantId — remove a line from the cart. */
export async function deleteCartItem(req: Request, res: Response): Promise<void> {
  const variantId = routeParam(req, 'variantId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const cart = await removeItem(oxyUserId, variantId);
    sendSuccess(res, cart);
  } catch (err) {
    log.general.error({ err, variantId }, 'Failed to remove cart item');
    respondWithError(res, err, 'Failed to remove cart item');
  }
}
