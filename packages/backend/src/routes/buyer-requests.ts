/**
 * The BUYER-facing routes for post-purchase requests (#110).
 *
 * ONE router, mounted twice — under `/orders/:id` for an authenticated Oxy
 * buyer and under `/guest/orders/:groupId/orders/:id` for a portal credential.
 * That is ADR 0003 I9 at the routing layer: there is nothing guest-shaped
 * below, so forking the router would be forking six handlers to change which
 * credential they read, and the credential is already the one thing
 * `buyerCredential` resolves.
 *
 * `mergeParams` so `:id` (and, on the guest mount, `:groupId`) reaches the
 * handlers from the parent.
 *
 * ## The limiter is per IP, and that is deliberate rather than a shortcut
 *
 * `makeActorRateLimiter` would be the #104 answer, and it is the wrong one
 * here: it keys on `req.commerceActor`, which these routes never resolve — a
 * portal credential is a DIFFERENT credential, deliberately resolved by a
 * second resolver (ADR 0003 D3). Mounting the actor limiter would make every
 * portal caller look anonymous and degrade the whole thing to per-IP anyway,
 * silently, which its own docblock warns about. `makeRateLimiter` says per-IP
 * out loud, which is what #108's portal routes already use for the same reason.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import {
  createCancellationRequest,
  createReturnRequest,
  getRequestOptions,
  listCancellations,
  listReturns,
  postBuyerSupportMessage,
  readBuyerSupportThread,
  withdrawCancellation,
  withdrawReturn,
} from '../controllers/buyer-requests.controller.js';

const router = Router({ mergeParams: true });

const limit = makeRateLimiter('buyer-requests');

router.get('/request-options', limit, getRequestOptions);

router.get('/cancellation-requests', limit, listCancellations);
router.post('/cancellation-requests', limit, createCancellationRequest);
router.post('/cancellation-requests/:requestId/withdraw', limit, withdrawCancellation);

router.get('/return-requests', limit, listReturns);
router.post('/return-requests', limit, createReturnRequest);
router.post('/return-requests/:requestId/withdraw', limit, withdrawReturn);

router.get('/support', limit, readBuyerSupportThread);
router.post('/support', limit, postBuyerSupportMessage);

export default router;
