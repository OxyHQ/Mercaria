/**
 * The walls around the canonical product page (#71), asserted STRUCTURALLY.
 *
 * The page composes six domains, which makes it the surface most likely to grow
 * a second copy of somebody else's rule — a local "cheapest" here, a currency
 * default there, a raw outbound link when #37 takes another month. Each wall
 * below is a scan or a type rather than a fixture, because "cannot" is a
 * stronger statement than "did not in this case":
 *
 *  1. **It does not RANK.** The only ranking module it may import is the
 *     published entry point, and no module in it sorts anything. A page that
 *     ordered offers would be a second ranking policy nobody versioned and no
 *     impression could be attributed to.
 *  2. **It cannot reach commercial standing** — fees, referrals, retail
 *     pricing, the ledger, a plan or a commission. #74's wall, applied to the
 *     surface that renders its output.
 *  3. **It never sends anybody anywhere.** No composed tracking URL, no
 *     redirect, and the outbound branch that would carry a destination is
 *     #37's to fill in.
 *  4. **It WRITES nothing.** A product page issuing an insert or an update is
 *     a read surface with a side effect, and the first one would be a save, a
 *     click record or an impression row that belongs to a domain that owns it.
 *  5. **It names no currency.** The display default is a product policy stated
 *     in `user-preference.service`; a page reaching for it would make the
 *     default a page fact and put two answers in front of one shopper.
 *  6. **The STOREFRONT cannot open an external offer either.** The one file
 *     that could make this mistake is a client file, and the storefront has no
 *     test runner — the #92 precedent: scan the other package from here.
 *
 * Every scanner carries the metro-gate defences: a vacuity floor so a moved
 * file fails the gate instead of silently shrinking it, and a mutation
 * self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOMAIN_DIR = join(SRC_ROOT, 'services/product-page');
/** `packages/`, from `packages/backend/src`. */
const PACKAGES_ROOT = join(SRC_ROOT, '..', '..');
const STOREFRONT_ROOT = join(PACKAGES_ROOT, 'frontend');

/** Every non-test module in the domain, read from the real directory. */
function domainSources(): { relative: string; source: string }[] {
  return readdirSync(DOMAIN_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) => statSync(join(DOMAIN_DIR, entry)).isFile())
    .map((entry) => ({
      relative: `services/product-page/${entry}`,
      source: readFileSync(join(DOMAIN_DIR, entry), 'utf8'),
    }));
}

/** The rest of the surface — the pieces that live outside the domain directory. */
const OUTER_PATHS = [
  'db/productPage/productPageRepository.ts',
  'controllers/product-page.controller.ts',
  'routes/product-page.ts',
  'middleware/product-page-schemas.ts',
];

function outerSources(): { relative: string; source: string }[] {
  return OUTER_PATHS.map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * The storefront files this issue owns.
 *
 * Named explicitly rather than globbed: a glob over the app would scan every
 * screen and turn a wall about ONE page into a repository-wide style rule
 * somebody disables the first time it fires elsewhere.
 */
const STOREFRONT_PATHS = [
  'app/(app)/p/[handle].tsx',
  'components/product/OfferRow.tsx',
  'components/product/OfferGroups.tsx',
  'components/product/ProductIdentity.tsx',
  'components/product/VariantSelector.tsx',
  'components/product/BrandChannels.tsx',
  'components/product/PriceHistoryPanel.tsx',
  'lib/api/product-page.ts',
  'lib/hooks/use-product-page.ts',
];

/**
 * The files WALL 6 checks navigation targets in.
 *
 * #71's own files, PLUS the listing page — which this issue does not own, and
 * on which it added exactly one thing: the entry point into the canonical page.
 * That link is held to the same route gate as the page's own, and to NOTHING
 * else. Putting a file this issue does not own through the other five walls is
 * how a gate starts crying wolf at whoever edits it next, and a gate that cries
 * wolf is the one somebody deletes.
 */
const NAVIGATION_PATHS = [...STOREFRONT_PATHS, 'app/(app)/products/[id].tsx'];

function storefrontSources(): { relative: string; source: string }[] {
  return STOREFRONT_PATHS.map((relative) => ({
    relative,
    source: readFileSync(join(STOREFRONT_ROOT, relative), 'utf8'),
  }));
}

/** Comment-stripped source: these modules DOCUMENT what they refuse to do. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Reaching a ranking INTERNAL.
 *
 * `comparison.service` is the published entry point #74 names and is
 * deliberately absent from this pattern; every other module in that domain is
 * an internal whose import would mean this page had started to score, admit or
 * label something itself.
 */
const RANKING_INTERNAL_REFERENCE =
  /ranking\/(ranking|labels|eligibility|facts|policy\.service|dominance|money|seams)\b/;

/** Ordering something. The page renders an order; it never produces one. */
const ORDERING_REFERENCE = /\.sort\(|localeCompare\(|\borderBy\(/;

/** #74's own commercial detector, verbatim — the same prohibition, one layer up. */
const COMMERCIAL_REFERENCE =
  /\bfees\/|\breferrals\/|\bretail-pricing\/|\bledger|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|referralProgram|referral_programs|retailCostQuote|retail_cost_quotes|subscription|merchantPlan|commissionRate|affiliate_commission/;

/** Composing an outbound destination, or performing one. */
const OUTBOUND_COMPOSITION_REFERENCE =
  /trackingTemplate|awin1\.com|\bepn\b|campaignId|res\.redirect|Linking\.openURL|window\.open|WebBrowser\.open/;

/** Writing. A read surface that writes is a read surface with a side effect. */
const WRITE_REFERENCE = /\.insert\(|\.update\(|\.delete\(|INSERT INTO|UPDATE \w+ SET|DELETE FROM/;

/** Naming a currency — the display default belongs to `user-preference.service`. */
const CURRENCY_NAME_REFERENCE = /\bFAIR\b|FairCoin|faircoin|OxyPay|oxy_pay|oxyPay/;

/** Reaching an offer's checkout ids around the outbound union. */
const OFFER_ID_BYPASS_REFERENCE = /offer\.(productVariantId|listingId)|offer\.destinationUrl/;

describe('the product-page surface exists — the vacuity floor', () => {
  it('scans a domain that exists and is not empty', () => {
    const domain = domainSources();
    // A renamed directory or a moved module must fail HERE rather than make
    // every scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(5);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
    for (const file of outerSources()) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('scans the storefront files this issue owns', () => {
    for (const relative of STOREFRONT_PATHS) {
      const absolute = join(STOREFRONT_ROOT, relative);
      expect(existsSync(absolute), `${relative} is missing — did the page move?`).toBe(true);
    }
    const files = storefrontSources();
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });
});

describe('WALL 1: the page consumes a ranking and never produces one', () => {
  it('imports only the published entry point, and orders nothing', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      const source = withoutComments(file.source);
      expect(
        RANKING_INTERNAL_REFERENCE.test(source),
        `${file.relative} reaches a ranking internal; the entry point is ` +
          'services/ranking/comparison.service.js and nothing else',
      ).toBe(false);
      expect(
        ORDERING_REFERENCE.test(source),
        `${file.relative} orders something; a second ordering is a second ranking policy`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(9);
  });

  it('the ranking and ordering detectors actually detect — the mutation self-test', () => {
    expect(RANKING_INTERNAL_REFERENCE.test("import { rankOffers } from '../ranking/ranking.js';")).toBe(true);
    expect(
      RANKING_INTERNAL_REFERENCE.test("import { awardComparisonLabels } from '../ranking/labels.js';"),
    ).toBe(true);
    expect(
      RANKING_INTERNAL_REFERENCE.test("import { selectEligibleOffers } from '../ranking/eligibility.js';"),
    ).toBe(true);
    // The published entry point is what the page DOES import, and must pass.
    expect(
      RANKING_INTERNAL_REFERENCE.test("import { rankOfferComparison } from '../ranking/comparison.service.js';"),
    ).toBe(false);
    expect(ORDERING_REFERENCE.test('rows.sort((a, b) => a.price - b.price)')).toBe(true);
    expect(ORDERING_REFERENCE.test('names.localeCompare(other)')).toBe(true);
    expect(ORDERING_REFERENCE.test('const rows = comparison.offers;')).toBe(false);
  });
});

describe('WALL 2: the page cannot read commercial standing', () => {
  it('no module references a fee, a referral, a plan or a margin', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources(), ...storefrontSources()]) {
      expect(
        COMMERCIAL_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches commercial standing; a page that can read what a merchant ` +
          'pays is a page whose order can be sold',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(18);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planConnectedMarketplaceFee } from '../fees/order-fees.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { attribute } from '../referrals/attribution.service.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const commissionRate = 0.1;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });
});

describe('WALL 3: the page never sends anybody anywhere', () => {
  it('composes no tracked destination and performs no redirect', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources(), ...storefrontSources()]) {
      expect(
        OUTBOUND_COMPOSITION_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} composes or performs an outbound handoff; #37 owns the redirect and ` +
          'the freshness re-check it runs before one',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(18);
  });

  it('the storefront never reaches an offer id around the outbound union', () => {
    for (const file of storefrontSources()) {
      expect(
        OFFER_ID_BYPASS_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reads a checkout id or a destination off the offer; the row's action ` +
          'is `outbound`, whose external branches carry neither',
      ).toBe(false);
    }
  });

  it('the outbound detectors actually detect — the mutation self-test', () => {
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('const url = `${trackingTemplate}`;')).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test("res.redirect(302, destination)")).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('Linking.openURL(offer.destinationUrl)')).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('window.open(url)')).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('const host = parsed.hostname;')).toBe(false);
    expect(OFFER_ID_BYPASS_REFERENCE.test('addToCart(offer.productVariantId)')).toBe(true);
    expect(OFFER_ID_BYPASS_REFERENCE.test('href={offer.destinationUrl}')).toBe(true);
    expect(OFFER_ID_BYPASS_REFERENCE.test('addToCart(row.outbound.productVariantId)')).toBe(false);
  });
});

describe('WALL 4: the page writes nothing', () => {
  it('no module in the domain or its repository issues a write', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      expect(
        WRITE_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} writes; a product page is a read, and every action it offers belongs ` +
          'to a domain that owns the rules for it',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(9);
  });

  it('the write detector actually detects — the mutation self-test', () => {
    expect(WRITE_REFERENCE.test('await db.insert(offers).values({})')).toBe(true);
    expect(WRITE_REFERENCE.test('await db.update(listings).set({})')).toBe(true);
    expect(WRITE_REFERENCE.test('await db.delete(offers)')).toBe(true);
    expect(WRITE_REFERENCE.test('const rows = await db.select().from(merchants)')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* WALL 6: every route the page navigates to EXISTS                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * `typedRoutes` is ON in this app and INERT on this expo-router major
 * (`~/Oxy/AGENTS.md`): `router.push('/definitely-not-a-route')` type-checks
 * clean, ships, and fails under a shopper's thumb as "This screen does not
 * exist". This issue hit it — a "Report a problem" control pointed at
 * `/settings/support`, which is not a screen — so the gate is here rather than
 * in a note somebody reads afterwards.
 *
 * Mention's `settingsRouteTargets.test.ts` is the shape being followed, scoped
 * to the files #71 owns for its reason: a repository-wide version would need
 * real false-positive handling for dynamic segments before anybody could trust
 * it, and a gate that cries wolf is a gate the next person disables.
 */
const APP_ROOT = join(STOREFRONT_ROOT, 'app');

/** Every route the real `app/` tree serves, as `/`-joined segment patterns. */
function existingRoutes(): string[] {
  const routes: string[] = [];
  const walk = (directory: string, segments: string[]): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        // A `(group)` is transparent in the URL — the whole point of the
        // convention, and the thing a naive path check gets wrong.
        walk(absolute, entry.startsWith('(') ? segments : [...segments, entry]);
        continue;
      }
      if (!entry.endsWith('.tsx') || entry.startsWith('_') || entry.startsWith('+')) continue;
      const name = entry.replace(/\.tsx$/u, '');
      routes.push(`/${(name === 'index' ? segments : [...segments, name]).join('/')}`);
    }
  };
  walk(APP_ROOT, []);
  return routes;
}

/** Does one navigation target resolve against a route pattern? */
function routeExists(target: string, routes: readonly string[]): boolean {
  const wanted = target.split('/').filter((segment) => segment !== '');
  return routes.some((route) => {
    const pattern = route.split('/').filter((segment) => segment !== '');
    if (pattern.length !== wanted.length) return false;
    return pattern.every((segment, index) => {
      // A `[param]` matches anything, and so does an interpolated segment on
      // the calling side — a value nobody can check statically.
      if (segment.startsWith('[')) return true;
      const actual = wanted[index] ?? '';
      return actual.includes('${') ? true : segment === actual;
    });
  });
}

/** Every literal `router.push`/`router.replace` target in the page's files. */
function navigationTargets(): { relative: string; target: string }[] {
  const found: { relative: string; target: string }[] = [];
  const sources = NAVIGATION_PATHS.map((relative) => ({
    relative,
    source: readFileSync(join(STOREFRONT_ROOT, relative), 'utf8'),
  }));
  for (const file of sources) {
    const source = withoutComments(file.source);
    for (const match of source.matchAll(/router\.(?:push|replace)\(\s*[`'"]([^`'"]+)[`'"]/gu)) {
      const target = match[1];
      if (target === undefined || !target.startsWith('/')) continue;
      found.push({ relative: file.relative, target });
    }
  }
  return found;
}

describe('WALL 6: every route this page navigates to exists', () => {
  it('resolves every literal navigation target against the real app tree', () => {
    const routes = existingRoutes();
    // Floors on BOTH sides: an empty route list would pass nothing, and an
    // empty target list would pass vacuously.
    expect(routes.length, 'the app tree walk found nothing').toBeGreaterThanOrEqual(15);
    const targets = navigationTargets();
    expect(targets.length, 'no navigation target was extracted').toBeGreaterThanOrEqual(6);

    for (const { relative, target } of targets) {
      expect(
        routeExists(target, routes),
        `${relative} navigates to ${target}, which is not a screen — typedRoutes is inert, ` +
          'so nothing else would catch this before a shopper did',
      ).toBe(true);
    }
  });

  it('the resolver actually resolves — the mutation self-test', () => {
    const routes = existingRoutes();
    expect(routeExists('/settings/feedback', routes)).toBe(true);
    expect(routeExists('/products/${id}', routes)).toBe(true);
    expect(routeExists('/sellers/${oxyUserId}', routes)).toBe(true);
    // The three this issue deliberately does NOT link to, and the one that
    // caused the bug. If any of these starts resolving, the page can link to it.
    expect(routeExists('/settings/support', routes)).toBe(false);
    expect(routeExists('/merchants/${slug}', routes)).toBe(false);
    expect(routeExists('/brands/${id}', routes)).toBe(false);
    expect(routeExists('/definitely-not-a-route-xyz', routes)).toBe(false);
  });
});

describe('WALL 5: the page names no currency', () => {
  it('no module names FAIR, FairCoin or OxyPay', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      // RAW source, comments included: a currency named in a comment here is a
      // default somebody is one edit from reaching for.
      expect(
        CURRENCY_NAME_REFERENCE.test(file.source),
        `${file.relative} names a currency; the display default is stated in ` +
          'services/user-preference.service.ts and nowhere else',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(9);
  });

  it('the currency detector actually detects — the mutation self-test', () => {
    expect(CURRENCY_NAME_REFERENCE.test("const currency = 'FAIR';")).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test('// FairCoin is the default')).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test("const currency = request.comparisonCurrency;")).toBe(false);
  });
});
