/**
 * A suppressed canonical entity stops being served — #367 line 366.
 *
 * ## What this measures that nothing else did
 *
 * `curation-writes.realdb.test.ts` already proves `suppressEntity` writes
 * `status = 'suppressed'`, records who and why, and leaves every piece of
 * evidence in place. That is the WRITE. Nothing anywhere asserted the
 * CONSEQUENCE — that the thing is then actually hidden — and the two are not the
 * same fact: a status column nobody reads is a status column that hides nothing.
 *
 * The epic line is "revalidate links when canonical entities merge/deprecate
 * without breaking listings/offers". The MERGE half is already held, by
 * `merge.service.ts`'s `verify` phase: it re-runs every `MERGE_REHOMING_PLAN`
 * target and throws on a residual, so a `native_listing_links` row stranded on a
 * tombstone fails the job. The DEPRECATE half is what this file is about, and it
 * is a READ-side property rather than a sweep — see the note on
 * `liftEntitySuppression` below for why it must not be a sweep.
 *
 * ## Each case's two directions
 *
 * A "suppressed offers are hidden" assertion is satisfied by a read that returns
 * nothing at all — a broken query, an empty fixture, a teardown that ran early.
 * So every case here reads the SAME scope twice: once while the entity is
 * visible (which must return the offer) and once while it is suppressed (which
 * must not). The control is what makes the subject mean something.
 *
 * `restores what it hid` covers the opposite failure: a fix that filtered
 * everything, or that keyed on a column a lift does not clear, passes the first
 * two directions and is still wrong.
 *
 * ## The two width guards, both of which are live hazards
 *
 * `discontinued` is deliberately SHOPPER-VISIBLE — `CanonicalCatalogStatus`
 * calls it "a real-world fact a source can observe, distinct from Mercaria
 * deciding not to show it", and `SHOPPER_VISIBLE_CATALOG_STATUSES` includes it
 * on purpose. A predicate narrowed to `status = 'active'` would delist every
 * discontinued product's offers while looking more careful, which is the
 * safe-looking direction of error `retail_suppressions` records in
 * `merge-plan.ts`. `keeps a discontinued product's offers` is the case that
 * fails if somebody writes it.
 *
 * A merge TOMBSTONE must still resolve to its winner: ADR 0002 D12/D16 keep the
 * loser's slug forever so an old link works, and `resolveProductRow` walks the
 * chain. A visibility check placed BEFORE that resolution would 404 every
 * shared link to a merged product. `follows a tombstone to its winner` is that
 * guard.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { merchants } from '../../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { offers } from '../../../db/schema/offers.js';
import { catalogEntitySuppressions } from '../../../db/schema/curation.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { declaredOfferCondition } from '../../condition/condition-mapping.service.js';
import { listOffers } from '../../offers/offer.service.js';
import { getPublicCanonicalProduct } from '../../canonical/canonical-product.service.js';
import { suppressEntity, liftEntitySuppression } from '../correction.service.js';

const RUN = uuidv7().slice(-12);
const OPERATOR = `op-suppress-${RUN}`;

let db: Database;

const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdSourceIds: string[] = [];
const createdSourceRecordIds: string[] = [];
const createdOfferIds: string[] = [];

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // Children first: `offers.canonical_variant_id` is RESTRICT from the canonical
  // side, so the offers go before anything canonical does.
  await db.delete(offers).where(inArray(offers.id, safeIds(createdOfferIds)));
  // The suppression register goes; the TIMELINE deliberately stays.
  //
  // `catalog_revisions` is append-only against DELETE as well as UPDATE, by
  // `mercaria_catalog_revision_append_only` — "a row that can be rewritten is not
  // a record" (#59 acceptance 4). A teardown that tried to clear it failed with
  // 23514, which is the trigger working: no test may quietly acquire the one
  // power an operator does not have. Both tables are POLYMORPHIC — `entity_id` is
  // a plain `text()` with no foreign key — so the residue blocks nothing here or
  // in any sibling file, which is what makes leaving it correct rather than
  // merely unavoidable.
  // `canonical_products.merged_into_id` is a SELF reference, so a tombstone
  // pointing at a sibling would block that sibling's delete. Cleared first —
  // and the STATUS has to move with it: `canonical_products_merged_state_check`
  // is a biconditional, so nulling the pointer alone is refused with 23514 and
  // takes the whole teardown down with it. Measured on this file's first run.
  await db
    .update(canonicalProducts)
    .set({ status: 'active', mergedIntoId: null })
    .where(inArray(canonicalProducts.id, safeIds(createdProductIds)));

  const suppressionSubjects = safeIds([...createdProductIds, ...createdVariantIds]);
  await db
    .delete(catalogEntitySuppressions)
    .where(inArray(catalogEntitySuppressions.entityId, suppressionSubjects));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(createdSourceRecordIds)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A canonical product, one variant, and one ACTIVE external offer on it.
 *
 * EXTERNAL rather than native, deliberately: the read under test
 * (`listOffersForComparison`) does not branch on `kind`, so an external offer is
 * the same measurement with a store, a listing, a product variant and a
 * `native_listing_links` row fewer — and every one of those is a teardown edge
 * that could fail for a reason that says nothing about suppression.
 */
async function seedProductWithOffer(label: string): Promise<{
  productId: string;
  variantId: string;
  offerId: string;
  slug: string;
}> {
  const slug = `suppression-${label}-${RUN}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Suppression ${label} ${RUN}`,
      normalizedName: `suppression ${label} ${RUN}`,
      slug,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('seedProductWithOffer produced no product');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      // `canonical_variants_signature_shape_check` wants a sha-256-shaped
      // digest; it only has to be unique per product.
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('seedProductWithOffer produced no variant');
  createdVariantIds.push(variant.id);

  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Merchant ${label} ${RUN}`, slug: `merchant-supp-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('seedProductWithOffer produced no merchant');
  createdMerchantIds.push(merchant.id);

  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `suppression-source-${label}-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('seedProductWithOffer produced no source');
  createdSourceIds.push(source.id);

  const now = new Date();
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `ext-supp-${label}-${RUN}`,
      observedAt: now,
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      payload: { price: 119_900 },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('seedProductWithOffer produced no source record');
  createdSourceRecordIds.push(record.id);

  const [offer] = await db
    .insert(offers)
    .values({
      kind: 'external',
      status: 'active',
      canonicalVariantId: variant.id,
      merchantId: merchant.id,
      sourceRecordId: record.id,
      ...declaredOfferCondition('new'),
      destinationUrl: 'https://example.test/product',
      provider: 'test-feed',
      externalOfferId: `offer-supp-${uuidv7()}`,
      priceAmount: 119_900,
      priceCurrency: 'EUR',
      observedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      staleAt: new Date(now.getTime() + 86_400_000),
    })
    .returning({ id: offers.id });
  if (!offer) throw new Error('seedProductWithOffer produced no offer');
  createdOfferIds.push(offer.id);

  return { productId: product.id, variantId: variant.id, offerId: offer.id, slug };
}

/** The ids `GET /offers` serves for one canonical PRODUCT. */
async function servedForProduct(productId: string): Promise<string[]> {
  const page = await listOffers({ canonicalProductId: productId, limit: 50 }, db);
  return page.offers.map((offer) => offer.id);
}

/** The ids `GET /offers` serves for one canonical VARIANT. */
async function servedForVariant(variantId: string): Promise<string[]> {
  const page = await listOffers({ canonicalVariantId: variantId, limit: 50 }, db);
  return page.offers.map((offer) => offer.id);
}

// ── The subject ─────────────────────────────────────────────────────────────

describe('a suppressed canonical entity stops being served', () => {
  it('hides a suppressed PRODUCT from the comparison read, and served it before', async () => {
    const seeded = await seedProductWithOffer('product');

    // The control. Without it, the assertion below is satisfied by a read that
    // returns nothing for any reason at all.
    expect(await servedForProduct(seeded.productId)).toEqual([seeded.offerId]);

    await suppressEntity({
      entityType: 'canonical_product',
      entityId: seeded.productId,
      reason: 'pending_investigation',
      note: null,
      actorOxyUserId: OPERATOR,
    });

    expect(await servedForProduct(seeded.productId)).toEqual([]);
  });

  it('hides a suppressed VARIANT from the variant scope, and served it before', async () => {
    const seeded = await seedProductWithOffer('variant');

    expect(await servedForVariant(seeded.variantId)).toEqual([seeded.offerId]);

    await suppressEntity({
      entityType: 'canonical_variant',
      entityId: seeded.variantId,
      reason: 'pending_investigation',
      note: null,
      actorOxyUserId: OPERATOR,
    });

    expect(await servedForVariant(seeded.variantId)).toEqual([]);
  });

  it('hides a suppressed VARIANT from its PRODUCT scope too — the semi-join', async () => {
    // The product-scoped read reaches its offers through
    // `select id from canonical_variants where product_id = X`, which is a
    // SECOND place the status has to be consulted. A fix applied only to the
    // variant scope passes the case above and leaves the product page showing
    // the suppressed configuration's price.
    const seeded = await seedProductWithOffer('semijoin');

    expect(await servedForProduct(seeded.productId)).toEqual([seeded.offerId]);

    await suppressEntity({
      entityType: 'canonical_variant',
      entityId: seeded.variantId,
      reason: 'data_quality',
      note: null,
      actorOxyUserId: OPERATOR,
    });

    expect(await servedForProduct(seeded.productId)).toEqual([]);
  });

  it('restores what it hid when the suppression is lifted', async () => {
    // The direction a filter-everything fix fails. It also pins that the read
    // consults the ENTITY's status rather than the register row: a lift closes
    // the register entry AND sets the status back to `active`, and a predicate
    // keyed on the register would restore nothing here.
    const seeded = await seedProductWithOffer('lift');

    await suppressEntity({
      entityType: 'canonical_product',
      entityId: seeded.productId,
      reason: 'pending_investigation',
      note: null,
      actorOxyUserId: OPERATOR,
    });
    expect(await servedForProduct(seeded.productId)).toEqual([]);

    await liftEntitySuppression({
      entityType: 'canonical_product',
      entityId: seeded.productId,
      reason: 'investigation closed',
      actorOxyUserId: OPERATOR,
    });

    expect(await servedForProduct(seeded.productId)).toEqual([seeded.offerId]);
  });
});

// ── The width guards ────────────────────────────────────────────────────────

describe('the visibility predicate is exactly the shopper-visible set', () => {
  it("keeps a DISCONTINUED product's offers — it is not a decision to hide", async () => {
    // `SHOPPER_VISIBLE_CATALOG_STATUSES` includes `discontinued` deliberately:
    // the maker stopping production is a fact about the world, and the offers on
    // it say what is still buyable. A predicate written as `status = 'active'`
    // is what this case exists to fail.
    const seeded = await seedProductWithOffer('discontinued');

    await db
      .update(canonicalProducts)
      .set({ status: 'discontinued' })
      .where(eq(canonicalProducts.id, seeded.productId));

    expect(await servedForProduct(seeded.productId)).toEqual([seeded.offerId]);
  });

  it('keeps a DRAFT product hidden — the other end of the same set', async () => {
    // The positive control for the guard above: it proves the predicate is the
    // shopper-visible SET rather than "everything except suppressed", which
    // would let #60's unreviewed provisional rows reach a comparison.
    const seeded = await seedProductWithOffer('draft');

    expect(await servedForProduct(seeded.productId)).toEqual([seeded.offerId]);

    await db
      .update(canonicalProducts)
      .set({ status: 'draft' })
      .where(eq(canonicalProducts.id, seeded.productId));

    expect(await servedForProduct(seeded.productId)).toEqual([]);
  });
});

// ── Tombstone resolution happens BEFORE the visibility check ────────────────

describe('a merged loser still reaches its winner', () => {
  it('resolves an old link to the winner, whose offers are still served', async () => {
    // The ordering this pins: `resolveProductRow` walks the merge chain, and the
    // visibility predicate is applied to what it LANDS ON. Reversed — visibility
    // first — every shared link to a merged product would 404, because a
    // tombstone is `merged` and `merged` is not shopper-visible. Without this
    // case that ordering is a sentence in a docblock.
    //
    // The loser deliberately KEEPS its own offer. A completed merge repoints
    // offers in the `offers` phase and only stamps the tombstone later, in
    // `redirects`, so this is not a state a finished merge leaves behind — which
    // is exactly why it is worth asserting: it makes "the tombstone serves
    // nothing" a fact about the predicate rather than a fact about the fixture
    // having no rows to serve.
    const winner = await seedProductWithOffer('merge-winner');
    const loser = await seedProductWithOffer('merge-loser');

    // Controls, before anything is merged: both are ordinary products and both
    // serve their own offer.
    expect(await servedForProduct(winner.productId)).toEqual([winner.offerId]);
    expect(await servedForProduct(loser.productId)).toEqual([loser.offerId]);

    await db
      .update(canonicalProducts)
      .set({ status: 'merged', mergedIntoId: winner.productId })
      .where(eq(canonicalProducts.id, loser.productId));

    // 1. The old link still resolves — by the loser's own slug, which ADR 0002
    //    D12 keeps forever precisely so a shared URL survives a merge.
    const resolved = await getPublicCanonicalProduct(loser.slug);
    expect(resolved?.id).toBe(winner.productId);

    // 2. The winner it resolved to is still served. This is the half that fails
    //    if the visibility predicate is applied before the chain walk.
    expect(await servedForProduct(winner.productId)).toEqual([winner.offerId]);

    // 3. …and the tombstone's OWN offers are not served, even though it still
    //    holds one. Non-vacuous by construction — see the note above.
    expect(await servedForProduct(loser.productId)).toEqual([]);
  });
});
