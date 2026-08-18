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
import {
  type DirectoryReader,
  namedInSharedDirectories,
  readSrcDirectory,
} from '../../../__tests__/domain-population.js';
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

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * `db/schema` was missing, inherited from the three-name list copied from gate
 * to gate and from `scripts/isolation-gate-census.ts`'s own bag-directory list.
 * `db/schema/offers.ts` — the three tables this domain owns, and the one place
 * `offers_kind_shape_check` (the CHECK wall 2 below asserts from the commerce
 * side) is actually DECLARED — was in no population and behind no wall here.
 */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Every module in a flat directory whose name STARTS with `cart` or `checkout`.
 *
 * Anchored deliberately. An unanchored `checkout` also matches
 * `guest-checkout.service.ts` and `retail-checkout` modules, which belong to the
 * guest and retail domains — a wall that fails on another domain's file is one
 * whoever hits it next narrows, and narrowing is how these gates die.
 */
function cartOrCheckoutNamed(directory: string): string[] {
  return readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => /^(cart|checkout)/i.test(entry.name))
    .map((entry) => `${directory}/${entry.name}`);
}

/** Every offer-NAMED module in a shared flat directory, whoever owns it. */
function offerNamedSharedModules(readDir: DirectoryReader = readSrcDirectory): string[] {
  // RECURSIVE and matching the PATH, where this was one level deep beside a
  // recursive `walk()` ten lines up, so nothing under `routes/admin/` or
  // `controllers/admin/` could enter the population (#460).
  return namedInSharedDirectories(SHARED_DIRECTORIES, /offer/i, readDir);
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
    /**
     * #68's five tables, which arrived in this population with `db/schema`.
     *
     * Adding that directory closed a real gap — `db/schema/offers.ts`, where
     * `offers_kind_shape_check` is declared, was behind no wall — and it opened
     * this one in the same move: the `offer` token belongs to four domains, so
     * the widening took #68's schema module too. Left in, the walls below would
     * fire at whoever edits #68's tables, which is a FALSE WALL rather than a
     * fix. It is #68's `freshness-isolation.test.ts` that has to cover it.
     *
     * `reaches` is empty for the reason `offer-freshness-schemas.ts` above has
     * none: a schema module is a leaf, so there is no downward edge to measure
     * and only the second half of the assertion below applies.
     */
    path: 'db/schema/offerFreshness.ts',
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
 * The cart and checkout path. WALKED and derived, never listed.
 *
 * This was seven hand-written paths under a comment saying "a new module that
 * decides what is in a cart or what is charged belongs on this list", which is
 * the shape #460 is about: the list was written when `services/checkout.service.ts`
 * was the whole of checkout, and by the time it was read #105 had grown a
 * `services/checkout/` DIRECTORY beside it. Measured on `origin/main` at
 * 81448ac6: seven entries against fifteen, and the eight missing were the entire
 * `services/checkout/` directory — `contact`, `destination`,
 * `fulfilment-eligibility`, `guest-checkout.service`, `guest-rollout`, `refusal`,
 * `retail` — plus `services/cart-owner.ts`.
 *
 * So wall 2 — "an external offer must have no path into a cart", which is #57's
 * `offers_kind_shape_check` asserted from the commerce side — did not cover the
 * modules that decide who may check out, what may be delivered and which lines
 * are refused. `retail.ts` is the one to notice: it partitions the retail lines
 * out of a checkout, which is the module in the tree closest to legitimately
 * wanting an offer.
 *
 * The directory is walked whole so the wall holds for modules nobody has written
 * yet; the flat shared directories have none to walk, so the population is every
 * module in them whose name STARTS with `cart` or `checkout` — anchored, because
 * an unanchored `checkout` also takes `guest-checkout-*` modules belonging to
 * the guest domain, and a wall that fails on somebody else's file is one whoever
 * hits it next narrows.
 */
const CART_AND_CHECKOUT_PATHS = [
  ...walk('services/checkout'),
  ...cartOrCheckoutNamed('services'),
  ...cartOrCheckoutNamed('controllers'),
  ...cartOrCheckoutNamed('routes'),
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

/**
 * Source with comments removed — what every REACHABILITY detector below scans.
 *
 * Not a convenience, and not optional once the cart population is derived rather
 * than listed. `OFFER_REFERENCE` contains `\boffers\b`, and the modules this
 * gate now reaches DOCUMENT the rule in the same English word: widening the cart
 * wall to the real `services/checkout/` directory made it fail on `retail.ts`'s
 * comment "reaching here means a binding set disagrees with the offers behind
 * it" — a sentence explaining a currency guard, in a module that imports nothing
 * from this domain at all. That is the "cries wolf" failure `~/Oxy/AGENTS.md`
 * names: the cheapest green for a gate with known false positives is deleting
 * the gate, so the fix is to scan what the compiler sees. `matching`,
 * `curation`, `guest-claim` and both referral gates already read their domains
 * this way, for the same reason.
 *
 * The floor stays on the RAW source, so a file emptied down to a comment block
 * fails as "did it move?"; a SECOND floor on the stripped text catches a
 * stripper that ate the code, which would otherwise make every wall here pass
 * against nothing.
 */
function readDomainFile(relative: string): string {
  const raw = readFileSync(join(SRC_ROOT, relative), 'utf8');
  // The vacuity floor: an empty or moved file must fail here, not pass the scan
  // by having nothing to match.
  expect(raw.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  const code = raw.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  expect(
    code.replace(/\s+/gu, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(100);
  return code;
}

describe('the offer domain cannot reach the cart, and the cart cannot reach it', () => {
  it('no cart or checkout module references the offer domain', () => {
    // Floors PER SHAPE, each today's count. `expect(scanned).toBe(LIST.length)`
    // used to sit here and could not fail: it compared the loop's own counter
    // to the list the loop had just iterated, which is satisfied by any list
    // including an empty one. What it could never see is the population being
    // wrong, which it was — see the derivation above.
    const from = (prefix: string) =>
      CART_AND_CHECKOUT_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/checkout/'), "#105's checkout walk found nothing").toBeGreaterThanOrEqual(
      7,
    );
    expect(from('services/cart'), 'no cart service was derived').toBeGreaterThanOrEqual(3);
    expect(from('controllers/'), 'no cart or checkout controller was derived').toBeGreaterThanOrEqual(
      2,
    );
    expect(from('routes/'), 'no cart or checkout route was derived').toBeGreaterThanOrEqual(2);
    for (const path of CART_AND_CHECKOUT_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }

    for (const relative of CART_AND_CHECKOUT_PATHS) {
      const source = readDomainFile(relative);
      expect(
        OFFER_REFERENCE.test(source),
        `${relative} references the offer domain; an external offer must have no path into a cart`,
      ).toBe(false);
    }
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
    expect(SIBLING_DOMAIN_MODULES.length).toBe(7);

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

/**
 * #460's whole-tree sweep is DEFERRED here, and this is the measurement.
 *
 * Every other gate converted under #460 ends with a sweep of the whole of `src/`
 * for paths naming the domain, requiring each to be in the population or in a
 * counted exclusion — the general remedy, because it closes the class rather
 * than today's entry. It is not applied here, deliberately, and the reason is a
 * property of the token rather than of this gate.
 *
 * `offer` belongs to FOUR domains. Measured over the tree on this branch, a
 * sweep for `/offer/i` selects 26 modules outside this population, and an
 * anchored `/(?:^|\/)(?:internal-)?offers?(?:[-.\/]|$)/i` still selects 15:
 * the whole of `services/offer-freshness/` and `db/offerFreshness/` (#68),
 * `services/search/offer-context.ts` and `selected-offer.port.ts` (#70),
 * `services/store-linkage/offer-overlap.ts` (#84),
 * `services/merchant-pages/offer-mix.ts` (#73),
 * `services/attributes/offer-facts.port.ts` (#94),
 * `services/product-saves/best-offer.ts` (#80),
 * `db/procurement/procurementOfferRepository.ts` (#123),
 * `services/backfill/stages/native-offers.ts` (#60) and
 * `services/commercial-presentation/retail-offer.service.ts` (#116).
 *
 * So the sweep here would need a fifteen-entry exclusion list naming other
 * domains' modules, and it would need a new entry every time any of those eight
 * domains grew a file. That is a hand list that churns — the exact failure this
 * issue exists to remove — and it would push whoever hits it toward the
 * permissive fix of widening this population to swallow another domain's
 * modules, which is the false wall `db/schema/offerFreshness.ts` above already
 * demonstrates in miniature.
 *
 * What covers those fifteen is their OWN gates, which is the right place: #68's
 * `freshness-isolation.test.ts`, #70's `search-relevance-isolation.test.ts`,
 * #84's `store-linkage-isolation.test.ts` and so on. What is owed here is a
 * sweep whose exclusion is "another domain's OWNED directory, and here is the
 * gate that covers it" — a checkable claim rather than a list of paths — and
 * that mechanism does not exist yet. Stated rather than half-built: a sweep
 * with fifteen guessed exclusions would read as coverage.
 */
describe('#460: the whole-tree sweep is deferred, and the reason is measured', () => {
  it('the token really is shared with other domains', () => {
    // The deferral rests on a fact about the tree, so the fact is asserted here
    // rather than left in the docblock to rot. If `offer` ever stops being a
    // shared token, this goes red and the sweep becomes available.
    const foreignOfferNamedModules = [
      'services/offer-freshness/freshness.ts',
      'services/search/offer-context.ts',
      'services/store-linkage/offer-overlap.ts',
      'services/merchant-pages/offer-mix.ts',
      'services/attributes/offer-facts.port.ts',
      'db/procurement/procurementOfferRepository.ts',
    ];
    for (const foreign of foreignOfferNamedModules) {
      expect(statSync(join(SRC_ROOT, foreign)).isFile(), `${foreign} moved`).toBe(true);
      expect(/offer/i.test(foreign), 'this module does not name the token').toBe(true);
      expect(
        OFFER_DOMAIN_PATHS,
        `${foreign} is another domain's and must not be in this population`,
      ).not.toContain(foreign);
    }
    expect(foreignOfferNamedModules.length, 'the measured set changed').toBe(6);
  });

  /**
   * What defends `db/schema` here, since the sweep that would normally do it is
   * deferred above.
   *
   * In every other gate converted under #460 the whole-tree sweep reports a
   * domain module that leaves the population. With that sweep deferred,
   * dropping `db/schema` from `SHARED_DIRECTORIES` would silently take this
   * domain's three tables back out of every wall and no floor or count would
   * move — the exact defect #460 is about, reintroduced by the deferral. So the
   * membership is asserted directly: an identity, not a floor (#448).
   */
  it('the tables this domain owns are in the population', () => {
    expect(
      OFFER_DOMAIN_PATHS,
      'db/schema/offers.ts left the population — offers_kind_shape_check is declared there, and ' +
        'wall 2 asserts it from the commerce side',
    ).toContain('db/schema/offers.ts');
  });
});
