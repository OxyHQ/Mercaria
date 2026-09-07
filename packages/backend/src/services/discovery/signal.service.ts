/**
 * The paginated single-signal read — `GET /discovery/signal`.
 *
 * `feed.service.ts` builds one PAGE of each shelf (`config.discovery.shelfSize`
 * items, `offset: 0` — correct there, because a shelf is one page by
 * definition). Nothing was ever wrong in the feed; a "see all" surface was
 * simply missing beside it. `db/discovery/discoveryReadRepository.ts` already
 * declares `FindListingsBySignalInput` with both `limit` AND `offset` and its
 * own docstring reads "One page of listings" — the repository was always
 * ready for this, and this file is the first caller that asks for page two.
 *
 * A DIFFERENT route from `/discovery/feed`, not a parameter on it: the feed
 * returns SECTIONS, this returns one paged list, and folding the two together
 * would give one handler two return types (`DiscoverySignalPage`'s own
 * docblock).
 *
 * ## `hasMore` is read off the query, never computed
 *
 * `findListingsBySignal` is called with `limit + 1` and `hasMore` is
 * `rows.length > limit` — never arithmetic against a total, and never a
 * `pageDepth`-specific rule. That single computation is honest for both kinds
 * of signal: a `best-selling`/`most-viewed` (`DISCOVERY_SIGNALS_FROM_COUNTS`)
 * page ranks only within what the sweep counted, so the query exhausts itself
 * and `hasMore` goes `false` at the real edge instead of a number this file
 * predicted. A cap calculation would be a second source of truth for the same
 * fact, and it would be the one that goes stale.
 *
 * `pageDepth` ships alongside `hasMore` anyway because they say different
 * things: `hasMore: false` means "no more rows"; `pageDepth: 'capped'` means
 * "the end you reached is the end of what was COUNTED, not the end of the
 * catalogue" — the client renders that distinction, not this service.
 *
 * ## Every escape the feed already closes, closed here too
 *
 * A second read path over the same rows re-opens every one of them unless it
 * repeats the guards:
 *
 *   - `findListingsBySignal`'s five signal queries all filter
 *     `listings.status = 'active'` AT READ TIME, never from a sweep-side
 *     snapshot — status is mutable and a sweep's count is a point in time.
 *   - `category:<handle>` scopes through `activeSubtreeIds`, the SAME
 *     suppressed-category escape `feed.service.ts` closes: a shopper cannot
 *     navigate to a category they cannot see, so its listings must not be
 *     reachable through a scope that names its parent either.
 *   - `best-selling`/`most-viewed` keep their `gt(…, 0)` guards inside the
 *     repository — a shelf that returned a zero-count row is the exact defect
 *     that shipped once already, and a paged surface only makes it longer.
 *
 * ## The `root` scope has no single category to be about
 *
 * `feed.service.ts`'s root scope renders one shelf PER top-level category,
 * rotating signals; there is no one "root shelf" to page. This route's
 * `scope: { kind: 'root' }` instead means "every ACTIVE category, unscoped" —
 * every id `findActiveCategories()` returns, which is exactly the same
 * suppressed-category floor `category:<handle>` gets from `activeSubtreeIds`,
 * applied to the whole taxonomy instead of one subtree. `categoryHandle`/
 * `categoryName` are absent on this scope: there is no one category to name.
 */

import type {
  DiscoveryScope,
  DiscoverySignal,
  DiscoverySignalPage,
} from '@mercaria/shared-types';
import {
  findActiveCategories,
  findActiveCategoryBySlug,
} from '../../db/catalog/categoryRepository.js';
import { findListingsBySignal } from '../../db/discovery/discoveryReadRepository.js';
import { toProductSummaries } from '../catalog-hydration.service.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { activeSubtreeIds, pageDepthFor } from './feed.service.js';

/** `/discovery/signal`'s two valid scopes — `deals` has no per-signal shelves. */
export type DiscoverySignalScope = Exclude<DiscoveryScope, { kind: 'deals' }>;

export interface GetDiscoverySignalPageInput {
  signal: DiscoverySignal;
  scope: DiscoverySignalScope;
  limit: number;
  offset: number;
}

/**
 * One page of `signal`'s listings within `scope`, `limit + 1` rows requested
 * so `hasMore` is read off the query rather than computed — see this file's
 * own docblock.
 *
 * Throws `notFound` for an unknown or inactive `category:<handle>`, matching
 * `getDiscoveryFeed`'s own category scope.
 */
export async function getDiscoverySignalPage(
  input: GetDiscoverySignalPageInput,
): Promise<DiscoverySignalPage> {
  const allCategories = await findActiveCategories();

  let categoryIds: string[];
  let categoryHandle: string | undefined;
  let categoryName: string | undefined;

  if (input.scope.kind === 'root') {
    categoryIds = allCategories.map((category) => category.id);
  } else {
    const category = await findActiveCategoryBySlug(input.scope.handle);
    if (!category) {
      throw notFound('Category not found');
    }
    categoryIds = activeSubtreeIds(allCategories, category.id);
    categoryHandle = category.slug;
    categoryName = category.name;
  }

  const rows = await findListingsBySignal({
    signal: input.signal,
    categoryIds,
    limit: input.limit + 1,
    offset: input.offset,
  });
  const hasMore = rows.length > input.limit;
  const products = await toProductSummaries(hasMore ? rows.slice(0, input.limit) : rows);

  const page: DiscoverySignalPage = {
    signal: input.signal,
    scope: input.scope,
    pageDepth: pageDepthFor(input.signal),
    products,
    hasMore,
  };
  if (categoryHandle !== undefined) {
    page.categoryHandle = categoryHandle;
  }
  if (categoryName !== undefined) {
    page.categoryName = categoryName;
  }
  return page;
}
