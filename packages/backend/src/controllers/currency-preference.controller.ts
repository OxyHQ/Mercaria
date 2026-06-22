/**
 * Currency-preference controller (THIN).
 *
 * `GET /me/currency-preference` returns the caller's dual-currency DISPLAY
 * preference (created lazily); `PUT /me/currency-preference` patches it. These
 * are presentation-only — they never affect the amounts Mercaria stores (every
 * price stays canonical FAIR). All logic lives in `user-preference.service`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { UpdateCurrencyPreferenceInput } from '@mercaria/shared-types';
import { getOrCreate, update } from '../services/user-preference.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** GET /me/currency-preference — the caller's dual-display preference (lazy). */
export async function getCurrencyPreference(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const preference = await getOrCreate(oxyUserId);
    sendSuccess(res, preference);
  } catch (err) {
    log.general.error({ err }, 'Failed to load currency preference');
    respondWithError(res, err, 'Failed to load currency preference');
  }
}

/** PUT /me/currency-preference — patch the caller's dual-display preference. */
export async function updateCurrencyPreference(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const preference = await update(oxyUserId, req.body as UpdateCurrencyPreferenceInput);
    sendSuccess(res, preference);
  } catch (err) {
    log.general.error({ err }, 'Failed to update currency preference');
    respondWithError(res, err, 'Failed to update currency preference');
  }
}
