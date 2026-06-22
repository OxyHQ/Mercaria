import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { getHomeFeed } from '../controllers/feed.controller.js';

/**
 * Home feed API.
 *
 * PUBLIC — browsing products is available to anonymous viewers. `optionalAuth`
 * attaches the viewer (when a token is present) so the feed can mark items
 * `saved` for that user; it never blocks anonymous access.
 *
 * A dedicated `'feed'` rate-limit scope keeps a distinct `rl:feed:` Redis prefix
 * so its counter never collides with the global `general` limiter.
 */
const router = Router();

router.use(makeRateLimiter('feed'), optionalAuth);

/**
 * GET /feed
 * The home feed: an ordered list of discriminated sections (DB-backed).
 */
router.get('/', getHomeFeed);

export default router;
