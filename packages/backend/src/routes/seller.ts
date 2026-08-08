import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  createP2PListingSchema,
  updateListingSchema,
  sellerPrefsSchema,
  fulfillOrderSchema,
  orderListQuerySchema,
} from '../middleware/schemas.js';
import { onboardingLinkSchema } from '../middleware/payments-schemas.js';
import { getMyProfile, updateMyProfile } from '../controllers/seller-profile.controller.js';
import {
  createSellerOnboardingLinkHandler,
  getSellerPaymentAccountHandler,
} from '../controllers/payments.controller.js';
import {
  listMyListings,
  createMyListing,
  getMyListing,
  updateMyListing,
  deleteMyListing,
} from '../controllers/seller-listings.controller.js';
import { listSellerOrders, fulfillOrderHandler } from '../controllers/seller-orders.controller.js';

/**
 * Seller API — the individual (P2P) seller's own profile + listings.
 *
 * Every route requires a real Oxy user (`authenticateToken`). Ownership of a
 * listing is enforced in the controller/service (the listing's `oxyUserId` must
 * match the caller). Metered on the `'listings'` scope (the catalog write path)
 * with `/me` profile reads/writes on the `'stores'` scope.
 */
const router = Router();

router.use(authenticateToken);

// Seller profile.
router.get('/me', makeRateLimiter('stores'), getMyProfile);
router.patch('/me', makeRateLimiter('stores'), validateBody(sellerPrefsSchema), updateMyProfile);

// Seller payment onboarding (ADR 0001 D9: for a P2P seller, the seller
// themself). There is no permission to check and none is missing — the router's
// `authenticateToken` establishes the caller and the controller derives the
// owner from `getRequiredOxyUserId`, so the surface can only ever act on the
// caller's own account. Link minting carries the same dedicated meter the store
// route uses, for the same reason: it reaches Stripe.
router.get('/payments/account', getSellerPaymentAccountHandler);
router.post(
  '/payments/account/onboarding-link',
  makeRateLimiter('payments'),
  validateBody(onboardingLinkSchema),
  createSellerOnboardingLinkHandler,
);

// Seller listings (P2P).
router.get('/listings', makeRateLimiter('listings'), listMyListings);
router.post(
  '/listings',
  makeRateLimiter('listings'),
  validateBody(createP2PListingSchema),
  createMyListing,
);
router.get('/listings/:id', makeRateLimiter('listings'), validateId('id'), getMyListing);
router.patch(
  '/listings/:id',
  makeRateLimiter('listings'),
  validateId('id'),
  validateBody(updateListingSchema),
  updateMyListing,
);
router.delete('/listings/:id', makeRateLimiter('listings'), validateId('id'), deleteMyListing);

// Seller orders (incoming P2P orders + fulfilment).
router.get('/orders', makeRateLimiter('orders'), validateQuery(orderListQuerySchema), listSellerOrders);
router.patch(
  '/orders/:id/fulfill',
  makeRateLimiter('orders'),
  validateId('id'),
  validateBody(fulfillOrderSchema),
  fulfillOrderHandler,
);

export default router;
