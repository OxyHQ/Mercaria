/**
 * The critical catalogue flow, end to end, in TWO languages and TWO markets
 * (#367 Workstream 18, "repeat critical flows in at least two language variants
 * and two markets").
 *
 * ## What it drives, and why this is not the Workstream 14 suite again
 *
 * `verticals-footwear.realdb.test.ts` and `verticals-smartphone.realdb.test.ts`
 * prove the MODELLING each vertical exists to prove — five size systems, a
 * spec-sheet fact that is not an axis — each in one locale and one market. This
 * file drives the merchant's whole journey twice over, and adds the three steps
 * those files stop short of:
 *
 *  1. **Offers.** No Workstream 14 file calls `convergeNativeOffersForListing` at
 *     all, so no `offers` row ever exists there — and the footwear one could not
 *     produce any if it did, since its published variant selects no canonical
 *     configuration ("a native variant nobody has matched has nothing to be an
 *     offer ON"). Here every published variant SELECTS one and the converger is
 *     driven, so real `offers` rows exist and the reads that consume them can be
 *     driven. What the product page then does with them is the finding this file
 *     records rather than the outcome it assumed: with `STRIPE_ENABLED` off — the
 *     suite's configuration, and any
 *     deployment without Stripe — every native offer is EXCLUDED from the
 *     comparison as `seller_not_payment_ready`, while the search result's own
 *     offer summary carries it. The page case asserts the exclusion BY REASON,
 *     which is what makes it a control on the search case rather than a puzzle.
 *  2. **Search.** Footwear stops at facets and never reaches
 *     `runCanonicalSearch`; the smartphone suite drives it for its ALIAS stages
 *     over a catalogue with no offers in it. What is new here is the search a
 *     shopper actually performs — over a product a merchant has published, with
 *     the offer projection populated, and with a market filter applied.
 *  3. **The locale/market matrix**, with a cross-pair comparison at the end that
 *     is the actual claim: the two locales agree on every RULE and disagree on
 *     every STRING.
 *
 * ## Every claim's control, named
 *
 * - `seedVerticalForTest` refuses a half-applied fixture, so no case runs against
 *   missing rows, and `reportPopulation` refuses a run whose counts are zero.
 * - The locale claim is asserted in BOTH directions: the semantic fingerprints
 *   must be EQUAL and the text fingerprints must DIFFER. Only the first would
 *   pass against a composer that had stopped localizing anything at all.
 * - The search claim asserts the unfiltered result CONTAINS the product before
 *   any narrowing, so "the filter matched one" is a narrowing rather than an
 *   empty catalogue, and a nonsense term is asserted NOT to reach it.
 * - The market claim is the one that needed the most care. A native offer is
 *   market-LESS, so both markets legitimately see it; asserting that alone would
 *   pass against a build where the market predicate had been deleted. So the
 *   same search runs again inside a ROLLED-BACK transaction with EVERY offer on
 *   the canonical product pinned to one market, and the other market is shown to
 *   drop it. Pinning only this pair's offers is not enough — the sibling pair has
 *   published its own, and a search reaching the product through an unpinned
 *   sibling reads as a failure of the predicate. Measured; that is how it first
 *   failed.
 *
 * ## Each pair carries its own title and SKUs, and NOT because of a constraint
 *
 * Measured rather than assumed, because the obvious assumption is wrong in both
 * halves: the publication path passes no `handle`, so `listings.handle` is NULL
 * and `listings_store_id_handle_key` cannot fire on two listings sharing a title;
 * and `product_variants.sku` carries no unique index at any scope (#296). The
 * values are varied so each pair's rows are identifiable to the assertions that
 * name them.
 *
 * ## The shared database
 *
 * Every identity carries this file's own run token. Product NAMES are not
 * namespaced by the seed (only keys, slugs and handles are), so a sibling file
 * seeding footwear holds a second product called `Kestrel Trailwind 3` — every
 * search assertion here therefore names an ID and never a count.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { AuthoringSchema } from '@mercaria/shared-types';

import { connectPostgres, type Database, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findCategoryByKey } from '../../db/taxonomy/taxonomyRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../../services/catalog-authoring/draft.service.js';
import { publishDraft } from '../../services/catalog-authoring/publish.service.js';
import { composeAuthoringSchema } from '../../services/catalog-authoring/schema.service.js';
import { foldLocale } from '../../services/catalog-localization/resolve.js';
import { resolveFacets } from '../../services/facets/facet.service.js';
import { convergeNativeOffersForListing } from '../../services/offers/native-offer.service.js';
import { rankOfferComparison } from '../../services/ranking/comparison.service.js';
import { readCanonicalProductPage } from '../../services/product-page/product-page.service.js';
import { runCanonicalSearch } from '../../services/search/canonical-search.service.js';
import { nsCategoryKey, nsKey, nsSlug, type VerticalNamespace } from '../../scripts/seed-verticals/apply.js';
import { FOOTWEAR_PACKAGE } from '../../scripts/seed-verticals/footwear.js';
import { SMARTPHONE_PACKAGE } from '../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import {
  E2E_PERMISSIONS,
  countOne,
  countStoreListings,
  enumValueId,
  reportPopulation,
  semanticFingerprint,
  textFingerprint,
} from './journey.js';

/**
 * One language variant paired with one market.
 *
 * `es-MX` rather than `es`, deliberately: a REGIONAL tag exercises the fallback
 * truncation on the way to the language the footwear package actually translates,
 * so the pair measures the chain and not just a second dictionary.
 */
interface Pair {
  readonly name: string;
  readonly locale: string;
  readonly market: string;
  /** The footwear canonical configurations this pair lists. */
  readonly footwear: readonly { readonly variantKey: string; readonly size: string; readonly color: string; readonly width: string }[];
  /** The smartphone canonical configuration this pair lists. */
  readonly phone: { readonly variantKey: string; readonly storageGb: number; readonly color: string; readonly region: string };
}

const PAIRS: readonly Pair[] = [
  {
    name: 'en / US',
    locale: 'en',
    market: 'US',
    footwear: [
      { variantKey: 'trailwind-41-black-standard', size: '41', color: 'black', width: 'standard' },
      { variantKey: 'trailwind-42-black-standard', size: '42', color: 'black', width: 'standard' },
    ],
    phone: { variantKey: 'axon-256GB-black-eu', storageGb: 256, color: 'black', region: 'eu' },
  },
  {
    name: 'es-MX / ES',
    locale: 'es-MX',
    market: 'ES',
    footwear: [
      { variantKey: 'trailwind-42-blue-standard', size: '42', color: 'blue', width: 'standard' },
      { variantKey: 'trailwind-43-black-standard', size: '43', color: 'black', width: 'standard' },
    ],
    phone: { variantKey: 'axon-512GB-blue-us', storageGb: 512, color: 'blue', region: 'us' },
  },
];

const TOKEN = verticalRunToken('lm');

const db: Database = await connectPostgres();
let footwear: SeededVertical;
let phones: SeededVertical;
let fwNs: VerticalNamespace;
let phNs: VerticalNamespace;
let mensCategoryId: string;
let phoneCategoryId: string;
let storeId: string;

/** What each pair's run produced, read by the cross-pair comparison at the end. */
interface PairOutcome {
  readonly footwearSchema: AuthoringSchema;
  readonly footwearListingId: string;
  readonly phoneListingId: string;
  readonly offersMaterialized: number;
}
const outcomes = new Map<string, PairOutcome>();

beforeAll(async () => {
  footwear = await seedVerticalForTest(db, FOOTWEAR_PACKAGE, `${TOKEN}f`);
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, `${TOKEN}p`);
  fwNs = footwear.ns;
  phNs = phones.ns;

  const mens = await findCategoryByKey(nsCategoryKey(fwNs, 'athletic.mens_running_shoes'), db);
  const smartphones = await findCategoryByKey(nsCategoryKey(phNs, 'phones.smartphones'), db);
  if (!mens || !smartphones) throw new Error('the seeded departments did not resolve');
  mensCategoryId = mens.id;
  phoneCategoryId = smartphones.id;

  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Journey warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
}, 300_000);

afterAll(async () => {
  // The store belongs to this token, and both packages' rows belong to their own.
  // Listings are deleted by the store's own teardown pass in whichever call runs
  // first; the second is then a no-op, which is why both are unconditional.
  await teardownVertical(db, TOKEN);
  await teardownVertical(db, `${TOKEN}f`);
  await teardownVertical(db, `${TOKEN}p`);
}, 300_000);

/** A canonical variant id the seed minted, by the package's own variant key. */
function canonicalVariantId(seeded: SeededVertical, variantKey: string): string {
  const id = seeded.handles.variantIds.get(variantKey);
  if (id === undefined) {
    throw new Error(`the seed minted no canonical variant '${variantKey}'`);
  }
  return id;
}

describe.each(PAIRS)('the footwear journey in $name', (pair) => {
  it('composes the merchant schema for this locale and market', async () => {
    const composed = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(fwNs, 'athletic_footwear'),
      categoryId: mensCategoryId,
      flow: 'merchant',
      requestedLocale: pair.locale,
      market: pair.market,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      composed.outcome,
      `composition refused: ${composed.outcome === 'refused' ? composed.detail : ''}`,
    ).toBe('composed');
    if (composed.outcome !== 'composed') return;

    // The market is carried verbatim. Nothing in the composer VARIES by market
    // today — the market's job here is to be pinned onto the draft and frozen
    // there — and saying so is more useful than an assertion implying otherwise.
    expect(composed.schema.market).toBe(pair.market);
    // FOLDED, not verbatim: `foldLocale` lower-cases and repairs the separator
    // before the chain is built, so the schema reports `es-mx` for a request that
    // said `es-MX`. Asserting the raw tag here would fail, and asserting nothing
    // would let a composer that ignored the locale pass.
    expect(composed.schema.locale.requestedLocale).toBe(foldLocale(pair.locale));
    // Ten merchant fields; the P2P flow's three are a different flow.
    expect(composed.schema.fields).toHaveLength(10);

    outcomes.set(pair.name, {
      footwearSchema: composed.schema,
      footwearListingId: '',
      phoneListingId: '',
      offersMaterialized: 0,
    });
  });

  it('publishes a listing whose variants each select their canonical configuration', async () => {
    const before = await countStoreListings(db, storeId);

    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: footwear.actorOxyUserId,
      categoryId: mensCategoryId,
      productTypeKey: nsKey(fwNs, 'athletic_footwear'),
      flow: 'merchant',
      locale: pair.locale,
      market: pair.market,
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      // Distinct per pair so the assertions can name this pair's listing. Not a
      // constraint: see the header — the publication path writes a NULL handle.
      title: `Kestrel Trailwind 3 (${pair.market})`,
    });
    // The draft stores the FOLDED locale — `createDraft` writes
    // `schema.locale.requestedLocale`, which the composer has already folded.
    expect(draft.locale).toBe(foldLocale(pair.locale));
    expect(draft.market).toBe(pair.market);

    const variants = await Promise.all(
      pair.footwear.map(async (entry) => ({
        sku: `${TOKEN}-${pair.market}-${entry.size}-${entry.color}-${entry.width}`,
        inventoryAvailable: 3,
        price: { amount: 12900, currency: 'EUR' as const },
        selectedCanonicalVariantId: canonicalVariantId(footwear, entry.variantKey),
        axes: [
          {
            attributeKey: nsKey(fwNs, 'shoe_size_eu'),
            values: [{ enumValueId: await enumValueId(db, fwNs, 'shoe_size_eu', entry.size) }],
          },
          {
            attributeKey: nsKey(fwNs, 'footwear_color'),
            values: [{ enumValueId: await enumValueId(db, fwNs, 'footwear_color', entry.color) }],
          },
          {
            attributeKey: nsKey(fwNs, 'shoe_width'),
            values: [{ enumValueId: await enumValueId(db, fwNs, 'shoe_width', entry.width) }],
          },
        ],
      })),
    );

    await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: E2E_PERMISSIONS,
      description: `Published by the #367 journey for ${pair.name}.`,
      selectedCanonicalProductId: footwear.handles.productIds.get('trailwind_3') ?? null,
      fields: [
        {
          attributeKey: nsKey(fwNs, 'upper_material'),
          values: [{ enumValueId: await enumValueId(db, fwNs, 'upper_material', 'mesh') }],
        },
      ],
      variants,
    });

    const validation = await validateStoreDraft(db, {
      storeId,
      draftId: draft.id,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the draft is not publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: footwear.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    expect(publication.outcome).toBe('published');
    if (publication.outcome === 'refused') {
      throw new Error(`publication refused: ${JSON.stringify(publication.validation.findings)}`);
    }

    // The listing count moved by exactly one: the assertion that this pair
    // published its OWN listing rather than converging on the other pair's.
    expect(await countStoreListings(db, storeId)).toBe(before + 1);

    // Two variants, two declared links, and the axis matrix behind them.
    const links = await countOne(
      db,
      sql`select count(*)::int as total from native_listing_links
          where listing_id = ${publication.listingId} and status = 'active'
            and method = 'merchant_declared'`,
    );
    expect(links).toBe(pair.footwear.length);

    const signatures = await db.execute<{ axis_count: number }>(sql`
      select axis_count from native_variant_signatures where listing_id = ${publication.listingId}
    `);
    const axisCounts = [...signatures].map((row) => row.axis_count);
    expect(axisCounts).toHaveLength(pair.footwear.length);
    // Three axes on every variant — size, colour and width. The signature is
    // order-independent, so this is the only place the COUNT is visible.
    expect(axisCounts.every((count) => count === 3)).toBe(true);

    const previous = outcomes.get(pair.name);
    if (previous === undefined) throw new Error('the composition case did not run');
    outcomes.set(pair.name, { ...previous, footwearListingId: publication.listingId });
  });

  it('materialises a native offer per selected configuration', async () => {
    const recorded = outcomes.get(pair.name);
    if (recorded === undefined || recorded.footwearListingId === '') {
      throw new Error('the publication case did not run');
    }

    const result = await convergeNativeOffersForListing(recorded.footwearListingId);
    expect(result.materialized).toBe(pair.footwear.length);
    expect(result.retiredForListing).toBe(0);
    expect(result.retiredForVariant).toBe(0);

    const active = await countOne(
      db,
      sql`select count(*)::int as total from offers
          where listing_id = ${recorded.footwearListingId} and status = 'active' and kind = 'native'`,
    );
    expect(active).toBe(pair.footwear.length);

    outcomes.set(pair.name, { ...recorded, offersMaterialized: result.materialized });
  });

  it('finds the product by name, and does not find it under a nonsense term', async () => {
    const productId = footwear.handles.productIds.get('trailwind_3');
    expect(productId).toBeDefined();
    if (productId === undefined) return;

    const found = await runCanonicalSearch(
      { term: 'Kestrel Trailwind 3', kinds: ['product'], filters: {}, limit: 50 },
      db,
    );
    // An ID and never a count: a sibling file seeding footwear holds a second
    // product with the identical NAME, because the seed namespaces slugs and
    // keys and not display names.
    const mine = found.response.results.find(
      (entry) => entry.kind === 'product' && entry.canonicalProductId === productId,
    );
    expect(mine, 'the seeded product was not reachable by its own name').toBeDefined();
    if (mine === undefined || mine.kind !== 'product') return;
    expect(mine.matchStages).toContain('exact_name');
    // The offers this pair just materialised are visible to the search's own
    // offer projection.
    expect(mine.offerSummary, 'the product carries no offer summary').toBeDefined();

    // The control: the same read, a term that names nothing.
    const absent = await runCanonicalSearch(
      { term: 'zzzz-no-such-shoe-zzzz', kinds: ['product'], filters: {}, limit: 50 },
      db,
    );
    expect(
      absent.response.results.some(
        (entry) => entry.kind === 'product' && entry.canonicalProductId === productId,
      ),
    ).toBe(false);
  });

  it('serves the product to BOTH markets, because a native offer is market-less', async () => {
    const productId = footwear.handles.productIds.get('trailwind_3');
    const recorded = outcomes.get(pair.name);
    if (productId === undefined || recorded === undefined) return;

    const reach = async (market: string, handle: DatabaseOrTransaction): Promise<boolean> => {
      const found = await runCanonicalSearch(
        { term: 'Kestrel Trailwind 3', kinds: ['product'], filters: { market }, limit: 50 },
        handle,
      );
      return found.response.results.some(
        (entry) => entry.kind === 'product' && entry.canonicalProductId === productId,
      );
    };

    // `offers.country` is NULL on a native offer, and the repository's market
    // predicate ADMITS a market-less offer deliberately — "dropping it would
    // empty a Spanish product page of every global feed's offers".
    expect(await reach('ES', db)).toBe(true);
    expect(await reach('US', db)).toBe(true);

    // The control, and it is the whole point of this case: pinning the offers to
    // one market inside a ROLLED-BACK transaction must make the OTHER market
    // stop reaching the product. Without this, the two `true`s above would also
    // pass against a build whose market predicate had been deleted.
    //
    // EVERY active offer on this canonical product, not just this pair's: the
    // other pair has already published its own, and a search reaching the
    // product through an unpinned sibling would make the control read as a
    // failure of the predicate. (Measured — that is exactly how it first failed.)
    await expect(
      db.transaction(async (tx) => {
        const pinned = await tx.execute(sql`
          update offers set country = 'ES'
          where status = 'active'
            and canonical_variant_id in (
              select id from canonical_variants where product_id = ${productId}
            )
          returning id
        `);
        // A vacuity floor: an UPDATE that matched nothing would leave both
        // markets reaching the product and the control would silently measure
        // an unpinned catalogue.
        expect([...pinned].length).toBeGreaterThanOrEqual(pair.footwear.length);
        expect(await reach('ES', tx)).toBe(true);
        expect(await reach('US', tx)).toBe(false);
        throw new RollBack();
      }),
    ).rejects.toBeInstanceOf(RollBack);

    // And the pin is gone, so the rest of the file is unaffected.
    expect(await reach('US', db)).toBe(true);
  });

  it('filters the category by a typed axis, having first counted it unfiltered', async () => {
    const unfiltered = await resolveFacets(
      {
        scope: { kind: 'category', categoryId: mensCategoryId, includeDescendants: true },
        selection: [],
        locale: pair.locale,
        displayCurrency: 'EUR',
      },
      db,
    );
    // Counted FIRST, so the narrowing below is a narrowing and not an empty
    // catalogue. Two men's products are seeded under this department.
    expect(unfiltered.response.matchedProductCount).toBeGreaterThanOrEqual(2);

    const narrowed = await resolveFacets(
      {
        scope: { kind: 'category', categoryId: mensCategoryId, includeDescendants: true },
        selection: [
          { origin: 'attribute', facetKey: nsKey(fwNs, 'shoe_width'), values: ['wide'] },
        ],
        locale: pair.locale,
        displayCurrency: 'EUR',
      },
      db,
    );
    // Only `Trailwind 3` seeds a `wide` configuration; `Fjord Runner` varies on
    // size and colour alone. So the width filter is a real narrowing.
    expect(narrowed.response.matchedProductCount).toBe(1);
    expect(narrowed.response.matchedProductCount).toBeLessThan(
      unfiltered.response.matchedProductCount,
    );
  });

  it('renders the product page, and EXCLUDES the offer with a reason a shopper could be told', async () => {
    const recorded = outcomes.get(pair.name);
    const productId = footwear.handles.productIds.get('trailwind_3');
    if (recorded === undefined || productId === undefined) return;

    const page = await readCanonicalProductPage({
      handle: nsSlug(fwNs, 'kestrel-trailwind-3'),
      comparisonCurrency: 'EUR',
      market: pair.market,
      limit: 20,
      offerComparisonPermitted: true,
    });
    expect(page, 'the product page did not resolve').toBeDefined();
    if (!page) return;

    expect(page.page.product.name).toBe('Kestrel Trailwind 3');
    // Eight canonical configurations, of which this pair listed two.
    expect(page.page.variants).toHaveLength(8);
    // `available: true` with an empty `rows` is a genuinely different answer
    // from `available: false`, which means the comparison was withheld.
    expect(page.page.offers.available).toBe(true);
    if (!page.page.offers.available) return;

    const ourOfferIds = new Set(
      [
        ...(await db.execute<{ id: string }>(sql`
          select id from offers where listing_id = ${recorded.footwearListingId} and status = 'active'
        `)),
      ].map((row) => row.id),
    );
    expect(ourOfferIds.size).toBe(pair.footwear.length);

    /**
     * MEASURED, and it is a finding rather than a fixture problem.
     *
     * The offers exist, are fresh, and are in the search result's own offer
     * summary (the case above asserts that). The comparison still refuses them,
     * because `readSellerPaymentReadiness` returns an EMPTY map when
     * `STRIPE_ENABLED` is off and `offer-projection.ts` coerces a missing entry
     * to `false` — so `deriveNativeCheckoutEligibility` reports
     * `seller_not_payment_ready` and #74's rule 7 excludes the offer.
     *
     * Asserting the exclusion COUNT alone would be satisfied by any exclusion,
     * so the reason is read from `rankOfferComparison`'s own verdicts. That is
     * also what makes this case a control on the search case above: the same
     * offer is summarised by one read and refused by the other, and the
     * disagreement is attributable to one named rule rather than to a missing row.
     */
    const comparison = await rankOfferComparison({
      canonicalProductId: productId,
      comparisonCurrency: 'EUR',
      market: pair.market,
      limit: 20,
    });
    const ourVerdicts = comparison.comparison.excluded.filter((entry) =>
      ourOfferIds.has(entry.offerId),
    );
    expect(ourVerdicts).toHaveLength(pair.footwear.length);
    for (const verdict of ourVerdicts) {
      expect(verdict.reasons).toContain('seller_not_payment_ready');
    }
    // And the page counts them, rather than dropping them silently.
    expect(page.page.offers.excludedCount).toBeGreaterThanOrEqual(pair.footwear.length);
    expect(page.page.offers.rows.filter((row) => ourOfferIds.has(row.offer.id))).toHaveLength(0);

    reportPopulation(`footwear ${pair.name}`, {
      canonicalVariants: page.page.variants.length,
      ourActiveOffers: ourOfferIds.size,
      excludedWithAReason: ourVerdicts.length,
      pageExcludedCount: page.page.offers.excludedCount,
      listedConfigurations: pair.footwear.length,
    });
  });
});

describe.each(PAIRS)('the smartphone existing-canonical journey in $name', (pair) => {
  it('publishes by DIRECT LINK, converges an offer and reaches the product page', async () => {
    const productId = phones.handles.productIds.get('axon_9_pro');
    if (productId === undefined) throw new Error('the seed minted no Axon 9 Pro');

    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: phones.actorOxyUserId,
      categoryId: phoneCategoryId,
      productTypeKey: nsKey(phNs, 'smartphone'),
      flow: 'merchant',
      locale: pair.locale,
      market: pair.market,
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: `Lumira Axon 9 Pro (${pair.market})`,
    });

    await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: E2E_PERMISSIONS,
      description: `Selected, not proposed — ${pair.name}.`,
      selectedCanonicalProductId: productId,
      fields: [
        {
          attributeKey: nsKey(phNs, 'chipset'),
          values: [{ enumValueId: await enumValueId(db, phNs, 'chipset', 'snapdragon_8_gen_4') }],
        },
        { attributeKey: nsKey(phNs, 'screen_size'), values: [{ number: 6.7, unit: 'in' }] },
      ],
      variants: [
        {
          sku: `${TOKEN}-AXON-${pair.market}-${pair.phone.storageGb}`,
          inventoryAvailable: 2,
          price: { amount: 129900, currency: 'EUR' },
          selectedCanonicalVariantId: canonicalVariantId(phones, pair.phone.variantKey),
          axes: [
            {
              attributeKey: nsKey(phNs, 'storage_capacity'),
              values: [{ number: pair.phone.storageGb, unit: 'GB' }],
            },
            {
              attributeKey: nsKey(phNs, 'phone_color'),
              values: [{ enumValueId: await enumValueId(db, phNs, 'phone_color', pair.phone.color) }],
            },
            {
              attributeKey: nsKey(phNs, 'device_region'),
              values: [{ enumValueId: await enumValueId(db, phNs, 'device_region', pair.phone.region) }],
            },
          ],
        },
      ],
    });

    const validation = await validateStoreDraft(db, {
      storeId,
      draftId: draft.id,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the draft is not publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: phones.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    if (publication.outcome === 'refused') {
      throw new Error(`publication refused: ${JSON.stringify(publication.validation.findings)}`);
    }
    expect(publication.outcome).toBe('published');

    const converged = await convergeNativeOffersForListing(publication.listingId);
    expect(converged.materialized).toBe(1);

    const page = await readCanonicalProductPage({
      handle: nsSlug(phNs, 'lumira-axon-9-pro'),
      comparisonCurrency: 'EUR',
      market: pair.market,
      limit: 20,
      offerComparisonPermitted: true,
    });
    expect(page).toBeDefined();
    if (!page || !page.page.offers.available) {
      throw new Error('the phone page withheld its comparison');
    }
    expect(page.page.variants).toHaveLength(8);

    // Narrowing the page to the CONFIGURATION this pair listed is a different
    // READ, not a filtered one — it must not consider another configuration's
    // offer at all. `rankOfferComparison`'s `offers` map is every offer
    // CONSIDERED, refusals included, so it is the set that shows the scope bit,
    // where `rows` would be empty for the readiness reason the footwear case
    // records and could not tell a narrow scope from a total refusal.
    const listedVariantId = canonicalVariantId(phones, pair.phone.variantKey);
    const scoped = await readCanonicalProductPage({
      handle: nsSlug(phNs, 'lumira-axon-9-pro'),
      canonicalVariantId: listedVariantId,
      comparisonCurrency: 'EUR',
      market: pair.market,
      limit: 20,
      offerComparisonPermitted: true,
    });
    if (!scoped || !scoped.page.offers.available) {
      throw new Error('the variant-scoped phone page withheld its comparison');
    }
    expect(scoped.page.selectedVariantId).toBe(listedVariantId);

    const scopedComparison = await rankOfferComparison({
      canonicalVariantId: listedVariantId,
      comparisonCurrency: 'EUR',
      market: pair.market,
      limit: 20,
    });
    const consideredVariantIds = new Set(
      [...scopedComparison.offers.values()].map((offer) => offer.canonicalVariantId),
    );
    // Non-empty FIRST, so "only this configuration" is a narrowing and not an
    // empty read, then exactly this configuration.
    expect(consideredVariantIds.size).toBe(1);
    expect([...consideredVariantIds]).toEqual([listedVariantId]);

    // The product-wide comparison must consider at least what the scoped one
    // did. The STRICT inequality — the control that the scope parameter is what
    // narrows — cannot be asserted here: the first pair to run is the only
    // seller of any configuration at that moment, so wide and scoped are
    // legitimately equal. It is asserted once, after both pairs have published,
    // in the cross-pair block at the end of this file.
    const wideComparison = await rankOfferComparison({
      canonicalProductId: productId,
      comparisonCurrency: 'EUR',
      market: pair.market,
      limit: 50,
    });
    expect(wideComparison.offers.size).toBeGreaterThanOrEqual(scopedComparison.offers.size);
    for (const offerId of scopedComparison.offers.keys()) {
      expect(wideComparison.offers.has(offerId)).toBe(true);
    }

    const previous = outcomes.get(pair.name);
    if (previous !== undefined) {
      outcomes.set(pair.name, { ...previous, phoneListingId: publication.listingId });
    }

    reportPopulation(`smartphone ${pair.name}`, {
      canonicalVariants: page.page.variants.length,
      offersConverged: converged.materialized,
      scopedOffersConsidered: scopedComparison.offers.size,
      productOffersConsidered: wideComparison.offers.size,
    });
  });
});

describe('across the two locales and the two markets', () => {
  it('agrees on every RULE and disagrees on every STRING', () => {
    const [first, second] = PAIRS;
    const a = outcomes.get(first.name);
    const b = outcomes.get(second.name);
    if (a === undefined || b === undefined) throw new Error('both pairs must have composed');

    // The claim, asserted in both directions. Equality alone would pass against
    // a composer that had stopped localizing anything, and difference alone
    // would pass against one that had started varying a requirement by locale.
    expect(semanticFingerprint(a.footwearSchema)).toBe(semanticFingerprint(b.footwearSchema));
    expect(textFingerprint(a.footwearSchema)).not.toBe(textFingerprint(b.footwearSchema));

    // And the strings themselves, so the difference above is a TRANSLATION and
    // not two fallbacks landing on different steps of nothing.
    expect(a.footwearSchema.text.productTypeName?.value).toBe('Athletic footwear');
    expect(b.footwearSchema.text.productTypeName?.value).toBe('Calzado deportivo');
    // `es-MX` has no footwear translations of its own, so the regional tag falls
    // to its language and SAYS so — the fallback is reported, never silent.
    expect(b.footwearSchema.text.productTypeName?.effectiveLocale).toBe('es');
    expect(b.footwearSchema.text.productTypeName?.step).toBe('language');
    expect(a.footwearSchema.text.productTypeName?.step).toBe('exact');

    // Two ETags, because the locale is in the cache key even when two locales
    // resolve to identical bodies.
    expect(a.footwearSchema.etag).not.toBe(b.footwearSchema.etag);
  });

  it('narrows a comparison by CONFIGURATION, now that two sellers of one model exist', async () => {
    const productId = phones.handles.productIds.get('axon_9_pro');
    const [first, second] = PAIRS;
    if (productId === undefined) throw new Error('the seed minted no Axon 9 Pro');

    const wide = await rankOfferComparison({
      canonicalProductId: productId,
      comparisonCurrency: 'EUR',
      limit: 50,
    });
    const scoped = await rankOfferComparison({
      canonicalVariantId: canonicalVariantId(phones, first.phone.variantKey),
      comparisonCurrency: 'EUR',
      limit: 50,
    });
    // Both pairs have published a DIFFERENT configuration of the same model, so
    // the product-wide read considers strictly more than either configuration
    // does. This is the control the per-pair case could not make: the first pair
    // to run is momentarily the only seller, and wide == scoped is correct then.
    expect(wide.offers.size).toBe(PAIRS.length);
    expect(scoped.offers.size).toBe(1);
    expect(wide.offers.size).toBeGreaterThan(scoped.offers.size);
    expect(canonicalVariantId(phones, first.phone.variantKey)).not.toBe(
      canonicalVariantId(phones, second.phone.variantKey),
    );
  });

  it('published four independent listings, two per market', async () => {
    const listingIds = new Set<string>();
    for (const pair of PAIRS) {
      const recorded = outcomes.get(pair.name);
      if (recorded === undefined) throw new Error(`${pair.name} did not run`);
      listingIds.add(recorded.footwearListingId);
      listingIds.add(recorded.phoneListingId);
    }
    // Four distinct ids: nothing converged onto a sibling's listing.
    expect(listingIds.size).toBe(4);
    expect(listingIds.has('')).toBe(false);

    const markets = await db.execute<{ market: string; total: number }>(sql`
      select market, count(*)::int as total
      from catalog_authoring_drafts
      where store_id = ${storeId} and status = 'published'
      group by market order by market
    `);
    expect([...markets]).toEqual([
      { market: 'ES', total: 2 },
      { market: 'US', total: 2 },
    ]);

    const offers = await countOne(
      db,
      sql`select count(*)::int as total from offers o
          join listings l on l.id = o.listing_id
          where l.store_id = ${storeId} and o.status = 'active'`,
    );
    reportPopulation('the whole journey', {
      listings: listingIds.size,
      publishedDrafts: [...markets].reduce((sum, row) => sum + row.total, 0),
      activeOffers: offers,
      pairs: PAIRS.length,
    });
    // Two footwear configurations per pair plus one phone per pair.
    expect(offers).toBe(PAIRS.length * 3);
  });
});

/** Rolls a transaction back without being mistaken for a failure. */
class RollBack extends Error {
  constructor() {
    super('deliberate rollback');
    this.name = 'RollBack';
  }
}
