import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateObjectId } from '../middleware/validate.js';
import {
  listMyFavorites,
  addFavorite,
  removeFavorite,
} from '../controllers/favorites.controller.js';

/**
 * Favorites API — the authenticated buyer's wishlist.
 *
 * `GET /favorites` lists the buyer's saved listings (hydrated). `POST`/`DELETE
 * /favorites/:listingId` toggle a single listing on/off idempotently. Metered on
 * the `'listings'` scope (catalog read/write path).
 */
const router = Router();

router.use(authenticateToken);

router.get('/', makeRateLimiter('listings'), listMyFavorites);
router.post('/:listingId', makeRateLimiter('listings'), validateObjectId('listingId'), addFavorite);
router.delete('/:listingId', makeRateLimiter('listings'), validateObjectId('listingId'), removeFavorite);

export default router;
