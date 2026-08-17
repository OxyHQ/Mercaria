/**
 * The walls around the offer domain (#57), asserted STRUCTURALLY.
 *
 * Four separate properties, and each one is a scan rather than a fixture,
 * because "cannot" is a stronger statement than "did not in this case":
 *
 * 1. **An external offer cannot enter the cart.** No cart or checkout module may
 *    reach the offer domain, and — the direction that actually matters — the
 *    schema makes `product_variant_id` NULL on every non-native kind, so there
 *    is no id a cart line could hold even if somebody wired one.
 * 2. **The offer domain does not do #58's, #37's, #84's or #74's jobs.** No
 *    module here may resolve a canonical match, perform an outbound redirect,
 *    link a merchant to a native store, or rank anything. Each is another
 *    issue's, and a seam that quietly grew one would be discovered by whoever
 *    then had to build it twice.
 * 3. **The offer domain cannot rewrite canonical facts** (issue external rule
 *    5). It imports no canonical WRITE service, so a source updating a price
 *    has no path to a product's name.
 * 4. **It reads exactly one thing from the payment domain**, and that thing is
 *    the readiness seam. Reaching the money path from a catalogue projection
 *    would put a charge behind a comparison read.
 *
 * The scanner follows the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor, so a moved file fails the gate instead of silently shrinking it, and a
 * mutation self-test, so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every `.ts` under `relative`, recursively, excluding the test tree. */
function walk(relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/** The flat directories every domain's HTTP surface shares. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware'] as const;

/** Every offer-NAMED module in a shared flat directory, whoever owns it. */
function offerNamedSharedModules(): string[] {
  return SHARED_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .filter((entry) => /offer/i.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`),
  );
}

/**
 * Offer-NAMED shared modules that belong to ANOTHER domain — the scope
 * judgement, made explicitly rather than by silence.
 *
 * `offer` in a filename says what the module is ABOUT, not which wall it lives
 * behind, and four issues have shipped an offer-named surface. The line drawn
 * here is the import graph, which is a fact rather than a preference: none of
 * the six below imports anything under `services/offers/` or `db/offers/`, and
 * each imports its own domain instead — `offer-comparison` reaches
 * `services/ranking/comparison.service.js`, the three freshness modules reach
 * `services/offer-freshness/` and `db/offerFreshness/`, and `retail-offers`
 * reaches `services/commercial-presentation/retail-offer.service.js`.
 *
 * Scoping them IN would be worse than leaving them out, and not by a little:
 * `offer-comparison` exists to RANK, so #57's ranking wall would fail on it for
 * a correct reason, and the cheapest way to green that is to delete the ranking
 * wall — a gate that pushes you toward the hazard.
 *
 * Each entry therefore carries the assertion that JUSTIFIES it rather than a
 * sentence: the module must still reach its own domain and must still NOT reach
 * this one. That is checked below against the real imports, so a shared module
 * that starts importing `services/offers/` stops being excludable and this gate
 * says which. An excuse re-read from prose is how a module ends up behind no
 * wall at all while two gates each assume the other has it — and pointing at a
 * sibling gate's file would not have fixed that, since a sibling that walks its
 * own directories names no path for this one to look for.
 *
 * A request-schema module imports only `zod` and `@mercaria/shared-types`, so
 * it has no downward edge to measure and its `reaches` is empty — only the
 * second half of the assertion applies to it. That is stated rather than
 * papered over with a plausible-looking target: `offer-freshness-schemas.ts` is
 * an inert leaf, and the wall that has to hold for it is #68's, which now
 * covers it.
 */
const SIBLING_DOMAIN_MODULES = [
  {
    path: 'routes/offer-comparison.ts',
    owner: "#74's ranking",
    reaches: ['controllers/offer-comparison.controller.js', 'middleware/ranking-schemas.js'],
  },
  {
    path: 'controllers/offer-comparison.controller.ts',
    owner: "#74's ranking",
    reaches: ['services/ranking/'],
  },
  {
    path: 'routes/internal-offer-freshness.ts',
    owner: "#68's freshness",
    reaches: ['controllers/offer-freshness-operator.controller.js'],
  },
  {
    path: 'controllers/offer-freshness-operator.controller.ts',
    owner: "#68's freshness",
    reaches: ['services/offer-freshness/', 'db/offerFreshness/'],
  },
  {
    path: 'middleware/offer-freshness-schemas.ts',
    owner: "#68's freshness",
    reaches: [],
  },
  {
    path: 'routes/retail-offers.ts',
    owner: "#116/#123's retail presentation",
    reaches: ['services/commercial-presentation/'],
  },
] as const;

/**
 * Every module of the offer domain (#57) — services, repositories, routes,
 * controllers, request schemas. WALKED and FILTERED, never listed.
 *
 * This was eleven hand-written paths under a comment claiming exactly the
 * completeness above, and the claim was false in both halves: it covered
 * `services/offers/` and `db/offers/` completely and omitted
 * `middleware/offer-schemas.ts`, so a reader asking "does the offer domain
 * reach the payment domain?" got an answer computed over a subset with a
 * sentence above it saying otherwise (#460).
 *
 * The two owned directories are walked whole, so the walls hold for modules
 * nobody has written yet. The shared flat directories have no directory to
 * walk, so the population is every offer-NAMED module in them MINUS the exact
 * six that belong to another domain — and the count of that subtraction is
 * asserted, because an excusing list without one is a predicate that lets any
 * number of new modules ride in behind it (#448).
 */
const OFFER_DOMAIN_PATHS = [
  ...walk('services/offers'),
  ...walk('db/offers'),
  ...offerNamedSharedModules().filter(
    (path) => !SIBLING_DOMAIN_MODULES.some((module) => module.path === path),
  ),
];

/**
 * The cart and checkout path. A new module that decides what is in a cart or
 * what is charged belongs on this list — the floor below is what forces whoever
 * adds one to look here.
 */
const CART_AND_CHECKOUT_PATHS = [
  'services/cart.service.ts',
  'services/cart-merge.service.ts',
  'services/checkout.service.ts',
  'controllers/cart.controller.ts',
  'controllers/checkout.controller.ts',
  'routes/cart.ts',
  'routes/checkout.ts',
];

/** Reaching the offer domain, from any direction: an import, a table, a service name. */
const OFFER_REFERENCE =
  /offers\/|offerRepository|nativeListingLink|offerOutbox|\boffers\b|native_listing_links|offer_outboxes/;

/** #58's matching pipeline. This domain STORES an attachment and never decides one. */
const MATCHER_REFERENCE = /matching\.service|matchCandidate|resolveCanonicalMatch|services\/matching\//;

/** #37's outbound redirect. This domain models routing metadata and never routes. */
const REDIRECT_REFERENCE = /outboundRedirect|redirect\.service|buildAffiliateUrl|services\/outbound\//;

/**
 * #84's merchant → native store linkage, and #74's ranking.
 *
 * The identifier half is case-insensitive on its first letter deliberately:
 * `createNativeStoreLink` and `nativeStoreLinkRepository` are the two spellings
 * an import actually takes, and a lower-case-only pattern would match the second
 * and miss the first — which is the shape a scanner passes vacuously in.
 */
const LINKAGE_REFERENCE = /[nN]ativeStoreLink|native_store_links/;
const RANKING_REFERENCE = /rankOffers|offerRanking|services\/ranking\//;

/** The canonical WRITE services — minting, renaming or re-pointing a product. */
const CANONICAL_WRITE_REFERENCE =
  /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|product-identifier\.service/;

/** Any payment-domain module. The readiness seam is carved out below. */
const PAYMENT_REFERENCE = /payments\//;
const PAYMENT_READINESS_SEAM = 'payments/provider-account.service.js';

function readDomainFile(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  // The vacuity floor: an empty or moved file must fail here, not pass the scan
  // by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

describe('the offer domain cannot reach the cart, and the cart cannot reach it', () => {
  it('no cart or checkout module references the offer domain', () => {
    let scanned = 0;
    for (const relative of CART_AND_CHECKOUT_PATHS) {
      const source = readDomainFile(relative);
      expect(
        OFFER_REFERENCE.test(source),
        `${relative} references the offer domain; an external offer must have no path into a cart`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CART_AND_CHECKOUT_PATHS.length);
  });

  it('the schema makes a non-native offer unenterable, which is the stronger half', async () => {
    // The scan above says nobody wired it. This says nobody COULD: the per-kind
    // CHECK forces `product_variant_id` NULL on every kind but `native`, and a
    // cart line holds a variant id and nothing else.
    const { offers } = await import('../../../db/schema/offers.js');
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const shapeCheck = getTableConfig(offers).checks.find(
      (entry) => entry.name === 'offers_kind_shape_check',
    );
    expect(shapeCheck, 'offers_kind_shape_check is missing').toBeDefined();

    // Every non-native branch must NULL the variant id, and the `else false`
    // branch is what makes a kind nobody has widened the CHECK for unstorable.
    //
    // The literal text is read off the SQL's own string chunks. `JSON.stringify`
    // on `queryChunks` throws: a column chunk holds its table and the table
    // holds its columns, so the structure is circular — and a serializer that
    // threw would have failed this test for the wrong reason.
    const rendered = (shapeCheck?.value.queryChunks ?? [])
      .flatMap((chunk) =>
        typeof chunk === 'object' && chunk !== null && 'value' in chunk && Array.isArray(chunk.value)
          ? (chunk.value as unknown[]).filter((part): part is string => typeof part === 'string')
          : [],
      )
      .join(' ');
    expect(rendered).toContain('else false');
    const columns = Object.keys(getTableColumns(offers));
    expect(columns).toContain('productVariantId');

    /**
     * And there is no stored BUYABILITY verdict for a stale value to sit in.
     *
     * `customerEligibility` is the one name that trips the pattern and is not
     * one: it records who the SOURCE said may take the offer up (trade only, age
     * restricted, members), which is a fact the source published about its own
     * audience. The thing that must not exist is a column saying whether
     * MERCARIA can sell it — that is a conjunction over three tables this domain
     * does not own, and it is derived live by
     * `deriveNativeCheckoutEligibility`. Naming the exception here rather than
     * loosening the pattern is what keeps adding a second one a visible act.
     */
    const CUSTOMER_AUDIENCE_COLUMN = 'customerEligibility';
    expect(columns).toContain(CUSTOMER_AUDIENCE_COLUMN);
    expect(
      columns
        .filter((name) => name !== CUSTOMER_AUDIENCE_COLUMN)
        .filter((name) => /checkout|eligib|buyable|purchasable|sellable/i.test(name)),
    ).toEqual([]);
  });
});

describe('the offer domain does other issues’ jobs nowhere', () => {
  it('resolves no canonical match, performs no redirect, links no store, ranks nothing', () => {
    let scanned = 0;
    for (const relative of OFFER_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      expect(MATCHER_REFERENCE.test(source), `${relative} reaches #58's matcher`).toBe(false);
      expect(REDIRECT_REFERENCE.test(source), `${relative} performs #37's redirect`).toBe(false);
      expect(LINKAGE_REFERENCE.test(source), `${relative} reaches #84's store linkage`).toBe(false);
      expect(RANKING_REFERENCE.test(source), `${relative} ranks offers`).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(OFFER_DOMAIN_PATHS.length);
  });

  it('cannot rewrite a canonical product fact', () => {
    // Issue external rule 5: a source updates a merchant title and a price and
    // never a canonical name. There is no import that could.
    for (const relative of OFFER_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      expect(
        CANONICAL_WRITE_REFERENCE.test(source),
        `${relative} imports a canonical write service`,
      ).toBe(false);
    }
  });

  it('reads exactly one thing from the payment domain: the readiness seam', () => {
    for (const relative of OFFER_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      for (const line of source.split('\n')) {
        if (!PAYMENT_REFERENCE.test(line)) continue;
        // A comment naming the payment domain is not a dependency; an import is.
        if (!line.includes('import') && !line.includes('from ')) continue;
        expect(
          line.includes(PAYMENT_READINESS_SEAM),
          `${relative} reaches the payment domain outside the readiness seam: ${line.trim()}`,
        ).toBe(true);
      }
    }
  });

  it('walks the domain rather than listing it, and every shape found something', () => {
    // The vacuity floor. A renamed directory, a moved domain or a walk that
    // simply returned nothing all produce an empty scan, and an empty scan is
    // indistinguishable from a domain that violates nothing.
    //
    // Each floor is the count on the day it was written, because these
    // directories only grow and a SHRINK is exactly the event that should stop
    // the build rather than quietly narrowing every assertion above. Derived
    // per shape rather than in total: the three sources break independently,
    // and one total would let a directory walk collapse to zero while the
    // other two carried the number.
    const from = (prefix: string) =>
      OFFER_DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/offers/'), 'the service walk found nothing').toBeGreaterThanOrEqual(4);
    expect(from('db/offers/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(3);
    expect(from('routes/'), 'no offer route was derived').toBeGreaterThanOrEqual(2);
    expect(from('controllers/'), 'no offer controller was derived').toBeGreaterThanOrEqual(2);
    expect(from('middleware/'), 'no offer request schema was derived').toBeGreaterThanOrEqual(1);

    // No test file may enter the scanned set: a gate that scans its own probes
    // reports violations it wrote itself.
    expect(OFFER_DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);

    // And the walk really reads the disk, rather than a `readdirSync` that has
    // silently started returning a cached or empty result: every path it
    // produced resolves to a real file.
    for (const path of OFFER_DOMAIN_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
  });

  it('the scope judgement is exact, and every hand-off is still honoured', () => {
    // EXACT, not a floor. An excusing entry is a predicate rather than an
    // identity, so a list with no count lets a seventh sibling module be
    // excluded without anybody deciding to (#448).
    expect(SIBLING_DOMAIN_MODULES.length).toBe(6);

    // Every excluded module must really exist — otherwise the exclusion is a
    // stale name that quietly excuses nothing while looking like a decision.
    const candidates = offerNamedSharedModules();
    for (const { path } of SIBLING_DOMAIN_MODULES) {
      expect(candidates, `${path} is excluded but is not an offer-named shared module`).toContain(
        path,
      );
    }

    // And the JUSTIFICATION is measured, per module, against the real imports.
    //
    // The first half is what makes the exclusion true today; the second is what
    // makes it stay true. A shared module that starts importing this domain is
    // no longer somebody else's surface, and the gate that must not silently
    // skip it is this one.
    const OWNED_DIRECTORIES = /(?:^|\/)(?:services\/offers|db\/offers)\//;
    for (const { path, owner, reaches } of SIBLING_DOMAIN_MODULES) {
      const specifiers = [...readDomainFile(path).matchAll(/from\s+'([^']+)'/g)].map(
        (match) => match[1],
      );
      for (const target of reaches) {
        expect(
          specifiers.some((specifier) => specifier.includes(target)),
          `${path} was scoped out as ${owner}'s, and no longer imports ${target}`,
        ).toBe(true);
      }
      expect(
        specifiers.filter((specifier) => OWNED_DIRECTORIES.test(specifier)),
        `${path} was scoped out as ${owner}'s, but now imports the offer domain — it belongs behind this wall`,
      ).toEqual([]);
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('each regex matches a seeded positive and rejects an ordinary line', () => {
    expect(OFFER_REFERENCE.test("import { listOffers } from './offers/offer.service.js';")).toBe(
      true,
    );
    expect(OFFER_REFERENCE.test('select * from native_listing_links')).toBe(true);
    expect(OFFER_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);

    expect(
      MATCHER_REFERENCE.test("import { resolveCanonicalMatch } from '../matching/index.js';"),
    ).toBe(true);
    expect(MATCHER_REFERENCE.test('const matchRule = link.matchRule;')).toBe(false);

    expect(REDIRECT_REFERENCE.test("import { buildAffiliateUrl } from '../outbound/x.js';")).toBe(
      true,
    );
    expect(REDIRECT_REFERENCE.test('affiliateTrackingTemplate')).toBe(false);

    expect(LINKAGE_REFERENCE.test('await createNativeStoreLink(db, input);')).toBe(true);
    expect(LINKAGE_REFERENCE.test('await findActiveLinksForListing(db, id);')).toBe(false);

    expect(RANKING_REFERENCE.test('const ordered = rankOffers(rows);')).toBe(true);
    expect(RANKING_REFERENCE.test('.orderBy(asc(offers.priceAmount))')).toBe(false);

    expect(
      CANONICAL_WRITE_REFERENCE.test(
        "import { applyCanonicalProduct } from '../canonical/canonical-product.service.js';",
      ),
    ).toBe(true);
    expect(CANONICAL_WRITE_REFERENCE.test('canonicalVariantId')).toBe(false);

    expect(PAYMENT_REFERENCE.test("from '../payments/payment.service.js'")).toBe(true);
    expect(PAYMENT_REFERENCE.test('sellerPaymentReady')).toBe(false);
  });
});
