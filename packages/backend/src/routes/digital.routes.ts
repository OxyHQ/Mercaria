/**
 * `/digital/*` — the creator and buyer HTTP surfaces of #1015 (ADR 0010).
 *
 * ONE file and TWO routers, because the two halves share a prefix and nothing
 * else: different credentials, different levers, different rate-limit keys, and
 * different consequences for getting the authorization wrong.
 *
 * ## The creator MOUNT is gated; the buyer mount is not, and that is the point
 *
 * `DIGITAL_UPLOADS_ENABLED` gates the creator router's mount, the
 * `STRIPE_ENABLED` rule: a deployment that does not do creator uploads answers
 * 404 rather than 401, because a 401 tells an unauthenticated caller that the
 * surface exists here. It defaults OFF (ADR 0010 D13).
 *
 * The BUYER router is mounted unconditionally and deliberately, for the reason
 * `/guest/orders` is: every lever in D13 must be pullable *"without stranding
 * prior purchases"*, and gating this mount would mean that turning uploads off
 * — a creator-side decision — also took away the library of everybody who had
 * already paid. `DIGITAL_DOWNLOADS_ENABLED` is the lever that reaches a download
 * and it is checked INSIDE `download.service`, where it refuses a new grant with
 * `downloads_disabled` and leaves every right `active`.
 *
 * ## This is NOT a raw-body mount and must not become one
 *
 * The five routers mounted before `express.json()` are a closed set asserted per
 * mount, and nothing here belongs in it: the creator registers a file that was
 * uploaded STRAIGHT TO OXY and posts its `file_id`, so no request on this router
 * carries bytes. If a future upload route ever needs the stream, that is a sixth
 * mount and a sixth test file — a decision for a human, not a line added here.
 *
 * ## There is no `/internal/*` surface here
 *
 * Every `/internal/*` router is gated by an operator allow-list and this creates
 * none. An operator action on a right — a revocation under a documented legal
 * basis, a support grant — is `right.service`'s and belongs on an existing
 * operator surface whose power it already shares, not on a new list.
 */

import { Router } from 'express';
import { config } from '../config/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { loadStore, requireStorePermission } from '../middleware/store-authz.js';
import { makeActorRateLimiter, makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId } from '../middleware/validate.js';
import {
  addAssetPackageFilesSchema,
  bindAssetVariantSchema,
  claimFreeAssetSchema,
  createAssetLicenceOptionSchema,
  createAssetLicenceSchema,
  createAssetLicenceVersionSchema,
  createAssetPackageSchema,
  createAssetVersionSchema,
  createDigitalAssetSchema,
  mintAssetDownloadGrantSchema,
  registerAssetFileSchema,
} from '../middleware/schemas.js';
import {
  addAssetPackageFilesHandler,
  bindAssetVariantHandler,
  createAssetLicenceHandler,
  createAssetLicenceOptionHandler,
  createAssetLicenceVersionHandler,
  createAssetPackageHandler,
  createAssetVersionHandler,
  createDigitalAssetHandler,
  publishAssetLicenceVersionHandler,
  publishAssetVersionHandler,
  registerAssetFileHandler,
  withdrawAssetVersionHandler,
} from '../controllers/digital-creator.controller.js';
import {
  claimFreeDigitalAssetHandler,
  listDigitalLibraryHandler,
  mintDigitalDownloadHandler,
  redeemDigitalDownloadHandler,
} from '../controllers/digital-buyer.controller.js';

/* -------------------------------------------------------------------------- */
/* The creator router — `store:manage`, store-scoped, gated at the mount        */
/* -------------------------------------------------------------------------- */

/**
 * `mergeParams` so `loadStore` can read `:storeId` from the parent mount.
 *
 * `store:manage` and not `products:write`, following payment onboarding, fee
 * acceptance and merchant identity: it is the one permission an `admin` does not
 * hold, and what this surface decides is what the store's name is attached to
 * legally — the licence terms buyers are held to and the files they receive.
 * `products:write`, which every staff member holds, would put that on the shop
 * floor.
 */
const creatorRouter = Router({ mergeParams: true });

/**
 * The `admin` scope, shared with the dashboard tree it is part of.
 *
 * Not a second bucket: `/admin/stores/:storeId/*` already meters a merchant's
 * management traffic on `rl:admin:` keyed per Oxy user, and a creator publishing
 * an asset is the same person on the same dashboard drawing on the same budget.
 * The two mounts are on different prefixes, so no request passes through both
 * and there is no `ERR_ERL_DOUBLE_COUNT` to be had.
 */
creatorRouter.use(makeRateLimiter('admin'), authenticateToken, loadStore);
// ONE `router.use` rather than a per-route repetition, because EVERY route below
// is a creator write on the store's own asset graph and there is no read here
// that a weaker permission could serve. A route added without it would be the
// hole, and there is nothing for the gate to be wrong about.
creatorRouter.use(requireStorePermission('store:manage'));

creatorRouter.post('/assets', validateBody(createDigitalAssetSchema), createDigitalAssetHandler);

creatorRouter.post(
  '/assets/:assetId/versions',
  validateId('assetId'),
  validateBody(createAssetVersionSchema),
  createAssetVersionHandler,
);

creatorRouter.post(
  '/assets/:assetId/versions/:versionId/files',
  validateId('assetId'),
  validateId('versionId'),
  validateBody(registerAssetFileSchema),
  registerAssetFileHandler,
);

creatorRouter.post(
  '/assets/:assetId/versions/:versionId/publish',
  validateId('assetId'),
  validateId('versionId'),
  publishAssetVersionHandler,
);

creatorRouter.post(
  '/assets/:assetId/versions/:versionId/withdraw',
  validateId('assetId'),
  validateId('versionId'),
  withdrawAssetVersionHandler,
);

creatorRouter.post(
  '/assets/:assetId/packages',
  validateId('assetId'),
  validateBody(createAssetPackageSchema),
  createAssetPackageHandler,
);

creatorRouter.post(
  '/assets/:assetId/packages/:packageId/files',
  validateId('assetId'),
  validateId('packageId'),
  validateBody(addAssetPackageFilesSchema),
  addAssetPackageFilesHandler,
);

creatorRouter.post(
  '/assets/:assetId/licence-options',
  validateId('assetId'),
  validateBody(createAssetLicenceOptionSchema),
  createAssetLicenceOptionHandler,
);

creatorRouter.post('/licences', validateBody(createAssetLicenceSchema), createAssetLicenceHandler);

creatorRouter.post(
  '/licences/:licenceId/versions',
  validateId('licenceId'),
  validateBody(createAssetLicenceVersionSchema),
  createAssetLicenceVersionHandler,
);

/**
 * Publishing a licence version is a SECOND request, not a flag on the create.
 *
 * `asset_licence_versions_immutable_once_published` freezes every terms column
 * the moment `published_at` is set, so a creator who cannot read a draft back
 * before that happens freezes a typo into every purchase made under it. ADR 0010
 * D3 is what makes the extra round trip worth its cost.
 */
creatorRouter.post(
  '/licences/:licenceId/versions/:versionId/publish',
  validateId('licenceId'),
  validateId('versionId'),
  publishAssetLicenceVersionHandler,
);

creatorRouter.post(
  '/variant-bindings',
  validateBody(bindAssetVariantSchema),
  bindAssetVariantHandler,
);

/* -------------------------------------------------------------------------- */
/* The buyer router — a `CommerceActor`, authenticated OR guest                 */
/* -------------------------------------------------------------------------- */

/**
 * ONE limiter instance shared by the four buyer routes, so they share a counter
 * rather than four independent budgets of the same size.
 *
 * Keyed on the ACTOR (`makeActorRateLimiter`), which is the only correct key
 * here: `createOxyRateLimit` falls back to the IP, and a guest buyer behind one
 * carrier NAT would then share a bucket with every other guest on it.
 *
 * It shares the `orders` SCOPE with `routes/checkout.ts`'s own actor limiter,
 * which is the existing precedent for an actor-keyed limiter on that scope — and
 * the consequence is stated rather than glossed: the Redis prefix is derived from
 * the scope NAME and both use the same key format, so a buyer's checkout writes
 * and their download requests draw on ONE actor bucket. That is defensible while
 * the digital surface is four routes (a library read, a grant, a redirect and a
 * claim — all post-purchase access to what somebody already bought), and it
 * stops being defensible the moment a client polls a download. A dedicated
 * `digital-downloads` member of `RateLimitScope` is the right shape and is
 * deliberately NOT added here: that union lives in `lib/rate-limit.ts`, which
 * this change does not own, and it is read by every other metered surface.
 */
const buyerLimiter = makeActorRateLimiter('orders');

const buyerRouter = Router();

buyerRouter.use(resolveCommerceActor, buyerLimiter);

/** GET /digital/library — every right this buyer holds. */
buyerRouter.get('/library', listDigitalLibraryHandler);

/** POST /digital/downloads — authorize, then mint a five-minute grant. */
buyerRouter.post(
  '/downloads',
  validateBody(mintAssetDownloadGrantSchema),
  mintDigitalDownloadHandler,
);

/**
 * GET /digital/downloads/:token — redeem and redirect to the bytes.
 *
 * No `validateId` on the token: it is 256 bits of base64url this server minted,
 * not a row id, and running it through an id-shape predicate would refuse every
 * real token. Its validity is decided by the hash lookup, which is the only
 * check that can decide it.
 */
buyerRouter.get('/downloads/:token', redeemDigitalDownloadHandler);

/** POST /digital/claims — take a free asset into the library. */
buyerRouter.post('/claims', validateBody(claimFreeAssetSchema), claimFreeDigitalAssetHandler);

/* -------------------------------------------------------------------------- */
/* The mount                                                                   */
/* -------------------------------------------------------------------------- */

const router = Router();

if (config.digital.uploadsEnabled) {
  router.use('/stores/:storeId', creatorRouter);
}

// Unconditional, and AFTER the creator mount so a `/stores/...` path is matched
// by the router that owns it rather than falling into the buyer chain.
router.use(buyerRouter);

export default router;
