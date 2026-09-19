import { Router } from 'express';
import { z } from 'zod';
import { DISCOVERY_SIGNALS, type DiscoveryScope, type DiscoverySignal } from '@mercaria/shared-types';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import {
  getDiscoveryFeedHandler,
  getDiscoverySignalPageHandler,
} from '../controllers/discovery.controller.js';

/**
 * Discovery API — the explore (`root`), category and deals pages served from
 * ONE contract (`services/discovery/feed.service.ts`'s own docblock).
 *
 * PUBLIC — browsing products is available to anonymous viewers, mirroring
 * `routes/feed.ts`. `optionalAuth` attaches the viewer when a token is present
 * and never blocks anonymous access; NOTHING in this feed reads it yet. It is
 * not personalised — no item is marked `saved`, and the service takes no
 * viewer at all — so the response and its cache entry are shared by every
 * caller. Marking `saved` would mean threading a viewer through
 * `catalog-hydration.service.ts`'s `toProductSummaries`, which takes none, and
 * accepting a per-viewer cache; neither has been decided.
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

/** A category handle, bound the same shape `catalog-page-schemas.ts`'s `categorySlug` is — trimmed, non-empty, ceilinged. */
const categoryHandleSchema = z.string().trim().min(1).max(128);

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

const SIGNAL_VALUES = DISCOVERY_SIGNALS as readonly [DiscoverySignal, ...DiscoverySignal[]];

/**
 * `deals` refused here, not just left unhandled: it has no per-signal shelf to
 * page (`store-offer` sections carry no `signal`), so a `scope=deals` request
 * is a 400 naming exactly that, the same way an unrecognised `signal` value
 * is — never a silent 200 for a scope this route cannot serve.
 */
const discoverySignalScopeSchema = scopeSchema.refine(
  (scope): scope is Exclude<DiscoveryScope, { kind: 'deals' }> => scope.kind !== 'deals',
  { message: 'scope must be "root" or "category:<handle>" — deals has no per-signal shelf to page' },
);

/**
 * `limit`/`offset` are bounded here at the SCHEMA, not left to the controller
 * to clamp: an unbounded `limit` from a public route is the whole reason to
 * have a bound, and a negative or fractional `offset` is refused rather than
 * coerced into something that happens to work.
 */
const discoverySignalQuerySchema = z
  .object({
    signal: z.enum(SIGNAL_VALUES),
    scope: discoverySignalScopeSchema,
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * GET /discovery/signal
 * One page of a single signal's listings, within `scope` — the "see all" a
 * shelf's heading links to. See `services/discovery/signal.service.ts`'s own
 * docblock for why this is a separate route from `/feed` rather than a
 * parameter on it.
 */
router.get('/signal', validateQuery(discoverySignalQuerySchema), getDiscoverySignalPageHandler);

export default router;
