/**
 * Checkout controller (THIN) — place orders from the buyer's cart.
 *
 * Logic lives in `checkout.service`. The optional `Idempotency-Key` request
 * header makes a replayed checkout converge on the original orders instead of
 * creating duplicates.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { CheckoutInput } from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { checkout } from '../services/checkout.service.js';
import { log } from '../lib/logger.js';

/** POST /checkout — create orders from the caller's cart. */
export async function postCheckout(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const raw = req.headers['idempotency-key'];
    const idempotencyKey = (Array.isArray(raw) ? raw[0] : raw) || undefined;
    const result = await checkout(oxyUserId, req.body as CheckoutInput, idempotencyKey);
    sendSuccess(res, result, 201);
  } catch (err) {
    log.general.error({ err }, 'Checkout failed');
    respondWithError(res, err, 'Checkout failed');
  }
}
