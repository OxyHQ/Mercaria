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
 * weaker instrument, and it carries a positive control and a self-test because
 * of it.
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
  '../../../app/(app)/categories/[handle].tsx',
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

/**
 * Every `<FacetRail` mount whose own JSX expression does not test the guard.
 *
 * Deliberately NOT line-based: the guard opens the conditional and the mount is
 * on the next line, so a per-line test reports every correct mount as a
 * violation. The unit is the JSX expression container — the text from the `{`
 * that opens it to the mount inside it — which is what actually decides whether
 * the mount renders.
 */
function unguardedFacetRailMounts(source: string): readonly string[] {
  const mounts: string[] = [];
  for (let at = source.indexOf('<FacetRail'); at !== -1; at = source.indexOf('<FacetRail', at + 1)) {
    const opener = source.lastIndexOf('{', at);
    const expression = opener === -1 ? source.slice(0, at) : source.slice(opener, at);
    if (!expression.includes('mayOfferFilters')) {
      mounts.push(expression.split('\n')[0].trim());
    }
  }
  return mounts;
}

describe('the screen does not mount a rail it has not gated', () => {
  const source = readFileSync(CATEGORY_SCREEN, 'utf8');

  /**
   * The vacuity floor. An absence assertion over a file that was not read, was
   * renamed, or no longer renders a grid at all reports exactly what a correct
   * one reports, so the subject is asserted PRESENT first.
   */
  it('is reading the category screen, which still renders a listings grid', () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain('useListings(');
    expect(source).toContain('<FacetRail');
  });

  it('consults the consumption derivation', () => {
    expect(source).toContain('mayOfferFacetRail');
    expect(source).toContain('deriveCategoryGridFacetConsumption');
  });

  it('gates every mount on it', () => {
    expect(unguardedFacetRailMounts(source)).toEqual([]);
  });

  /**
   * The self-test. `unguardedFacetRailMounts` returning `[]` is also what a
   * detector that matches nothing returns, so it is run against the shape it
   * exists to catch — the pre-#637 line, which mounted the rail on the facet
   * response alone.
   */
  it('detects an ungated mount', () => {
    const regressed = [
      '{facets.data === undefined ? null : (',
      '  <FacetRail',
      '    response={facets.data}',
      '  />',
      ')}',
    ].join('\n');
    expect(unguardedFacetRailMounts(regressed)).toEqual([
      '{facets.data === undefined ? null : (',
    ]);
  });
});
