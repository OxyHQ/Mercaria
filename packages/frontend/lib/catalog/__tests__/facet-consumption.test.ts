import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LISTING_GRID_CARRIES_ATTRIBUTE_FILTER,
  deriveCategoryGridFacetConsumption,
  mayOfferFacetRail,
} from '../facet-consumption';

/**
 * #637 — the category page offered a facet rail its grid could not act on.
 *
 * ## Two halves, and only one of them can be behavioural
 *
 * The DERIVATION is asserted by running it, which is what the first block does.
 * Whether the SCREEN consults it cannot be: this runner is `lib/**`, node, no
 * renderer, and mounting the screen fails at `react-native/index.js` with
 * `Parse failure: Expected 'from', got 'typeOf'` — measured on this branch, and
 * the standing #469 decision recorded in `vitest.config.ts`. That config's own
 * rule is the one followed here: extract the logic rather than mount the
 * component. So the entrypoint half reads the screen's source, which is a
 * weaker instrument, and it carries a positive control because of it.
 *
 * ## The grid itself is gone, not just re-gated
 *
 * The discovery-feed redesign (`docs/superpowers/specs/2026-09-07-discovery-
 * feed-design.md`) replaced the manual `useListings` + `CategoryListingCard`
 * grid this screen used to render with the feed's own `products` sections,
 * which carry no facet-selection parameter at all. So the second block below
 * no longer asserts a GATED `<FacetRail` mount — there is no mount, gated or
 * not, and that is the stronger form of #637's fix: nothing left to gate.
 */

/**
 * Resolved from this file's own location rather than the working directory:
 * vitest's `root` does not move `process.cwd()`, so a cwd-relative path reads
 * whichever directory the runner happened to be launched from.
 *
 * `fileURLToPath` is given a STRING — passing a `URL` here collides with the
 * DOM `URL` the Expo tsconfig also has in scope, and the two are not assignable.
 */
const CATEGORY_SCREEN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../app/(app)/categories/[handle]/index.tsx',
);

describe('the category grid cannot act on a facet selection', () => {
  it('reports unsupported, naming the grid query as the reason', () => {
    expect(deriveCategoryGridFacetConsumption()).toEqual({
      kind: 'unsupported',
      reason: 'grid_query_carries_no_attribute_filter',
    });
  });

  it('refuses to offer a rail over it', () => {
    expect(mayOfferFacetRail(deriveCategoryGridFacetConsumption())).toBe(false);
  });

  /**
   * The premise the refusal rests on. This is a RUNTIME read of a constant
   * whose TYPE is derived from `ListingQuery`, so the compiler is the thing
   * that actually catches an attribute filter being added; this asserts the
   * constant is still the one the type gate annotates rather than a literal
   * somebody re-typed by hand.
   */
  it('rests on `ListingQuery` carrying no attribute filter', () => {
    expect(LISTING_GRID_CARRIES_ATTRIBUTE_FILTER).toBe(false);
  });
});

describe('the category screen mounts no facet rail at all', () => {
  const source = readFileSync(CATEGORY_SCREEN, 'utf8');

  /**
   * The vacuity floor. An absence assertion over a file that was not read or
   * was renamed reports exactly what a correct one reports, so the subject is
   * asserted PRESENT first — this screen still renders the discovery feed
   * body that replaced #637's grid.
   */
  it('is reading the category screen, which still renders the discovery feed', () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain('useDiscoveryFeed(');
    expect(source).toContain('<DiscoveryFeed');
  });

  /**
   * Not "gated" — ABSENT. The grid `FacetRail` used to sit over is gone, so a
   * mount here (gated or not) would be offering a rail over content that
   * cannot be selection-filtered by construction, which is the same defect
   * #637 fixed in a different shape.
   */
  it('mounts no facet rail and reads no facets', () => {
    expect(source).not.toContain('<FacetRail');
    expect(source).not.toContain('useFacets(');
  });
});
