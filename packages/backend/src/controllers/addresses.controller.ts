/**
 * Addresses controller (THIN) — the buyer's saved shipping addresses.
 *
 * Logic (including the single-default invariant) lives in `address.service`.
 * Every operation is scoped to the authenticated buyer's Oxy user id.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CreateAddressInput, UpdateAddressInput } from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { list, create, update, remove } from '../services/address.service.js';
import { log } from '../lib/logger.js';

/** GET /addresses — the buyer's addresses (default first, then newest). */
export async function listMyAddresses(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const addresses = await list(oxyUserId);
    sendSuccess(res, addresses);
  } catch (err) {
    log.general.error({ err }, 'Failed to list addresses');
    respondWithError(res, err, 'Failed to load your addresses');
  }
}

/** POST /addresses — create a new address (the first becomes the default). */
export async function createMyAddress(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const address = await create(oxyUserId, req.body as CreateAddressInput);
    sendSuccess(res, address, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to create address');
    respondWithError(res, err, 'Failed to create address');
  }
}

/** PATCH /addresses/:id — update an address (promote to default if requested). */
export async function updateMyAddress(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const address = await update(oxyUserId, id, req.body as UpdateAddressInput);
    sendSuccess(res, address);
  } catch (err) {
    log.general.error({ err, addressId: id }, 'Failed to update address');
    respondWithError(res, err, 'Failed to update address');
  }
}

/** DELETE /addresses/:id — remove an address. */
export async function deleteMyAddress(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await remove(oxyUserId, id);
    sendSuccess(res, { id });
  } catch (err) {
    log.general.error({ err, addressId: id }, 'Failed to delete address');
    respondWithError(res, err, 'Failed to delete address');
  }
}
