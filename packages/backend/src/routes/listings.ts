import { Router } from 'express';
import type {
  Listing,
  ListingQuery,
  PaginatedResponse,
  ApiResponse,
} from '@marketplace/shared-types';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';

/**
 * Listings API.
 *
 * This is the seam for the Marketplace domain (listings persistence, search,
 * buy/sell). It currently serves an empty, correctly-typed result set so the
 * shared `@marketplace/shared-types` contract is exercised end to end while the
 * domain (models, queries, shops) is built on top.
 */
const router = Router();

router.use(makeRateLimiter('listings'), optionalAuth);

/**
 * GET /listings
 * Search/browse listings. Returns a paginated page of listings.
 */
router.get('/', (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20));

  // Echo the parsed query so the typed contract is visible at the seam.
  const query: ListingQuery = {
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    category: typeof req.query.category === 'string' ? req.query.category : undefined,
  };
  void query;

  const items: Listing[] = [];

  const body: PaginatedResponse<Listing> = {
    data: items,
    pagination: {
      page,
      limit,
      total: items.length,
      pages: 0,
      hasNextPage: false,
      hasPreviousPage: page > 1,
    },
  };

  res.status(200).json(body);
});

/**
 * GET /listings/:id
 * Fetch a single listing by id.
 */
router.get('/:id', (_req, res) => {
  const body: ApiResponse<Listing> = {
    success: false,
    error: 'not_found',
    message: 'Listing not found',
  };
  res.status(404).json(body);
});

export default router;
