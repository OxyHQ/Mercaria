import type { DiscoverySignal } from '@mercaria/shared-types';

/**
 * The i18n key for each shelf's heading.
 *
 * The server sends a `signal` and a scope, never a composed sentence — the
 * client owns the sentence so it can be translated
 * (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`, "i18n").
 *
 * A `Record<DiscoverySignal, string>` rather than a `switch` with a
 * `default`: exhaustiveness is then the compiler's job, so a sixth signal
 * added to the closed set fails to compile here instead of silently falling
 * through to a default and rendering a raw `discovery.shelf.undefined` on a
 * live shelf.
 */
const SECTION_TITLE_KEYS: Record<DiscoverySignal, string> = {
  'top-rated': 'discovery.shelf.topRated',
  new: 'discovery.shelf.new',
  'on-sale': 'discovery.shelf.onSale',
  'best-selling': 'discovery.shelf.bestSelling',
  'most-viewed': 'discovery.shelf.mostViewed',
};

/** The i18n key for a shelf built on `signal`. */
export function sectionTitleKey(signal: DiscoverySignal): string {
  return SECTION_TITLE_KEYS[signal];
}

/** The interpolation params every shelf title takes: the category it names. */
export function sectionTitleParams(categoryName: string): { category: string } {
  return { category: categoryName };
}
