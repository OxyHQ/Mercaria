/**
 * Store discounts controller (THIN) — the store promotions admin path.
 *
 * Every discount operation is scoped to the loaded store (`req.store`, set by
 * `loadStore`): a member may only list/create/get/update/delete discounts on
 * their own store. All business logic + code-uniqueness handling live in
 * `discount.service`. Responses are the `Discount` DTO (`toDiscountDTO`).
 */

import type { Request, Response } from 'express';
import type { CreateDiscountInput, UpdateDiscountInput } from '@mercaria/shared-types';
import {
  listDiscounts,
  getDiscount,
  createDiscount,
  updateDiscount,
  deleteDiscount,
  toDiscountDTO,
} from '../../services/discount.service.js';
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

/** GET /admin/stores/:storeId/discounts — the store's discounts. */
export async function listStoreDiscounts(req: Request, res: Response): Promise<void> {
  try {
    const discounts = await listDiscounts(storeId(req));
    sendSuccess(res, discounts.map(toDiscountDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store discounts');
    respondWithError(res, err, 'Failed to load discounts');
  }
}

/** POST /admin/stores/:storeId/discounts — create a discount. */
export async function createStoreDiscount(req: Request, res: Response): Promise<void> {
  try {
    const discount = await createDiscount(storeId(req), req.body as CreateDiscountInput);
    sendSuccess(res, toDiscountDTO(discount), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store discount');
    respondWithError(res, err, 'Failed to create discount');
  }
}

/** GET /admin/stores/:storeId/discounts/:id — a single discount. */
export async function getStoreDiscount(req: Request, res: Response): Promise<void> {
  try {
    const discount = await getDiscount(storeId(req), routeParam(req, 'id'));
    sendSuccess(res, toDiscountDTO(discount));
  } catch (err) {
    log.general.error({ err, discountId: req.params.id }, 'Failed to load store discount');
    respondWithError(res, err, 'Failed to load discount');
  }
}

/** PATCH /admin/stores/:storeId/discounts/:id — update a discount. */
export async function patchStoreDiscount(req: Request, res: Response): Promise<void> {
  try {
    const discount = await updateDiscount(
      storeId(req),
      routeParam(req, 'id'),
      req.body as UpdateDiscountInput,
    );
    sendSuccess(res, toDiscountDTO(discount));
  } catch (err) {
    log.general.error({ err, discountId: req.params.id }, 'Failed to update store discount');
    respondWithError(res, err, 'Failed to update discount');
  }
}

/** DELETE /admin/stores/:storeId/discounts/:id — delete a discount. */
export async function deleteStoreDiscount(req: Request, res: Response): Promise<void> {
  try {
    const id = routeParam(req, 'id');
    await deleteDiscount(storeId(req), id);
    sendSuccess(res, { id, deleted: true });
  } catch (err) {
    log.general.error({ err, discountId: req.params.id }, 'Failed to delete store discount');
    respondWithError(res, err, 'Failed to delete discount');
  }
}
