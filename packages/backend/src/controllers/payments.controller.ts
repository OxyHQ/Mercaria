/**
 * The seller payments surface, for BOTH kinds of seller.
 *
 * One controller and not two, because the store and P2P routes differ in exactly
 * one thing — how the OWNER is established — and everything after that is the
 * same two handlers. ADR 0001 D9 is explicit that the two seller kinds share the
 * connected-account shape and the charge model and differ only in framing; two
 * copies of these handlers would be that framing difference asserted where it
 * does not exist, and the copy that got a fix later would be the one a seller
 * was using.
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
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { config } from '../config/index.js';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type { OnboardingLinkBody } from '../middleware/payments-schemas.js';
import type { SellerAccountOwner } from '../services/payments/provider-account.service.js';
import {
  createOnboardingLink,
  readSellerPaymentSettings,
} from '../services/payments/stripe/account.service.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeOwner(req: Request): SellerAccountOwner {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return { ownerType: 'store', ownerId: store.id };
}

/** The calling P2P seller. The caller IS the owner on this surface. */
function sellerOwner(req: Request): SellerAccountOwner {
  return { ownerType: 'user', ownerId: getRequiredOxyUserId(req) };
}

/**
 * The country a new account is created in.
 *
 * The client's choice when it made one, otherwise the first configured seller
 * country — which is the single-country case every deployment starts as, and
 * saves a picker nobody would use. An empty allow-list is a configuration error
 * and says so, rather than creating an account somewhere arbitrary.
 */
function requestedCountry(body: OnboardingLinkBody): string {
  if (body.country !== undefined) return body.country;
  const [first] = config.payments.stripe.sellerCountries;
  if (first === undefined) {
    throw validationError('STRIPE_SELLER_COUNTRIES is empty; no country can be onboarded.');
  }
  return first;
}

/** The settings payload for one owner — status plus what this deployment can do. */
async function respondWithSettings(res: Response, owner: SellerAccountOwner): Promise<void> {
  sendSuccess(res, await readSellerPaymentSettings(owner));
}

/**
 * Mint a hosted-onboarding link, creating the account if this is the first time.
 *
 * `201`, because the first call to it genuinely creates a connected account —
 * and a subsequent one converges on that account rather than creating another,
 * so the status code describes the surface rather than each call. The LINK is
 * new every time by design: Account Links are single-use and expire in minutes.
 */
async function respondWithLink(
  res: Response,
  owner: SellerAccountOwner,
  body: OnboardingLinkBody,
): Promise<void> {
  const link = await createOnboardingLink({ owner, country: requestedCountry(body) });
  sendSuccess(res, link, 201);
}

/** GET /admin/stores/:storeId/payments/account */
export async function getStorePaymentAccountHandler(req: Request, res: Response): Promise<void> {
  try {
    await respondWithSettings(res, storeOwner(req));
  } catch (err) {
    log.general.error({ err }, 'Failed to load store payment account');
    respondWithError(res, err, 'Failed to load payment account');
  }
}

/** POST /admin/stores/:storeId/payments/account/onboarding-link */
export async function createStoreOnboardingLinkHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    await respondWithLink(res, storeOwner(req), req.body as OnboardingLinkBody);
  } catch (err) {
    log.general.error({ err }, 'Failed to create store onboarding link');
    respondWithError(res, err, 'Failed to start payment onboarding');
  }
}

/** GET /seller/payments/account */
export async function getSellerPaymentAccountHandler(req: Request, res: Response): Promise<void> {
  try {
    await respondWithSettings(res, sellerOwner(req));
  } catch (err) {
    log.general.error({ err }, 'Failed to load seller payment account');
    respondWithError(res, err, 'Failed to load payment account');
  }
}

/** POST /seller/payments/account/onboarding-link */
export async function createSellerOnboardingLinkHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    await respondWithLink(res, sellerOwner(req), req.body as OnboardingLinkBody);
  } catch (err) {
    log.general.error({ err }, 'Failed to create seller onboarding link');
    respondWithError(res, err, 'Failed to start payment onboarding');
  }
}
