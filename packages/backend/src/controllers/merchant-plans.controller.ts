/**
 * The MERCHANT's own plan surface — `/admin/stores/:storeId/plan/*`.
 *
 * ## Everything here is behind `store:manage`, and reads too
 *
 * The #88 reasoning, verbatim: the comparison, the upgrade, the portal and the
 * cancellation are one conversation — "what does Mercaria charge this store, and
 * do we agree" — and that is the owner's conversation. A screen that could show
 * the plan but not change it would be built against a permission split this API
 * could then not change without breaking it. `store:manage` is the one
 * permission an `admin` does not hold.
 *
 * ## A refusal never threatens order access
 *
 * Issue #89 UX 5. It cannot: order management, fulfilment, refunds and financial
 * records have no capability key, so nothing on this surface can withdraw them
 * and no message here has anything to warn about.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { log } from '../lib/logger.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import {
  buildMerchantPlanStatus,
  listMerchantPlanCatalog,
} from '../services/entitlements/projection.js';
import {
  openMerchantBillingPortal,
  scheduleMerchantSubscriptionCancellation,
  startMerchantPlanCheckout,
} from '../services/billing/subscription.service.js';
import type { MerchantPlanCheckoutBody } from '../middleware/merchant-plans-schemas.js';

/** GET /admin/stores/:storeId/plan — this store's plan, entitlements and usage. */
export async function getStorePlanHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = routeParam(req, 'storeId');
    sendSuccess(res, await buildMerchantPlanStatus({ storeId }));
  } catch (err) {
    log.general.error({ err }, 'Failed to read a store plan');
    respondWithError(res, err, 'Failed to read the plan');
  }
}

/** GET /admin/stores/:storeId/plan/catalog — the plan comparison. */
export async function getPlanCatalogHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, { plans: await listMerchantPlanCatalog() });
  } catch (err) {
    log.general.error({ err }, 'Failed to read the plan catalogue');
    respondWithError(res, err, 'Failed to read the plans');
  }
}

/**
 * POST /admin/stores/:storeId/plan/checkout — start a paid plan.
 *
 * Answers a hosted URL and nothing else. No subscription row is created here:
 * the row is written from a provider snapshot, so a client that never reaches
 * the hosted page leaves an acceptance and no billing relationship.
 */
export async function startPlanCheckoutHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = routeParam(req, 'storeId');
    const body = req.body as MerchantPlanCheckoutBody;
    const session = await startMerchantPlanCheckout({
      storeId,
      // `loadStore` has already resolved and authorized it, so this is a read
      // rather than a second lookup that could disagree with the one the
      // permission was checked against.
      storeName: req.store?.name ?? storeId,
      planId: body.planId,
      interval: body.interval,
      currency: body.currency,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, session);
  } catch (err) {
    log.general.error({ err }, 'Failed to start a plan checkout');
    respondWithError(res, err, 'Failed to start the upgrade');
  }
}

/** POST /admin/stores/:storeId/plan/portal — open the hosted billing portal. */
export async function openPlanPortalHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await openMerchantBillingPortal({ storeId: routeParam(req, 'storeId') }));
  } catch (err) {
    log.general.error({ err }, 'Failed to open the billing portal');
    respondWithError(res, err, 'Failed to open the billing portal');
  }
}

/**
 * POST /admin/stores/:storeId/plan/cancel — cancel at the end of the period.
 *
 * There is no immediate-cancellation route, and that is the initial plan
 * design's decision rather than an omission: a merchant who paid for a month
 * keeps the month, and no proration is issued.
 */
export async function cancelStorePlanHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = routeParam(req, 'storeId');
    await scheduleMerchantSubscriptionCancellation({
      storeId,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, await buildMerchantPlanStatus({ storeId }));
  } catch (err) {
    log.general.error({ err }, 'Failed to cancel a subscription');
    respondWithError(res, err, 'Failed to cancel the subscription');
  }
}
