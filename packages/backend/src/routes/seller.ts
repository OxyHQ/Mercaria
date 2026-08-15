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
import {
  deleteDraft,
  getDraftPreview,
  listDrafts,
  listMatchCandidates,
  patchDraft,
  publishDraft,
  startDraft,
} from '../controllers/sell-yours.controller.js';
import {
  getLocalDiscoveryHandler,
  putLocalDiscoveryHandler,
} from '../controllers/seller-local-discovery.controller.js';
import { setLocalDiscoverySchema } from '../middleware/pickup-schemas.js';
import {
  patchSellerDraftSchema,
  sellerDraftPreviewQuerySchema,
  sellerMatchCandidateQuerySchema,
  startSellerDraftSchema,
} from '../middleware/sell-yours-schemas.js';
import { assertNoProofFields } from '../services/sell-yours/draft.service.js';
import { config } from '../config/index.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * The proof-field gate, as middleware so it runs BEFORE the `.strict()` parse.
 *
 * A `.strict()` schema would answer "unrecognized key" for a serial number,
 * which tells a seller nothing about why Mercaria will not take it. #121's
 * `forbidden-evidence.ts` mounts its own refusal ahead of the schema for the
 * same reason, and a test there pins the answer by MESSAGE.
 */
function assertNoProofFieldsMiddleware(
  req: Parameters<typeof startDraft>[0],
  res: Parameters<typeof startDraft>[1],
  next: () => void,
): void {
  try {
    assertNoProofFields((req.body ?? {}) as Record<string, unknown>);
    next();
  } catch (err) {
    respondWithError(res, err, 'Failed to validate the listing draft');
  }
}

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

/**
 * The "Sell yours" flow (#91).
 *
 * Mounted under `/seller` because a draft is one seller's own work-in-progress
 * and the router's `authenticateToken` already establishes them — the same
 * reasoning `/seller/listings` uses. `SELL_YOURS_ENABLED` gates the MOUNT and
 * never a stored draft: with it off the flow is unavailable and every draft is
 * exactly where its owner left it.
 *
 * `assertNoProofFieldsMiddleware` runs BEFORE the `.strict()` schemas, so a
 * seller who sends a serial number is told what Mercaria does not accept and
 * why, instead of "unrecognized key" (#121's `forbidden-evidence.ts` device).
 *
 * `/drafts/candidates` is registered before `/drafts/:id` — otherwise
 * `candidates` is read as a draft id and every scan answers 404.
 */
if (config.sellYours.enabled) {
  router.get(
    '/drafts/candidates',
    makeRateLimiter('listings'),
    validateQuery(sellerMatchCandidateQuerySchema),
    listMatchCandidates,
  );
  router.get('/drafts', makeRateLimiter('listings'), listDrafts);
  router.post(
    '/drafts',
    makeRateLimiter('listings'),
    assertNoProofFieldsMiddleware,
    validateBody(startSellerDraftSchema),
    startDraft,
  );
  router.get(
    '/drafts/:id',
    makeRateLimiter('listings'),
    validateId('id'),
    validateQuery(sellerDraftPreviewQuerySchema),
    getDraftPreview,
  );
  router.patch(
    '/drafts/:id',
    makeRateLimiter('listings'),
    validateId('id'),
    assertNoProofFieldsMiddleware,
    validateBody(patchSellerDraftSchema),
    patchDraft,
  );
  router.delete('/drafts/:id', makeRateLimiter('listings'), validateId('id'), deleteDraft);
  router.post(
    '/drafts/:id/publish',
    makeRateLimiter('listings'),
    validateId('id'),
    publishDraft,
  );
}
// Local discovery (#93 P2P) — a coarse AREA, opted into per listing. The write
// accepts a precise position and the server rounds it to a cell before storing;
// `listing_local_discovery` has no coordinate column, so nothing here can
// persist a seller's home.
router.get(
  '/listings/:id/local-discovery',
  makeRateLimiter('listings'),
  validateId('id'),
  getLocalDiscoveryHandler,
);
router.put(
  '/listings/:id/local-discovery',
  makeRateLimiter('listings'),
  validateId('id'),
  validateBody(setLocalDiscoverySchema),
  putLocalDiscoveryHandler,
);

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
