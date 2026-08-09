import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId } from '../middleware/validate.js';
import { favoriteIntentSchema } from '../middleware/product-save-schemas.js';
import {
  listMyFavorites,
  addFavorite,
  removeFavorite,
} from '../controllers/favorites.controller.js';

/**
 * Favorites API — the authenticated buyer's saved LISTINGS.
 *
 * `GET /favorites` lists the buyer's saved listings (hydrated). `POST`/`DELETE
 * /favorites/:listingId` toggle a single listing on/off idempotently. Metered on
 * the `'listings'` scope (catalog read/write path).
 *
 * #80 did not change this surface's shape. What it added is an OPTIONAL
 * `{intent}` body on the POST — `listing_pin` when a buyer explicitly chose the
 * exact listing over the product it maps to — and an optional body is exactly
 * that: a v1 client sends nothing, gets the behaviour it always got, and cannot
 * be broken by a build it never shipped with.
 */
const router = Router();

router.use(authenticateToken);

router.get('/', makeRateLimiter('listings'), listMyFavorites);
router.post(
  '/:listingId',
  makeRateLimiter('listings'),
  validateId('listingId'),
  validateBody(favoriteIntentSchema),
  addFavorite,
);
router.delete('/:listingId', makeRateLimiter('listings'), validateId('listingId'), removeFavorite);

export default router;
