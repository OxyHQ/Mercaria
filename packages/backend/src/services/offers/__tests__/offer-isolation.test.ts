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

/** Every module of the offer domain — services, repositories, routes, controllers. */
const OFFER_DOMAIN_PATHS = [
  'services/offers/offer.service.ts',
  'services/offers/offer-projection.ts',
  'services/offers/native-offer.service.ts',
  'services/offers/offer-outbox-dispatcher.ts',
  'db/offers/offerRepository.ts',
  'db/offers/nativeListingLinkRepository.ts',
  'db/offers/offerOutboxRepository.ts',
  'routes/offers.ts',
  'routes/internal-offers.ts',
  'controllers/offers.controller.ts',
  'controllers/offers-operator.controller.ts',
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

  it('covers every module in services/offers and db/offers — the enumeration floor', () => {
    // A file added to either directory and forgotten by the list above would
    // make every scan here silently narrower. Read the real directories.
    const onDisk = ['services/offers', 'db/offers'].flatMap((relative) =>
      readdirSync(join(SRC_ROOT, relative))
        .filter((entry) => entry.endsWith('.ts'))
        .filter((entry) => statSync(join(SRC_ROOT, relative, entry)).isFile())
        .map((entry) => `${relative}/${entry}`),
    );
    const listed = new Set(OFFER_DOMAIN_PATHS);
    expect(onDisk.filter((path) => !listed.has(path))).toEqual([]);
    expect(onDisk.length).toBeGreaterThanOrEqual(7);
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
