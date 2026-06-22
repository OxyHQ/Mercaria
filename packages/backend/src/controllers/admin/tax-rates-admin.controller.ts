/**
 * Store tax controller (THIN) — the store tax-rate + tax-settings admin path.
 *
 * Every operation is scoped to the loaded store (`req.store`, set by `loadStore`):
 * a member may only list/create/update/delete tax rates and patch tax settings on
 * their own store. All business logic lives in `tax.service`. Tax-rate responses
 * are the `TaxRate` DTO (`toTaxRateDTO`); the settings patch returns the `Store`
 * DTO (`toStoreDTO`).
 */

import type { Request, Response } from 'express';
import type {
  CreateTaxRateInput,
  UpdateTaxRateInput,
  UpdateTaxSettingsInput,
} from '@mercaria/shared-types';
import {
  listTaxRates,
  createTaxRate,
  updateTaxRate,
  deleteTaxRate,
  updateTaxSettings,
  toTaxRateDTO,
} from '../../services/tax.service.js';
import { toStoreDTO } from './store-admin.controller.js';
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

/** GET /admin/stores/:storeId/tax-rates — the store's tax rates. */
export async function listStoreTaxRates(req: Request, res: Response): Promise<void> {
  try {
    const rates = await listTaxRates(storeId(req));
    sendSuccess(res, rates.map(toTaxRateDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list store tax rates');
    respondWithError(res, err, 'Failed to load tax rates');
  }
}

/** POST /admin/stores/:storeId/tax-rates — create a tax rate. */
export async function createStoreTaxRate(req: Request, res: Response): Promise<void> {
  try {
    const rate = await createTaxRate(storeId(req), req.body as CreateTaxRateInput);
    sendSuccess(res, toTaxRateDTO(rate), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store tax rate');
    respondWithError(res, err, 'Failed to create tax rate');
  }
}

/** PATCH /admin/stores/:storeId/tax-rates/:id — update a tax rate. */
export async function patchStoreTaxRate(req: Request, res: Response): Promise<void> {
  try {
    const rate = await updateTaxRate(
      storeId(req),
      routeParam(req, 'id'),
      req.body as UpdateTaxRateInput,
    );
    sendSuccess(res, toTaxRateDTO(rate));
  } catch (err) {
    log.general.error({ err, taxRateId: req.params.id }, 'Failed to update store tax rate');
    respondWithError(res, err, 'Failed to update tax rate');
  }
}

/** DELETE /admin/stores/:storeId/tax-rates/:id — delete a tax rate. */
export async function deleteStoreTaxRate(req: Request, res: Response): Promise<void> {
  try {
    const id = routeParam(req, 'id');
    await deleteTaxRate(storeId(req), id);
    sendSuccess(res, { id, deleted: true });
  } catch (err) {
    log.general.error({ err, taxRateId: req.params.id }, 'Failed to delete store tax rate');
    respondWithError(res, err, 'Failed to delete tax rate');
  }
}

/** PATCH /admin/stores/:storeId/settings/tax — patch the store's tax settings. */
export async function patchStoreTaxSettings(req: Request, res: Response): Promise<void> {
  try {
    const store = await updateTaxSettings(storeId(req), req.body as UpdateTaxSettingsInput);
    sendSuccess(res, toStoreDTO(store));
  } catch (err) {
    log.general.error({ err }, 'Failed to update store tax settings');
    respondWithError(res, err, 'Failed to update tax settings');
  }
}
