import { Router } from 'express';
import { z } from 'zod';
import type { DiscoveryScope } from '@mercaria/shared-types';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { getDiscoveryFeedHandler } from '../controllers/discovery.controller.js';

/**
 * Discovery API — the explore (`root`), category and deals pages served from
 * ONE contract (`services/discovery/feed.service.ts`'s own docblock).
 *
 * PUBLIC — browsing products is available to anonymous viewers, mirroring
 * `routes/feed.ts`. `optionalAuth` attaches the viewer (when a token is
 * present) so the feed can mark items `saved` for that user; it never blocks
 * anonymous access.
 *
 * A dedicated `'discovery'` rate-limit scope (`rl:discovery:`) rather than
 * sharing `'feed'`: this surface is three pages plus a paginated signal route,
 * and sharing the home feed's budget would let a crawler working
 * `/discovery/feed?scope=deals` exhaust the home feed's allowance for
 * everyone.
 */
const router = Router();

router.use(makeRateLimiter('discovery'), optionalAuth);

const CATEGORY_SCOPE_PREFIX = 'category:';

/** A category handle, bound the same way `catalog-page-schemas.ts`'s `categorySlug` is. */
const categoryHandleSchema = z.string().trim().min(1).max(256);

/**
 * `scope=root|deals|category:<handle>` parsed into the {@link DiscoveryScope}
 * discriminated union the service takes.
 *
 * Not a hand-rolled `split(':')` that accepts anything: an unrecognised scope
 * or a malformed handle raises the same `ctx.addIssue` a Zod schema always
 * does (`middleware/catalog-page-schemas.ts`'s `attributeEntry` is the
 * precedent for a transform that validates a colon-joined query value this
 * way), so a typo is a 400 rather than a silent default to `root` served with
 * a 200.
 */
const scopeSchema = z
  .string()
  .min(1, 'scope is required')
  .transform((raw, ctx): DiscoveryScope => {
    if (raw === 'root') {
      return { kind: 'root' };
    }
    if (raw === 'deals') {
      return { kind: 'deals' };
    }
    if (raw.startsWith(CATEGORY_SCOPE_PREFIX)) {
      const parsedHandle = categoryHandleSchema.safeParse(raw.slice(CATEGORY_SCOPE_PREFIX.length));
      if (parsedHandle.success) {
        return { kind: 'category', handle: parsedHandle.data };
      }
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scope must be "root", "deals", or "category:<handle>"',
    });
    return z.NEVER;
  });

const discoveryFeedQuerySchema = z.object({ scope: scopeSchema }).strict();

/**
 * GET /discovery/feed
 * The explore, category or deals feed, selected by `?scope=`.
 */
router.get('/feed', validateQuery(discoveryFeedQuerySchema), getDiscoveryFeedHandler);

export default router;
