/**
 * `/product-saves` — the buyer's canonical product saves (#80).
 *
 * Mounted only when `PRODUCT_SAVES_ENABLED`, so a deployment that has not
 * adopted #80 answers 404 and serves `/favorites` exactly as it always did. The
 * SAVES themselves are never gated by anything: a row already stored stays
 * stored and comes back when the flag does, because a flag that hid a person's
 * data would make the rollback lever cost them their list.
 *
 * Metered on the `'listings'` scope — a save is a catalogue-shaped read/write
 * at the same rate and volume, and a dedicated bucket would be a fourth budget
 * to tune for no risk the catalogue budget does not already bound. (Contrast
 * `'sellers'`, which earned its own because that route is keyed on an Oxy
 * ACCOUNT ID and enumeration is the risk; these are keyed on catalogue ids.)
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId } from '../middleware/validate.js';
import {
  resolveSplitSchema,
  saveProductSchema,
  updateProductSaveSchema,
} from '../middleware/product-save-schemas.js';
import {
  getProductSaveHandler,
  listingSaveContextHandler,
  pendingResolutionsHandler,
  resolveSplitHandler,
  saveProductHandler,
  unsaveProductHandler,
  updateProductSaveHandler,
} from '../controllers/product-saves.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(makeRateLimiter('listings'));

/**
 * The two literal paths come FIRST, or `/:canonicalProductId` swallows them.
 *
 * `listings/:listingId` is the two-button context a listing page reads;
 * `pending` is how many saves are waiting on this buyer to answer a split.
 */
router.get('/pending', pendingResolutionsHandler);
router.get('/listings/:listingId', validateId('listingId'), listingSaveContextHandler);

router.post('/', validateBody(saveProductSchema), saveProductHandler);

/**
 * Keyed on the CANONICAL PRODUCT and not on the save id, deliberately: a client
 * knows which product it is looking at and does not know the id of a save it has
 * not fetched, so `DELETE /product-saves/<product>` is idempotent on a product a
 * buyer never saved — which is what "idempotent under repeated taps" needs at
 * the HTTP layer as well as in the database.
 */
router.get(
  '/:canonicalProductId',
  validateId('canonicalProductId'),
  getProductSaveHandler,
);
router.patch(
  '/:canonicalProductId',
  validateId('canonicalProductId'),
  validateBody(updateProductSaveSchema),
  updateProductSaveHandler,
);
router.delete(
  '/:canonicalProductId',
  validateId('canonicalProductId'),
  unsaveProductHandler,
);

/**
 * The ONE route keyed on a save id, because a split resolution is about one
 * specific save and the product it points at is exactly what is in question.
 */
router.post(
  '/:saveId/resolve-split',
  validateId('saveId'),
  validateBody(resolveSplitSchema),
  resolveSplitHandler,
);

export default router;
