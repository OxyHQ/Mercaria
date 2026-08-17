/**
 * Offer-side search filters must be answered by ONE offer — issue #438.
 *
 * `market`, `kind`, `availability`, `condition` and `merchant` are columns on
 * `offers` and go into the ranking statement's scope, so they are same-offer by
 * construction. The two that cannot go there — a price bound, which needs a
 * conversion context, and the official-channel test, which needs #55's validity
 * window — were derived in a loop, each from the FIRST offer that satisfied it
 * INDEPENDENTLY. So a product passed `price <= X` AND `officialChannelOnly`
 * when its cheap offer was unofficial and its official offer was expensive, and
 * a shopper who asked for "official channel, under X" was handed a product
 * where neither was true of the thing they could actually buy.
 *
 * ## Why this file needs more than "the product is absent"
 *
 * A predicate that has stopped matching ANYTHING returns nothing too, and reads
 * identically green. Four things separate the two here:
 *
 * 1. a **crossed fixture** whose crossing is asserted from the real rows,
 *    including the naive per-requirement derivation the fix replaced, written
 *    out and shown to admit the product;
 * 2. a **positive control** — an aligned product, one offer satisfying both
 *    requirements, returned under exactly the same filters;
 * 3. **each half alone**, which returns the crossed product from each of its two
 *    offers, so both requirements are demonstrably live rather than jointly
 *    broken;
 * 4. an **unknown price** that satisfies no bound however generous, and is
 *    NAMED rather than silently dropped when its currency cannot be converted.
 *
 * ## A real server, because the fixture is the point
 *
 * The offers are real rows carrying real CHECK constraints, the relationship is
 * evaluated by `findCurrentRelationships`'s own SQL validity window, and the
 * assertions run through `runCanonicalSearch` — the public entry — rather than
 * against the internal shape, so this file is meaningful against the code
 * before the fix as well as after it.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every searchable string carries a per-run suffix so a parallel sibling's
 * fixtures cannot answer this file's queries, and teardown removes exactly what
 * was created, children first — every foreign key in this graph is RESTRICT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { SearchFilters, SearchResult } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { declaredOfferCondition } from '../../condition/condition-mapping.service.js';
import { merchants } from '../../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { brands } from '../../../db/schema/organizations.js';
import { offers } from '../../../db/schema/offers.js';
import { commerceRelationships } from '../../../db/schema/relationships.js';
import { runCanonicalSearch } from '../canonical-search.service.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, and part of every searchable string. */
const RUN = `sof${uuidv7().replace(/-/g, '').slice(-8)}`;

/** The fixed clock every fixture and every query shares. */
const NOW = new Date('2026-06-01T12:00:00.000Z');
const BEFORE = new Date(NOW.getTime() - 86_400_000);
const AFTER = new Date(NOW.getTime() + 86_400_000);

const OPERATOR = `oxy-user-${RUN}`;

/**
 * The bound, and the two prices placed either side of it.
 *
 * The official offer is deliberately ABOVE it and the cheap offer BELOW, so the
 * two requirements are satisfied by different rows and by nothing else.
 */
const MAX_MINOR = 50_000;
const CHEAP_MINOR = 10_000;
const EXPENSIVE_MINOR = 90_000;

/** A price filter every real price would clear — used to pin "unknown is not outside". */
const GENEROUS: SearchFilters['price'] = { currency: 'EUR', maxMinor: 900_000_000 };
const BOUND: SearchFilters['price'] = { currency: 'EUR', maxMinor: MAX_MINOR };

/**
 * ISO 4217's reserved TEST code, chosen because it is NOT in
 * `ALL_CURRENCY_CODES` while still clearing `offers_price_currency_check`'s
 * `^[A-Z]{3,4}$`. It makes "Mercaria cannot express this price in the bound's
 * currency" deterministic without reaching into the FX service.
 */
const UNCONVERTIBLE_CURRENCY = 'XTS';

const created = {
  relationships: [] as string[],
  offers: [] as string[],
  variants: [] as string[],
  products: [] as string[],
  brands: [] as string[],
  merchants: [] as string[],
  sources: [] as string[],
  sourceRecords: [] as string[],
};

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/** A sha-256-shaped digest; `canonical_variants_signature_shape_check` demands one. */
function signature(): string {
  return uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
}

const fixture = {
  brandId: '',
  officialMerchantId: '',
  outsiderMerchantId: '',
  sourceRecordId: '',
  crossedProductId: '',
  crossedVariantId: '',
  alignedProductId: '',
  unpricedProductId: '',
  unconvertibleProductId: '',
};

async function insertMerchant(label: string): Promise<string> {
  const [row] = await db
    .insert(merchants)
    .values({ name: `Zysof ${label} ${RUN}`, slug: `zysof-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (row === undefined) throw new Error('merchant insert returned no row');
  created.merchants.push(row.id);
  return row.id;
}

/** A canonical product plus its single variant — the pair every offer hangs off. */
async function insertProduct(suffix: string): Promise<{ productId: string; variantId: string }> {
  const name = `Zysofer ${RUN} ${suffix}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name,
      normalizedName: name.toLowerCase(),
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      brandId: fixture.brandId,
      searchTokens: [],
      status: 'active',
    })
    .returning({ id: canonicalProducts.id });
  if (product === undefined) throw new Error('product insert returned no row');
  created.products.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({ productId: product.id, signature: signature() })
    .returning({ id: canonicalVariants.id });
  if (variant === undefined) throw new Error('variant insert returned no row');
  created.variants.push(variant.id);

  return { productId: product.id, variantId: variant.id };
}

async function insertOffer(input: {
  canonicalVariantId: string;
  merchantId: string;
  priceAmount?: number;
  priceCurrency?: string;
}): Promise<string> {
  const priced =
    input.priceAmount === undefined
      ? {}
      : { priceAmount: input.priceAmount, priceCurrency: input.priceCurrency ?? 'EUR' };
  const [row] = await db
    .insert(offers)
    .values({
      kind: 'external',
      status: 'active',
      canonicalVariantId: input.canonicalVariantId,
      merchantId: input.merchantId,
      sourceRecordId: fixture.sourceRecordId,
      destinationUrl: 'https://example.test/product',
      provider: 'zysof-feed',
      externalOfferId: `offer-${uuidv7()}`,
      ...declaredOfferCondition('new'),
      ...priced,
      observedAt: NOW,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      staleAt: AFTER,
    })
    .returning({ id: offers.id });
  if (row === undefined) throw new Error('offer insert returned no row');
  created.offers.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();

  const brandName = `Zysofbrand ${RUN}`;
  const [brand] = await db
    .insert(brands)
    .values({
      name: brandName,
      normalizedName: brandName.toLowerCase(),
      slug: `zysofbrand-${RUN}`,
    })
    .returning({ id: brands.id });
  if (brand === undefined) throw new Error('brand insert returned no row');
  fixture.brandId = brand.id;
  created.brands.push(brand.id);

  fixture.officialMerchantId = await insertMerchant('official');
  fixture.outsiderMerchantId = await insertMerchant('outsider');

  // The official channel, verified and OPEN — `findCurrentRelationships`
  // evaluates `valid_from <= at` and `valid_to is null or > at` in SQL, so the
  // window is real rather than inferred from `status`.
  const [relationship] = await db
    .insert(commerceRelationships)
    .values({
      kind: 'merchant_official_channel_for_brand',
      merchantId: fixture.officialMerchantId,
      brandId: fixture.brandId,
      territories: [],
      languages: [],
      validFrom: BEFORE,
      status: 'verified',
      verificationMethod: 'brand_statement',
      verifiedAt: BEFORE,
      verifiedByOxyUserId: OPERATOR,
      assertedByKind: 'catalog_operator',
    })
    .returning({ id: commerceRelationships.id });
  if (relationship === undefined) throw new Error('relationship insert returned no row');
  created.relationships.push(relationship.id);

  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `zysof-source-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (source === undefined) throw new Error('source insert returned no row');
  created.sources.push(source.id);

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `ext-${RUN}`,
      observedAt: NOW,
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      payload: {},
    })
    .returning({ id: sourceRecords.id });
  if (record === undefined) throw new Error('source record insert returned no row');
  fixture.sourceRecordId = record.id;
  created.sourceRecords.push(record.id);

  /* -- the crossed product: cheap-and-unofficial, official-and-expensive ---- */
  const crossed = await insertProduct('crossed');
  fixture.crossedProductId = crossed.productId;
  fixture.crossedVariantId = crossed.variantId;
  await insertOffer({
    canonicalVariantId: crossed.variantId,
    merchantId: fixture.outsiderMerchantId,
    priceAmount: CHEAP_MINOR,
  });
  await insertOffer({
    canonicalVariantId: crossed.variantId,
    merchantId: fixture.officialMerchantId,
    priceAmount: EXPENSIVE_MINOR,
  });

  /* -- the aligned product: ONE offer answering both ------------------------ */
  const aligned = await insertProduct('aligned');
  fixture.alignedProductId = aligned.productId;
  await insertOffer({
    canonicalVariantId: aligned.variantId,
    merchantId: fixture.officialMerchantId,
    priceAmount: CHEAP_MINOR,
  });

  /* -- an official offer with NO price at all ------------------------------- */
  const unpriced = await insertProduct('unpriced');
  fixture.unpricedProductId = unpriced.productId;
  await insertOffer({
    canonicalVariantId: unpriced.variantId,
    merchantId: fixture.officialMerchantId,
  });

  /* -- an official offer priced in a currency Mercaria cannot convert ------- */
  const unconvertible = await insertProduct('unconvertible');
  fixture.unconvertibleProductId = unconvertible.productId;
  await insertOffer({
    canonicalVariantId: unconvertible.variantId,
    merchantId: fixture.officialMerchantId,
    priceAmount: 30_000,
    priceCurrency: UNCONVERTIBLE_CURRENCY,
  });
}, 180_000);

afterAll(async () => {
  await db.delete(offers).where(inArray(offers.id, safeIds(created.offers)));
  await db
    .delete(commerceRelationships)
    .where(inArray(commerceRelationships.id, safeIds(created.relationships)));
  await deleteTestCanonicalRows(db, {
    variantIds: created.variants,
    productIds: created.products,
  });
  await db.delete(merchants).where(inArray(merchants.id, safeIds(created.merchants)));
  await db.delete(brands).where(inArray(brands.id, safeIds(created.brands)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(created.sourceRecords)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(created.sources)));
  await closePostgres();
});

/** Run the public entry with this file's own term and clock. */
async function search(filters: SearchFilters): Promise<readonly SearchResult[]> {
  const outcome = await runCanonicalSearch(
    { term: `Zysofer ${RUN}`, kinds: ['product'], filters, limit: 20, now: NOW },
    db,
  );
  return outcome.response.results;
}

function productIds(results: readonly SearchResult[]): string[] {
  return results.flatMap((result) =>
    result.kind === 'product' ? [result.canonicalProductId] : [],
  );
}

describe('an offer-side filter set is answered by ONE offer (#438)', () => {
  it('the fixture really is crossed, and the naive derivation admits it', async () => {
    // The fixture-validity assertion, read from the REAL rows rather than from
    // the numbers above, so editing a price cannot leave this file quietly
    // measuring an uncrossed pair. It writes out the per-requirement derivation
    // the fix replaced: "some offer is inside the bound" AND "some offer is
    // official", each answered independently.
    const rows = await db
      .select({
        priceAmount: offers.priceAmount,
        priceCurrency: offers.priceCurrency,
        merchantId: offers.merchantId,
      })
      .from(offers)
      .where(eq(offers.canonicalVariantId, fixture.crossedVariantId));

    expect(rows).toHaveLength(2);

    const withinBound = (row: (typeof rows)[number]): boolean =>
      row.priceCurrency === 'EUR' && row.priceAmount !== null && row.priceAmount <= MAX_MINOR;
    const official = (row: (typeof rows)[number]): boolean =>
      row.merchantId === fixture.officialMerchantId;

    // The naive answer — two independent existence tests — says YES.
    expect(rows.some(withinBound) && rows.some(official)).toBe(true);
    // The same-offer answer says NO: no single row clears both.
    expect(rows.some((row) => withinBound(row) && official(row))).toBe(false);
  });

  it('each requirement alone is live, and each is met by a DIFFERENT offer', async () => {
    // Both halves demonstrably work on this product, so the conjunction failing
    // below cannot be a filter that has stopped matching anything.
    expect(productIds(await search({ price: BOUND }))).toContain(fixture.crossedProductId);
    expect(productIds(await search({ officialChannelOnly: true }))).toContain(
      fixture.crossedProductId,
    );
  });

  it('REFUSES the crossed product when both requirements are asked together', async () => {
    // The bug: offer A is cheap and unofficial, offer B is official and
    // expensive, and no single offer is both.
    const ids = productIds(await search({ price: BOUND, officialChannelOnly: true }));
    expect(ids).not.toContain(fixture.crossedProductId);
  });

  it('still RETURNS a product whose ONE offer answers both', async () => {
    // The positive control for the assertion above: the same filters, a product
    // that genuinely satisfies them, and it survives.
    const ids = productIds(await search({ price: BOUND, officialChannelOnly: true }));
    expect(ids).toContain(fixture.alignedProductId);
  });

  it('drops the single-offer product when its one offer leaves the bound', async () => {
    const ids = productIds(
      await search({
        price: { currency: 'EUR', maxMinor: CHEAP_MINOR - 1 },
        officialChannelOnly: true,
      }),
    );
    expect(ids).not.toContain(fixture.alignedProductId);
  });
});

describe('an unknown price is neither inside a bound nor outside it', () => {
  it('an UNPRICED offer satisfies no bound, however generous', async () => {
    // A ceiling every real price would clear. An offer with no price still does
    // not satisfy it — the answer is "Mercaria cannot say", never a soft yes.
    const ids = productIds(await search({ price: GENEROUS }));
    expect(ids).not.toContain(fixture.unpricedProductId);
  });

  it('and the missing price does not disqualify it from a DIFFERENT filter', async () => {
    // The other half of "unknown is a third answer": the offer is official, and
    // an unknown price is not a reason to withhold that fact.
    const ids = productIds(await search({ officialChannelOnly: true }));
    expect(ids).toContain(fixture.unpricedProductId);
  });

  it('an UNCONVERTIBLE currency excludes the offer, and no conversion is invented', async () => {
    const outcome = await runCanonicalSearch(
      {
        term: `Zysofer ${RUN}`,
        kinds: ['product'],
        filters: { price: GENEROUS },
        limit: 20,
        now: NOW,
      },
      db,
    );
    // The safety property: a price Mercaria cannot express in the bound's
    // currency satisfies nothing, however generous the bound.
    expect(productIds(outcome.response.results)).not.toContain(fixture.unconvertibleProductId);

    // And nothing fabricates the conversion that did not happen: no rate was
    // ever requested for `XTS`, so no provider published anything about it.
    expect(outcome.response.fx?.provider).toBe('identity');
  });

  it('and the excluded currency is NAMED, as permanent rather than transient (#450)', async () => {
    // THE POSITIVE CONTROL, and it has to come first.
    //
    // Every assertion below is about a currency appearing in a list, and a list
    // assertion over a fixture that was never created fails LOUDLY — but the
    // absence assertion in the test above passes silently in exactly that case.
    // So prove the offer is real and reachable before asking what a price filter
    // says about it: with no price filter there is nothing to convert, and the
    // product must come back.
    const unfiltered = productIds(await search({}));
    expect(unfiltered).toContain(fixture.unconvertibleProductId);

    const outcome = await runCanonicalSearch(
      {
        term: `Zysofer ${RUN}`,
        kinds: ['product'],
        filters: { price: GENEROUS },
        limit: 20,
        now: NOW,
      },
      db,
    );

    // #70's "the exclusion is visible rather than silent" now holds for a
    // currency Mercaria does not model at all, which used to be dropped without
    // reaching the DTO, the logs or even the types (#450). The context is
    // emitted although no rate map was fetched: gating it on one is what made
    // absence mean two different things.
    const fx = outcome.response.fx;
    expect(fx).toBeDefined();
    expect(fx?.unconvertibleCurrencies).toContain(UNCONVERTIBLE_CURRENCY);

    // The PERMANENT/transient split, which is the whole point of reporting it.
    // A missing rate heals on the next `getRates`; an unmodelled currency is
    // invisible under every price filter until somebody adds the code, and the
    // two are indistinguishable to a seller unless the surface says which.
    expect(fx?.unmodelledCurrencies).toContain(UNCONVERTIBLE_CURRENCY);

    // The subset relation the two fields are projected under. Stated here rather
    // than assumed, because a reader of `unconvertibleCurrencies` alone must
    // still see the complete exclusion set — that is why this is a subset and
    // not a second disjoint list.
    for (const code of fx?.unmodelledCurrencies ?? []) {
      expect(fx?.unconvertibleCurrencies).toContain(code);
    }
  });
});
