/**
 * The BUYER-facing routes for retail cancellations, returns and warranty claims
 * (#127).
 *
 * ONE router, mounted twice — under `/orders/:id` for an authenticated Oxy buyer
 * and under `/guest/orders/:groupId/orders/:id` for a portal credential. That is
 * #127 responsibility rule 7 at the routing layer: a guest gets the same rights
 * through the same handlers, and forking the router would be forking five
 * handlers to change which credential they read.
 *
 * `mergeParams` so `:id` (and, on the guest mount, `:groupId`) reaches the
 * handlers from the parent.
 *
 * The limiter is per IP, deliberately: `makeActorRateLimiter` keys on
 * `req.commerceActor`, which these routes never resolve — a portal credential is
 * a different credential resolved by a different resolver (ADR 0003 D3) — so
 * mounting it would degrade to per-IP silently. #110's routes say per-IP out
 * loud for the same reason, and this shares their bucket because they are the
 * same buyer doing the same kind of thing.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import {
  addRetailRequestEvidence,
  createRetailRequest,
  getRetailRequestOptions,
  listRetailRequests,
  withdrawRetailRequest,
} from '../controllers/retail-service-requests.controller.js';

const router = Router({ mergeParams: true });

const limit = makeRateLimiter('buyer-requests');

router.get('/retail-requests/options', limit, getRetailRequestOptions);
router.get('/retail-requests', limit, listRetailRequests);
router.post('/retail-requests', limit, createRetailRequest);
router.post('/retail-requests/:requestId/evidence', limit, addRetailRequestEvidence);
router.post('/retail-requests/:requestId/withdraw', limit, withdrawRetailRequest);

export default router;
