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
import { acceptActivationPolicySchema } from '../middleware/merchant-activation-schemas.js';
import {
  acceptSellerPolicyHandler,
  getSellerActivationPoliciesHandler,
} from '../controllers/merchant-activation.controller.js';
import { getMyProfile, updateMyProfile } from '../controllers/seller-profile.controller.js';
import {
  createSellerOnboardingLinkHandler,
  getSellerPaymentAccountHandler,
} from '../controllers/payments.controller.js';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  listMyListings,
  createMyListing,
  getMyListing,
  updateMyListing,
  deleteMyListing,
  loadOwnedListing,
} from '../controllers/seller-listings.controller.js';
import { makeListingLocalizationRouter } from '../controllers/listing-localizations.controller.js';
import { makeVariantImageRouter } from '../controllers/variant-images.controller.js';
import { routeParam } from '../utils/request.js';
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
/**
 * The INDIVIDUAL seller's activation policies (#85, closing #112's one
 * `unevaluable` criterion).
 *
 * On `/seller` rather than under `/admin/stores/:storeId` because the owner is a
 * PERSON: #88 shipped fee acceptance behind `store:manage` and recorded the P2P
 * surface as #85's precisely because somebody selling a bicycle has no store and
 * no permission to hold. The acceptance row is the same table the store half
 * writes, with `owner_type = 'user'` — one vocabulary, two owners, which is the
 * `provider_accounts` shape.
 *
 * Accepting one does NOT make guest P2P checkout available: #112's decision is
 * a recorded no-go and `GuestP2PAuthorization` has no member meaning yes. What
 * it changes is that the criterion is answerable, which is what the decision
 * document said it was waiting for.
 */
router.get('/activation/policies', makeRateLimiter('stores'), getSellerActivationPoliciesHandler);
router.post(
  '/activation/policies',
  makeRateLimiter('stores'),
  validateBody(acceptActivationPolicySchema),
  acceptSellerPolicyHandler,
);

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
 * `/seller/listings/:id/localizations` — a P2P seller's own translations (#814).
 *
 * The `user` half of a two-mount split;
 * `/admin/stores/:storeId/products/:id/localizations` is the `store` half, and
 * both call `makeListingLocalizationRouter`. There is no permission question to
 * ask here and none is asked: the owner IS the authenticated caller, which
 * `loadOwnedListing` — the SAME function `PATCH /seller/listings/:id` uses —
 * establishes before any handler body runs.
 *
 * On the `'listings'` rate-limit scope, not a new one: this is the catalog
 * write path reached through another door, and a seller saving a Spanish title
 * is the same traffic shape as a seller saving an English one.
 */
router.use(
  '/listings/:id/localizations',
  makeRateLimiter('listings'),
  validateId('id'),
  makeListingLocalizationRouter(async (req) =>
    loadOwnedListing(routeParam(req, 'id'), getRequiredOxyUserId(req)),
  ),
);

/**
 * `/seller/listings/:id/variants/:variantId/images` — which of a P2P seller's
 * own gallery photographs each variant shows (#855).
 *
 * The `user` half of a two-mount split;
 * `/admin/stores/:storeId/products/:id/variants/:variantId/images` is the
 * `store` half, and both call `makeVariantImageRouter`. There is no permission
 * question to ask here and none is asked: the owner IS the authenticated
 * caller, which `loadOwnedListing` — the SAME function `PATCH
 * /seller/listings/:id` and the localization mount above both use —
 * establishes before any handler body runs.
 *
 * On the `'listings'` rate-limit scope, not a new one: this is the catalog
 * write path reached through another door, and a seller assigning a photograph
 * to the blue one is the same traffic shape as a seller uploading it.
 *
 * `validateId('id')` only. `:variantId` is deliberately NOT validated here —
 * `requireVariantId` resolves it against the listing's OWN variants, so an
 * unparseable id is a variant this listing does not have and answers 404
 * through the same branch as a well-formed one that belongs to somebody else.
 * A format check in front of it would be a second answer that can disagree.
 *
 * The mount names the WHOLE path rather than `/listings/:id/variants`. There is
 * no sibling under that prefix on THIS router today, so nothing is intercepted
 * either way — but the store mount has four, and a `router.use` prefix applies
 * its middleware to every request matching it whether or not a route matches.
 * Both mounts are spelled the same way so the two halves of one surface cannot
 * drift, and so adding a seller-side variant route later is not a silent
 * re-permissioning.
 */
router.use(
  '/listings/:id/variants/:variantId/images',
  makeRateLimiter('listings'),
  validateId('id'),
  makeVariantImageRouter(async (req) =>
    loadOwnedListing(routeParam(req, 'id'), getRequiredOxyUserId(req)),
  ),
);

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
