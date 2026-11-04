/**
 * The SEO rollout lever (#75 acceptance 8: "route and SEO rollout is
 * feature-flagged and reversible") — the ONE place it is interpreted.
 *
 * ## One lever, `SEO_INDEXING_MODE`, and it also decides the mount
 *
 * `off` (the default) leaves the `/seo/*` routers UNMOUNTED: `/seo/*` answers
 * 404, the Cloudflare Worker's lookup fails and the worker serves the
 * storefront shell — no metadata injection, no redirects, the static
 * `robots.txt` and `sitemap.xml`. That is the blunt rollback, and it does not
 * depend on every handler having remembered its gate. Mounting the routers
 * with indexing off would instead make the worker serve the API's `noindex`
 * documents and an EMPTY sitemap, which is worse than the static floor — so
 * the mount follows the mode (see {@link seoRoutesMounted}).
 *
 * `canary` and `on` mount the routers and decide what may be INDEXED.
 *
 * ## `canary` with an empty list indexes NOTHING
 *
 * Half-configured is off. `SEO_CANARY_CATEGORY_IDS` empty under
 * `SEO_INDEXING_MODE=canary` is a deployment that named no canary, and the
 * fail-closed answer is the only safe one: a canary that leaked the whole
 * catalogue because somebody forgot a variable is not a canary. This is
 * deliberately the OPPOSITE of the `CHECKOUT_DESTINATION_COUNTRIES` /
 * `CANONICAL_READ_COHORTS` convention, where empty means "everything" —
 * because there the empty default preserves today's behaviour and here it would
 * publish a catalogue.
 *
 * ## The canary is a CATEGORY, not a percentage
 *
 * A hash bucket would have to be computed identically in TypeScript (for a
 * document) and in SQL (for a sitemap), and two implementations of one bucket
 * function is a drift waiting to happen. A category id is an `includes` on one
 * side and an `inArray` on the other, it is what an operator can actually
 * reason about ("we are indexing Electronics first"), and it reuses the cohort
 * vocabulary `CANONICAL_READ_COHORTS` already established.
 *
 * A brand, a merchant or a category page has no category of its own, so under
 * `canary` none of them is indexable. A canary indexes a slice of the
 * catalogue; widening it to whole entity types would make it the rollout.
 */

import { config } from '../../config/index.js';

/**
 * Whether the public `/seo/*` routers are mounted: iff `SEO_INDEXING_MODE` is
 * `canary` or `on`. See the module docblock for why `off` leaves them unmounted.
 */
export function seoRoutesMounted(): boolean {
  return config.seo.indexingMode !== 'off';
}

/**
 * May this entity be indexed right now?
 *
 * @param categoryId The entity's own category, or `null` when it has none.
 *   `null` is refused under `canary` — a canary that leaked the objects it
 *   could not classify is the failure `canonicalReadAllowedFor` documents.
 */
export function indexingPermittedFor(categoryId: string | null): boolean {
  switch (config.seo.indexingMode) {
    case 'on':
      return true;
    case 'canary':
      if (categoryId === null) return false;
      return config.seo.canaryCategoryIds.includes(categoryId);
    case 'off':
      return false;
  }
}
