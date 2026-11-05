/**
 * The seller payments surface, for BOTH kinds of seller.
 *
 * One controller and not two, because the store and P2P routes differ in exactly
 * one thing — how the OWNER is established — and everything after that is the
 * same handlers. ADR 0001 D9 is explicit that the two seller kinds share the
 * connected-account shape and the charge model and differ only in framing.
 *
 * The owner is resolved by the ROUTE, never from the body:
 *
 *  - a store's is `req.store`, which `loadStore` put there after checking the
 *    caller is a member, and `requireStorePermission('store:manage')` after that;
 *  - a P2P seller's is `getRequiredOxyUserId(req)` — the caller IS the seller,
 *    which is the whole of the ownership check for that surface.
 *
 * Neither reads an identifier a client could choose, which is what closes the
 * "one Mercaria owner attaches another owner's connected account" hole (#46,
 * security 3) at the route rather than at the service.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type { OnboardingLinkBody } from '../middleware/payments-schemas.js';
import type { SellerAccountOwner } from '../services/payments/provider-account.service.js';
import {
  createSellerOnboardingLink,
  readSellerPaymentSettings,
  refreshSellerAccount,
} from '../services/payments/peable/accounts.js';

/** How a route establishes the owner it acts for. */
type OwnerOf = (req: Request) => SellerAccountOwner;

/** The loaded store (guaranteed by `loadStore`). */
const storeOwner: OwnerOf = (req) => {
  const store = req.store;
  if (!store) throw notFound('Store not loaded');
  return { ownerType: 'store', ownerId: store.id };
};

/** The calling P2P seller. The caller IS the owner on this surface. */
const sellerOwner: OwnerOf = (req) => ({ ownerType: 'user', ownerId: getRequiredOxyUserId(req) });

function settingsHandler(ownerOf: OwnerOf) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      sendSuccess(res, await readSellerPaymentSettings(ownerOf(req)));
    } catch (err) {
      log.general.error({ err }, 'Failed to load payment account');
      respondWithError(res, err, 'Failed to load payment account');
    }
  };
}

/**
 * Mint a hosted-onboarding link, opening the account if this is the first time.
 *
 * `201`, because the first call genuinely creates a connected account — and a
 * later one converges on that account rather than creating another, so the
 * status describes the surface rather than each call. The LINK is new every
 * time by design: account links are single-use and expire in minutes.
 */
function onboardingLinkHandler(ownerOf: OwnerOf) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as OnboardingLinkBody;
      const link = await createSellerOnboardingLink({
        owner: ownerOf(req),
        ...(body.country === undefined ? {} : { country: body.country }),
      });
      sendSuccess(res, link, 201);
    } catch (err) {
      log.general.error({ err }, 'Failed to create payment onboarding link');
      respondWithError(res, err, 'Failed to start payment onboarding');
    }
  };
}

/** Re-read the account from the gateway now — the seller is back from the hosted flow. */
function refreshHandler(ownerOf: OwnerOf) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      sendSuccess(res, await refreshSellerAccount(ownerOf(req)));
    } catch (err) {
      log.general.error({ err }, 'Failed to refresh payment account');
      respondWithError(res, err, 'Failed to refresh payment account');
    }
  };
}

/** GET /admin/stores/:storeId/payments/account */
export const getStorePaymentAccountHandler = settingsHandler(storeOwner);
/** POST /admin/stores/:storeId/payments/account/onboarding-link */
export const createStoreOnboardingLinkHandler = onboardingLinkHandler(storeOwner);
/** POST /admin/stores/:storeId/payments/account/refresh */
export const refreshStorePaymentAccountHandler = refreshHandler(storeOwner);
/** GET /seller/payments/account */
export const getSellerPaymentAccountHandler = settingsHandler(sellerOwner);
/** POST /seller/payments/account/onboarding-link */
export const createSellerOnboardingLinkHandler = onboardingLinkHandler(sellerOwner);
/** POST /seller/payments/account/refresh */
export const refreshSellerPaymentAccountHandler = refreshHandler(sellerOwner);
