import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateObjectId } from '../middleware/validate.js';
import { browseListings, getListingById } from '../controllers/listings.controller.js';
import { listListingReviews } from '../controllers/reviews.controller.js';

/**
 * Listings API — DB-backed browse/search + product detail.
 *
 * PUBLIC: `optionalAuth` attaches the viewer (when present) so `saved` can be
 * hydrated; it never blocks anonymous access. The `'listings'` scope rate-limits
 * the router; the browse route additionally composes the `'search'` scope so
 * heavier search traffic is metered on its own `rl:search:` counter.
 */
const router = Router();

router.use(makeRateLimiter('listings'), optionalAuth);

/**
 * GET /listings
 * Browse/search listings. Offset-paginated for default/`price_*` sort; returns a
 * cursor page for `newest` sort when a cursor is supplied.
 */
router.get('/', makeRateLimiter('search'), browseListings);

/**
 * GET /listings/:id
 * The product detail page — a single fully-hydrated listing.
 */
router.get('/:id', validateObjectId('id'), getListingById);

/**
 * GET /listings/:id/reviews
 * A listing's published reviews (paginated, newest first).
 */
router.get('/:id/reviews', validateObjectId('id'), listListingReviews);

export default router;
