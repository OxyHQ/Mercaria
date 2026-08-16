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
 * The files WALL 6 reads navigation targets out of.
 *
 * #71's own files, PLUS the listing page — which this issue does not own, and
 * on which it added exactly one thing: the entry point into the canonical page.
 * That link is held to WALL 6 and to NOTHING else. Putting a file this issue
 * does not own through the other five walls is how a gate starts crying wolf at
 * whoever edits it next, and a gate that cries wolf is the one somebody deletes.
 *
 * The list was wider than WALL 6 now needs — it was drawn when this wall
 * RESOLVED every target against the app tree, a job the compiler took over in
 * #330. It is kept as it is: the extra files cost one regex each, and narrowing
 * it to the two `#252` names would make the next identity decision look like it
 * needs a new list rather than a new assertion.
 */
const NAVIGATION_PATHS = [
  ...STOREFRONT_PATHS,
  'app/(app)/products/[id].tsx',
  // #93's collection surfaces. They join the ROUTE gate and nothing else, for
  // the reason above: the product page links to `/nearby`, `/nearby` links to
  // `/checkout`, and both compose a merchant link — four literal targets that
  // `typedRoutes` accepts however wrong they are. They are deliberately NOT in
  // `STOREFRONT_PATHS`, so the five walls about #71's page do not start firing
  // at whoever edits a pickup screen.
  'app/(app)/nearby.tsx',
  'components/nearby/NearbyAvailability.tsx',
  'components/nearby/NearbyOriginControl.tsx',
  // The two checkout screens, on the same terms as the listing page above: #93
  // added exactly one navigation target to each — a guest leaving checkout now
  // goes to #108's portal rather than the storefront — and that link is held to
  // the route gate and to nothing else.
  'app/(app)/checkout/index.tsx',
  'app/(app)/checkout/return.tsx',
];

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

/**
 * Composing an outbound destination — forbidden ANYWHERE on this page, still.
 *
 * `Linking.openURL` and its siblings MOVED OUT of this pattern when #67 landed;
 * see {@link OUTBOUND_HANDOFF_REFERENCE}. What stays here is naming a tracked
 * destination or performing a server redirect, neither of which this page may
 * ever do — the page carries a Mercaria PATH and a destination HOST, and the
 * real destination is resolved server-side at the moment of the click.
 */
const OUTBOUND_COMPOSITION_REFERENCE =
  /trackingTemplate|awin1\.com|\bepn\b|campaignId|res\.redirect/;

/**
 * PERFORMING a handoff — permitted only to a Mercaria path.
 *
 * Before #67 this sat in the pattern above, because `/out/:token` did not exist
 * and there was nowhere safe to send anybody. #67 built the redirect, so the
 * storefront now legitimately opens ONE thing: `outbound.redirectPath`, a
 * Mercaria path by TYPE, which the server resolves after revalidating the offer,
 * re-checking the source's rights and admitting the destination host.
 *
 * The wall is therefore CONDITIONAL rather than deleted: a line that opens
 * anything must also name `redirectPath`. Deleting it would have let a future
 * edit open `offer.destinationUrl` directly, which is the exact bug the wall was
 * written for and which #67 does not make safe.
 */
const OUTBOUND_HANDOFF_REFERENCE = /Linking\.openURL|window\.open|WebBrowser\.open/;

/** The ONE destination a handoff may name. */
const MERCARIA_REDIRECT_PATH_REFERENCE = /redirectPath/;

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
      const code = withoutComments(file.source);
      expect(
        OUTBOUND_COMPOSITION_REFERENCE.test(code),
        `${file.relative} composes a tracked destination or performs a redirect; #67 owns the ` +
          'redirect and the revalidation it runs before one',
      ).toBe(false);
      // A handoff is permitted, but only to a Mercaria path — see the detector.
      for (const line of code.split('\n')) {
        if (!OUTBOUND_HANDOFF_REFERENCE.test(line)) continue;
        expect(
          MERCARIA_REDIRECT_PATH_REFERENCE.test(line),
          `${file.relative} opens a destination that is not #67's Mercaria redirect path: ` +
            line.trim(),
        ).toBe(true);
      }
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(18);
  });

  it('the handoff detectors actually detect — the mutation self-test', () => {
    // Still forbidden outright.
    expect(OUTBOUND_COMPOSITION_REFERENCE.test('const u = offer.trackingTemplate;')).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test("res.redirect(302, target)")).toBe(true);
    expect(OUTBOUND_COMPOSITION_REFERENCE.test("const h = 'www.awin1.com';")).toBe(true);
    // The handoff detector fires on every opener...
    expect(OUTBOUND_HANDOFF_REFERENCE.test('void Linking.openURL(target);')).toBe(true);
    expect(OUTBOUND_HANDOFF_REFERENCE.test('window.open(target, "_blank");')).toBe(true);
    // ...and the allowance separates the Mercaria path from a merchant URL.
    expect(
      MERCARIA_REDIRECT_PATH_REFERENCE.test(
        'void Linking.openURL(`${config.apiUrl}${outbound.redirectPath}`);',
      ),
    ).toBe(true);
    expect(
      MERCARIA_REDIRECT_PATH_REFERENCE.test('void Linking.openURL(offer.destinationUrl);'),
    ).toBe(false);
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
    // These two MOVED to the conditional handoff rule when #67 landed. The
    // property they pin is unchanged and slightly stronger: opening a MERCHANT
    // url is still refused, now because the opener fires and the Mercaria
    // redirect path is absent from the line.
    expect(OUTBOUND_HANDOFF_REFERENCE.test('Linking.openURL(offer.destinationUrl)')).toBe(true);
    expect(
      MERCARIA_REDIRECT_PATH_REFERENCE.test('Linking.openURL(offer.destinationUrl)'),
    ).toBe(false);
    expect(OUTBOUND_HANDOFF_REFERENCE.test('window.open(url)')).toBe(true);
    expect(MERCARIA_REDIRECT_PATH_REFERENCE.test('window.open(url)')).toBe(false);
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
/* WALL 6: the page LINKS the identities #252 decided it should               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * This wall used to RESOLVE every literal navigation target against the real
 * `app/` tree, because `typedRoutes: true` was inert: `.expo/types/router.d.ts`
 * is gitignored and nothing generated it before `tsc`, so `Href` degraded to
 * `string` and `router.push('/definitely-not-a-route')` type-checked clean. It
 * caught a real one — a "Report a problem" control pointing at
 * `/settings/support`.
 *
 * #330 generates that declaration inside every app's `typecheck`, so the
 * COMPILER answers that question now, across all three apps rather than this
 * page's twenty files, and the resolution half was RETIRED rather than left
 * green for the wrong reason. Its own history is why: it read only the ARGUMENT
 * of `router.push`, so a route composed in a `buildHref` helper was invisible,
 * and an interpolated query string became one segment containing `${` that its
 * resolver read as a WILDCARD matching any two-segment route — both permissive,
 * both found the one day somebody looked closely. What the compiler cannot
 * check is that it was GIVEN the union, and that is now
 * `src/__tests__/typed-routes-armed.test.ts`.
 *
 * What survives here is the part that was never about route existence: WHICH
 * identity this page links. That is a product decision (#252) and no type can
 * hold it — a merchant rendered as plain text compiles perfectly.
 */
/**
 * Reduce a written target to its PATH: a query string is not part of the route,
 * and `#252` asks which route a file navigates to rather than with what.
 *
 * The cut happens only at a `?` in the LITERAL head. A `?` after the first `${`
 * is inside an interpolation — somebody's ternary — and cutting there truncates
 * a real path segment mid-expression.
 */
function routePathOf(target: string): string {
  const literalHead = target.split('${')[0] ?? '';
  return literalHead.includes('?') ? (literalHead.split('?')[0] ?? '') : target;
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
      found.push({ relative: file.relative, target: routePathOf(target) });
    }
  }
  return found;
}

describe('WALL 6: the page links the identities it decided to link', () => {
  it('#252: the page LINKS a merchant to the merchant page', () => {
    // The decision, pinned. #71 named every merchant as text for one recorded
    // reason — the route did not exist — and #73 shipped
    // `app/(app)/merchants/[idOrSlug].tsx`, so the reason expired and #252 made
    // it a link. Without this assertion the link is one refactor from silently
    // reverting to text, and nothing would notice: a name renders perfectly.
    //
    // Asserted on BOTH places the page names a merchant, because they were
    // deferred together and a fix to one is not a fix to the other.
    const byFile = new Map<string, string[]>();
    for (const { relative, target } of navigationTargets()) {
      byFile.set(relative, [...(byFile.get(relative) ?? []), target]);
    }
    for (const owner of ['components/product/OfferRow.tsx', 'components/product/BrandChannels.tsx']) {
      const targets = byFile.get(owner) ?? [];
      // A floor on what was extracted, so a file this walk stopped reading
      // fails here rather than passing by naming no targets at all.
      expect(targets.length, `no navigation target extracted from ${owner}`).toBeGreaterThan(0);
      expect(
        targets.some((target) => target.startsWith('/merchants/')),
        `${owner} names a merchant but navigates nowhere for it; #252 decided ` +
          'that identity links to /merchants/[idOrSlug]',
      ).toBe(true);
    }
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
