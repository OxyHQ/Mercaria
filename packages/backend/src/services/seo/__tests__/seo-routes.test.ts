/**
 * The route registry, gated against the REAL storefront (#75 §"Route plan").
 *
 * The registry is a hand-maintained map, and `~/Oxy/AGENTS.md`'s rule about
 * those is the whole design of this file: **a gate that SKIPS what is missing
 * from a hand-maintained map is not a gate.** So it fails in three directions:
 *
 *  1. A route marked `live` whose screen file does not exist — the registry
 *     promising a page nobody built.
 *  2. A screen file that no route mentions and no explicit not-applicable list
 *     excuses — a new public page nobody decided the SEO posture for.
 *  3. A route marked `planned` whose screen HAS shipped — the registry gone
 *     stale in the permissive direction, which is how a live page ends up
 *     unindexable and out of every sitemap with nothing saying so.
 *
 * Direction 3 is the one that fires on somebody else's pull request, and that
 * is intended: #72 and #73 add `/brands/:handle`, `/families/:handle` and
 * `/merchants/:handle`, and flipping two `availability` fields is the whole of
 * what they owe this domain. `product-page-isolation.test.ts` already sets the
 * precedent — it asserts those routes do NOT resolve today.
 *
 * `typedRoutes` is ON in this app and INERT on this expo-router major
 * (`~/Oxy/AGENTS.md`), so nothing else catches a route pattern that names no
 * screen: a bogus `Href` type-checks clean, ships, and fails under a shopper's
 * thumb.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ROUTE_IDS } from '@mercaria/shared-types';
import { buildRoutePath, matchPublicRoute, publicRoute, PUBLIC_ROUTES, routeIsLive } from '../routes.js';

/** `packages/backend/src`, from `packages/backend/src/services/seo/__tests__`. */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STOREFRONT_ROOT = join(SRC_ROOT, '..', '..', 'frontend');
const APP_ROOT = join(STOREFRONT_ROOT, 'app');

/**
 * Every storefront screen that is deliberately NOT a public route, with the
 * reason implied by its group.
 *
 * The account funnel, the commerce funnel and the guest portal: private,
 * transactional, or reached only from a credential. Every one of them is also
 * in `SEO_ROBOTS_DISALLOWED_PATHS`, and `seo-robots.test.ts` is what keeps that
 * true. Being in NEITHER this list nor the registry is what FAILS.
 */
const NON_PUBLIC_SCREENS: readonly string[] = [
  'app/(app)/forgot-password.tsx',
  'app/(app)/reset-password.tsx',
  'app/(app)/notifications.tsx',
  'app/(app)/price-alerts.tsx',
  // Saved shopping agents (#97) — one account's own standing instructions and
  // the timeline of what they observed. Account-private by construction: every
  // route behind it is owner-scoped in the statement, so a crawler would see
  // a sign-in page and an indexed one would advertise a surface nobody
  // anonymous can reach.
  'app/(app)/shopping-agents.tsx',
  'app/(app)/cart.tsx',
  'app/(app)/saved.tsx',
  // Internal search (#70/#95) — infinite, thin and duplicative of the browse
  // pages by construction, which is why `/search` is in
  // `SEO_ROBOTS_DISALLOWED_PATHS`. A crawlable one is a crawl budget spent on
  // result pages nobody links to.
  'app/(app)/search.tsx',
  // Grounded comparison (#96) — `?p=<handles>` is a shopper-assembled
  // COMBINATION, which is the page class #75's policy rule 8 refuses to index
  // by the combination, and `?watchlist=` can name a PRIVATE #81 list. A
  // crawlable one would spend budget on arbitrary tuples and fetch somebody's
  // private list id.
  'app/(app)/compare.tsx',
  // #81's watchlists are PRIVATE to one account — the domain stores no public
  // projection of one at all.
  'app/(app)/watchlists/index.tsx',
  'app/(app)/watchlists/[watchlistId].tsx',
  // Collect in person (#93) — the results depend entirely on an origin the
  // shopper supplies, so there is one page per canonical entity per POSITION
  // and a crawler has no position. Everything it shows is reachable from the
  // product page that links to it, which is where the indexable content is.
  // Correspondingly in `SEO_ROBOTS_DISALLOWED_PATHS`.
  'app/(app)/nearby.tsx',
  'app/(app)/checkout/index.tsx',
  'app/(app)/checkout/return.tsx',
  // The "Sell yours" flow (#91) — an authenticated draft-in-progress, reached
  // only from a credential, and never a landing page a crawler should index.
  'app/(app)/sell/index.tsx',
  'app/(app)/sell/[draftId].tsx',
  'app/(app)/guest-orders/claim.tsx',
  'app/(app)/guest-orders/recover.tsx',
  'app/(app)/guest-orders/portal.tsx',
  'app/(app)/orders/index.tsx',
  'app/(app)/orders/[id].tsx',
  'app/(app)/settings/index.tsx',
  'app/(app)/settings/general.tsx',
  'app/(app)/settings/addresses.tsx',
  'app/(app)/settings/feedback.tsx',
];

interface Screen {
  /** Relative to `packages/frontend`. */
  readonly file: string;
  /** The URL pattern expo-router serves it at, `[param]` segments intact. */
  readonly pattern: string;
}

/**
 * Every screen the real `app/` tree serves.
 *
 * A `(group)` directory is transparent in the URL — the whole point of the
 * convention, and the thing a naive path check gets wrong. Files beginning `_`
 * or `+` are layouts and specials, not screens.
 */
function screens(): Screen[] {
  const found: Screen[] = [];
  const walk = (directory: string, relative: string, segments: string[]): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const relativeEntry = `${relative}/${entry}`;
      if (statSync(absolute).isDirectory()) {
        walk(absolute, relativeEntry, entry.startsWith('(') ? segments : [...segments, entry]);
        continue;
      }
      if (!entry.endsWith('.tsx') || entry.startsWith('_') || entry.startsWith('+')) continue;
      const name = entry.replace(/\.tsx$/u, '');
      const parts = name === 'index' ? segments : [...segments, name];
      found.push({ file: relativeEntry, pattern: `/${parts.join('/')}` });
    }
  };
  walk(APP_ROOT, 'app', []);
  return found;
}

/** Do a screen's URL pattern and a registry pattern address the same route? */
function patternsMatch(screenPattern: string, routePattern: string): boolean {
  const left = screenPattern.split('/').filter((segment) => segment !== '');
  const right = routePattern.split('/').filter((segment) => segment !== '');
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index] ?? '';
    const leftDynamic = segment.startsWith('[');
    const rightDynamic = other.startsWith(':');
    if (leftDynamic || rightDynamic) return leftDynamic && rightDynamic;
    return segment === other;
  });
}

describe('the registry and the storefront exist — the vacuity floor', () => {
  it('walks a real app tree with real screens in it', () => {
    const found = screens();
    // A moved or renamed `app/` directory must fail HERE rather than make every
    // assertion below pass against an empty list.
    expect(found.length, 'the app tree walk found nothing').toBeGreaterThanOrEqual(20);
    expect(PUBLIC_ROUTES.length).toBe(PUBLIC_ROUTE_IDS.length);
    expect(PUBLIC_ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it('every not-applicable entry names a file that exists', () => {
    // The other half of the map: a deleted screen must not keep its excuse, or
    // the list slowly becomes a place to hide a route nobody re-examined.
    for (const file of NON_PUBLIC_SCREENS) {
      expect(existsSync(join(STOREFRONT_ROOT, file)), `${file} is excused but does not exist`).toBe(
        true,
      );
    }
  });
});

describe('DIRECTION 1: a live route has a screen behind it', () => {
  it('every `live` route names a file that exists', () => {
    let checked = 0;
    for (const route of PUBLIC_ROUTES) {
      if (route.availability !== 'live') {
        expect(route.screen, `${route.id} is not live and must name no screen`).toBeUndefined();
        continue;
      }
      expect(route.screen, `${route.id} is live and must name its screen`).toBeDefined();
      const screen = route.screen ?? '';
      expect(
        existsSync(join(STOREFRONT_ROOT, screen)),
        `${route.id} is live but ${screen} does not exist`,
      ).toBe(true);
      checked += 1;
    }
    expect(checked, 'no live route was checked').toBeGreaterThanOrEqual(5);
  });

  it("a live route's screen serves the pattern the registry records", () => {
    const byFile = new Map(screens().map((screen) => [screen.file, screen.pattern]));
    for (const route of PUBLIC_ROUTES) {
      if (route.availability !== 'live') continue;
      const pattern = byFile.get(route.screen ?? '');
      expect(pattern, `${route.screen} is not a screen expo-router serves`).toBeDefined();
      expect(
        patternsMatch(pattern ?? '', route.pattern),
        `${route.id} records ${route.pattern} but its screen serves ${String(pattern)}`,
      ).toBe(true);
    }
  });
});

describe('DIRECTION 2: every screen is mapped or explicitly excused', () => {
  it('no screen is in neither the registry nor the not-applicable list', () => {
    const mapped = new Set(
      PUBLIC_ROUTES.map((route) => route.screen).filter(
        (screen): screen is string => screen !== undefined,
      ),
    );
    const excused = new Set(NON_PUBLIC_SCREENS);
    const unclassified = screens()
      .map((screen) => screen.file)
      .filter((file) => !mapped.has(file) && !excused.has(file));

    expect(
      unclassified,
      'a storefront screen is in neither the route registry nor NON_PUBLIC_SCREENS. ' +
        'Decide whether it is a public route (add a row) or is not (add it to the list) — ' +
        'being in neither is what this gate exists to refuse.',
    ).toEqual([]);
  });
});

describe('DIRECTION 3: a planned route has NOT quietly shipped', () => {
  it('no `planned` or `redirect_only` pattern is served by a real screen', () => {
    const patterns = screens().map((screen) => screen.pattern);
    let checked = 0;
    for (const route of PUBLIC_ROUTES) {
      if (route.availability === 'live') continue;
      const served = patterns.some((pattern) => patternsMatch(pattern, route.pattern));
      expect(
        served,
        `${route.id} (${route.pattern}) is marked '${route.availability}' but a screen now ` +
          "serves it. Flip its `availability` to 'live' and give it a `screen` — until then " +
          'the page is unindexable and absent from every sitemap.',
      ).toBe(false);
      checked += 1;
    }
    // Floor DOWN from 3 to 2 with #72: `product_family` and `brand` flipped to
    // `live` in the same change that shipped their screens, leaving
    // `category_browse` (`planned`) and `native_store_legacy` (`redirect_only`)
    // — a floor that could never drop would forbid exactly that flip.
    expect(checked, 'no non-live route was checked').toBeGreaterThanOrEqual(2);
  });
});

describe('matching a path against the registry', () => {
  it('resolves each live pattern and reports its segment', () => {
    expect(matchPublicRoute('/')?.route.id).toBe('home');
    expect(matchPublicRoute('/p/iphone-16-pro')).toEqual({
      route: publicRoute('canonical_product'),
      handle: 'iphone-16-pro',
    });
    expect(matchPublicRoute('/products/abc123')?.route.id).toBe('legacy_listing');
    expect(matchPublicRoute('/stores/acme')?.route.id).toBe('native_store');
    expect(matchPublicRoute('/m/acme')?.route.id).toBe('native_store_legacy');
    expect(matchPublicRoute('/sellers/oxy-user-1')?.route.id).toBe('seller');
  });

  it('decodes the segment, and refuses one that cannot be decoded', () => {
    expect(matchPublicRoute('/p/caf%C3%A9')?.handle).toBe('café');
    // A malformed escape is a malformed request, not a route. Matching it
    // against a pattern would mean resolving bytes nobody can read.
    expect(matchPublicRoute('/p/%E0%A4%A')).toBeUndefined();
  });

  it('matches nothing outside the registry', () => {
    expect(matchPublicRoute('/cart')).toBeUndefined();
    expect(matchPublicRoute('/settings/general')).toBeUndefined();
    expect(matchPublicRoute('/p')).toBeUndefined();
    expect(matchPublicRoute('/p/a/b')).toBeUndefined();
    expect(matchPublicRoute('not-a-path')).toBeUndefined();
  });

  it('no two patterns can match one path — the first match is the only match', () => {
    // The property `matchPublicRoute` relies on. It stops being true the day
    // somebody adds `/p/compare` beside `/p/:handle`, and the failure would be
    // a page silently resolving as the wrong route.
    for (const probe of ['/', '/p/x', '/products/x', '/stores/x', '/m/x', '/sellers/x', '/brands/x', '/families/x', '/merchants/x', '/categories/x']) {
      const matches = PUBLIC_ROUTES.filter((route) => {
        const pattern = route.pattern.split('/').filter((segment) => segment !== '');
        const actual = probe.split('/').filter((segment) => segment !== '');
        if (pattern.length !== actual.length) return false;
        return pattern.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
      });
      expect(matches.length, `${probe} matches ${matches.length} patterns`).toBeLessThanOrEqual(1);
    }
  });
});

describe('composing a path', () => {
  it('is the ONE place a public path is built', () => {
    expect(buildRoutePath('home')).toBe('/');
    expect(buildRoutePath('canonical_product', 'iphone-16-pro')).toBe('/p/iphone-16-pro');
    expect(buildRoutePath('native_store', 'acme')).toBe('/stores/acme');
  });

  it('encodes a segment rather than emitting it raw', () => {
    expect(buildRoutePath('canonical_product', 'a/b')).toBe('/p/a%2Fb');
    expect(buildRoutePath('canonical_product', 'café')).toBe('/p/caf%C3%A9');
  });

  it('refuses a mismatch between the pattern and the arguments', () => {
    expect(() => buildRoutePath('canonical_product')).toThrow(/needs a segment/u);
    expect(() => buildRoutePath('home', 'x')).toThrow(/takes no segment/u);
  });
});

describe('liveness is read before a link is composed', () => {
  it('answers for the routes this domain links to', () => {
    expect(routeIsLive('home')).toBe(true);
    expect(routeIsLive('canonical_product')).toBe(true);
    // #73 shipped the merchant page, so this domain serves and sitemaps it.
    expect(routeIsLive('merchant')).toBe(true);
    // #72 has landed: the brand breadcrumb in `visible-facts.ts` now appears on
    // a canonical product page carrying a brand.
    expect(routeIsLive('brand')).toBe(true);
  });
});
