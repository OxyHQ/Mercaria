/**
 * The SEO rollout levers (#75 acceptance 8: "route and SEO rollout is
 * feature-flagged and reversible") — the ONE place the flags are interpreted.
 *
 * ## Two levers, because they bound different blast radii
 *
 * `SEO_ROUTES_ENABLED` mounts the routers at all. Off, `/seo/*` answers 404,
 * the Cloudflare Worker's lookup fails and the worker serves the storefront
 * shell exactly as it does today — no metadata injection, no redirects, the
 * static `robots.txt` and `sitemap.xml`. That is the blunt rollback, and it
 * does not depend on every handler having remembered its gate.
 *
 * `SEO_INDEXING_MODE` decides whether anything may be INDEXED, and it is
 * separate because the two decisions are genuinely different. Correct titles,
 * a correct canonical tag and a correct sharing card are worth having before
 * anybody invites a crawler in; a deployment can serve all three with
 * `SEO_INDEXING_MODE=off` and every page will say `noindex` and every sitemap
 * will be empty. Turning indexing off during an incident therefore does not
 * take link previews down with it — the `CANONICAL_READS` /
 * `CANONICAL_OFFER_COMPARISON` split, applied to this domain.
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
