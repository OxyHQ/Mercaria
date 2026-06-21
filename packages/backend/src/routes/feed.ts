import { Router } from 'express';
import type { Feed, ApiResponse } from '@mercaria/shared-types';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { FEED_SHELVES } from '../lib/mock-products.js';

/**
 * Home feed API.
 *
 * PUBLIC — browsing products is available to anonymous viewers, so this route
 * applies NO auth middleware. It currently serves mock shelves (see
 * `lib/mock-products.ts`) so the shared `@mercaria/shared-types` feed contract
 * is exercised end to end while the marketplace domain is built on top.
 *
 * A dedicated `'feed'` rate-limit scope keeps a distinct `rl:feed:` Redis prefix
 * so its counter never collides with the global `general` limiter.
 */
const router = Router();

router.use(makeRateLimiter('feed'));

/**
 * GET /feed
 * The home feed: an ordered list of product shelves.
 */
router.get('/', (_req, res) => {
  const body: ApiResponse<Feed> = {
    success: true,
    data: { shelves: FEED_SHELVES },
  };

  res.status(200).json(body);
});

export default router;
