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
import { readCheckoutPaymentStatus } from '../services/payments/checkout-payment.service.js';
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

/**
 * GET /checkout/:checkoutGroupId/payment-status — what actually happened.
 *
 * The buyer's client asks this after its payment sheet closes, instead of
 * reporting the outcome itself. Scoped to the caller's own orders by the
 * service; a group that is not theirs is a 404, not a 403, because the existence
 * of somebody else's checkout is not a fact this endpoint may confirm.
 */
export async function getCheckoutPaymentStatus(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const raw = req.params.checkoutGroupId;
    const checkoutGroupId = Array.isArray(raw) ? raw[0] : raw;
    const result = await readCheckoutPaymentStatus(oxyUserId, checkoutGroupId);
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err }, 'Reading checkout payment status failed');
    respondWithError(res, err, 'Could not read the payment status');
  }
}
