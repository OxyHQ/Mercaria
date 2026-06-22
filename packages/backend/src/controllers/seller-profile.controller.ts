/**
 * Seller-profile controller (THIN).
 *
 * `GET /seller/me` returns the caller's P2P seller profile (created lazily);
 * `PATCH /seller/me` updates their shipping/return preferences. All logic lives
 * in `seller-profile.service`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { ISellerProfile } from '../models/seller-profile.js';
import { getMine, updatePrefs, type SellerPrefsInput } from '../services/seller-profile.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Serialize a seller profile document to the wire (omits Mongo internals). */
function toSellerProfileResponse(profile: ISellerProfile): Record<string, unknown> {
  return {
    id: String((profile as { _id: unknown })._id),
    oxyUserId: profile.oxyUserId,
    isVerified: profile.isVerified,
    rating: profile.rating,
    reviewCount: profile.reviewCount,
    salesCount: profile.salesCount,
    ...(profile.shippingPrefs ? { shippingPrefs: profile.shippingPrefs } : {}),
    ...(profile.returnPrefs ? { returnPrefs: profile.returnPrefs } : {}),
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

/** GET /seller/me — the caller's seller profile (created lazily). */
export async function getMyProfile(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const profile = await getMine(oxyUserId);
    sendSuccess(res, toSellerProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to load seller profile');
    respondWithError(res, err, 'Failed to load seller profile');
  }
}

/** PATCH /seller/me — update the caller's shipping/return preferences. */
export async function updateMyProfile(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const profile = await updatePrefs(oxyUserId, req.body as SellerPrefsInput);
    sendSuccess(res, toSellerProfileResponse(profile));
  } catch (err) {
    log.general.error({ err }, 'Failed to update seller profile');
    respondWithError(res, err, 'Failed to update seller profile');
  }
}
