/**
 * The condition taxonomy against a REAL PostgreSQL database — #90's acceptance
 * criteria, every one of which is held by a CHECK, a partial unique index, a
 * composite foreign key or a trigger that has no counterpart under a mocked
 * repository.
 *
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright, so everything in this file is a property of the DDL rather than of
 * the code that happens to call it:
 *
 *  - **acceptance 4 — a catalogue image can never be condition evidence.** The
 *    trigger refuses a `file_id` a `canonical_images` row already claims, which
 *    is the one attack the provenance vocabulary cannot see: a seller attaching
 *    the manufacturer's own product shot.
 *  - **migration rule 2 — an unrefined assertion cannot carry a claim.** The
 *    CHECK refuses `migrated_binary` beside `used_like_new`, and admits it
 *    beside `used_good`, so the constraint is restrictive rather than
 *    universally refusing.
 *  - **acceptance 5 — a low-confidence external mapping never becomes a
 *    condition.** The five shape CHECKs, each exercised on the shape it exists
 *    to refuse AND on the legitimate one beside it.
 *  - **acceptance 3 and migration rule 3 — an order's condition snapshot is
 *    never rewritten.** Every UPDATE of the three columns is refused, including
 *    the NULL → value one a backfill would perform.
 *  - **evidence rule 8 — the revision trail is append-only**, and its DELETE
 *    exception is precisely the listing's own cascade.
 *  - **migration rule 5 — a published mapping ruleset is frozen**, rules
 *    included, so a correction is a new version rather than a rewrite of what an
 *    old observation was read under.
 *  - **a photo can only evidence a defect on its OWN listing** — the composite
 *    foreign key, which is the reason `listing_condition_details` carries a
 *    `UNIQUE(id, listing_id)` nothing else reads.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every id this file writes carries a per-run suffix and
 * teardown deletes exactly what it created, children first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { CONDITION_MAPPING_CONFIDENCE_FLOOR } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { insertOrder } from '../orders/orderRepository.js';
import { categories, listings } from '../schema/catalog.js';
import { canonicalImages, canonicalProducts } from '../schema/canonicalCatalog.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';
import { orderItems, orders } from '../schema/orders.js';
import { offers } from '../schema/offers.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';
import { merchants } from '../schema/merchants.js';
import {
  conditionCategoryPolicies,
  conditionMappingRulesets,
  conditionSourceMappings,
  listingConditionDetails,
  listingConditionPhotos,
  listingConditionRevisions,
} from '../schema/condition.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdOrderIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdProductIds: string[] = [];
const createdImageIds: string[] = [];
const createdSourceRecordIds: string[] = [];
const createdSourceIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (createdOrderIds.length > 0) {
    await db.delete(orderItems).where(inArray(orderItems.orderId, createdOrderIds));
    await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  }
  if (createdListingIds.length > 0) {
    // The condition children all cascade from the listing, and the revision
    // trigger's DELETE exception is exactly this path — so this teardown is
    // itself one of the assertions, and a regression in the trigger fails the
    // run rather than leaking rows.
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  if (createdOfferIds.length > 0) {
    await db.delete(offers).where(inArray(offers.id, createdOfferIds));
  }
  if (createdVariantIds.length > 0) {
    // Offers RESTRICT their canonical variant, so any that survived a refused
    // insert must go first — and an offer this file created that is still here
    // would fail the delete loudly rather than leaking.
    await db.delete(offers).where(inArray(offers.canonicalVariantId, createdVariantIds));
    await deleteTestCanonicalRows(db, { variantIds: createdVariantIds });
  }
  if (createdMerchantIds.length > 0) {
    await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  }
  if (createdRulesetIds.length > 0) {
    // A PUBLISHED ruleset refuses both the demotion and the delete, by design —
    // that immutability is the property under test. So only the drafts are
    // removed and the published ones are left behind, scoped by their per-run
    // version numbers: the `ledger.realdb.test.ts` rule, applied to the same
    // class of row.
    const drafts = await db
      .select({ id: conditionMappingRulesets.id })
      .from(conditionMappingRulesets)
      .where(
        and(
          inArray(conditionMappingRulesets.id, createdRulesetIds),
          eq(conditionMappingRulesets.state, 'draft'),
        ),
      );
    const draftIds = drafts.map((row) => row.id);
    if (draftIds.length > 0) {
      await db
        .delete(conditionSourceMappings)
        .where(inArray(conditionSourceMappings.rulesetId, draftIds));
      await db.delete(conditionMappingRulesets).where(inArray(conditionMappingRulesets.id, draftIds));
    }
  }
  if (createdImageIds.length > 0) {
    await db.delete(canonicalImages).where(inArray(canonicalImages.id, createdImageIds));
  }
  await deleteTestCanonicalRows(db, { productIds: createdProductIds });
  if (createdSourceRecordIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.id, createdSourceRecordIds));
  }
  if (createdSourceIds.length > 0) {
    await db.delete(catalogSources).where(inArray(catalogSources.id, createdSourceIds));
  }
  if (createdCategoryIds.length > 0) {
    await db
      .delete(conditionCategoryPolicies)
      .where(inArray(conditionCategoryPolicies.categoryId, createdCategoryIds));
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
});

async function seedListing(
  overrides: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `seller-${RUN}`,
      storeId: null,
      title: `Condition fixture ${RUN}`,
      description: 'A fixture listing.',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
      categorySlugs: [],
      tags: [],
      publishedAt: new Date(),
      ...overrides,
    })
    .returning({ id: listings.id });
  createdListingIds.push(row.id);
  return row.id;
}


const createdVariantIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdOfferIds: string[] = [];

/** A canonical product + variant, the minimum an offer row can attach to. */
async function seedCanonicalVariant(): Promise<string> {
  const label = uuidv7().slice(-8);
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Offer product ${label}`,
      normalizedName: `offer product ${label}`,
      slug: `offer-product-${label}`,
    })
    .returning({ id: canonicalProducts.id });
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      // `canonical_variants_signature_shape_check` wants a sha-256-shaped
      // digest; the value only has to be unique per product.
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  createdVariantIds.push(variant.id);
  return variant.id;
}

let sharedSourceRecordId: string | undefined;

/** A `source_records` row an external offer can name. Minted once per run. */
async function seedSourceRecord(): Promise<string> {
  if (sharedSourceRecordId) return sharedSourceRecordId;
  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `offer-source-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  createdSourceIds.push(source.id);

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `offer-rec-${RUN}`,
      observedAt: new Date(),
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'b').slice(0, 64),
    })
    .returning({ id: sourceRecords.id });
  createdSourceRecordIds.push(record.id);
  sharedSourceRecordId = record.id;
  return record.id;
}

async function seedMerchant(): Promise<string> {
  const label = uuidv7().slice(-8);
  const [row] = await db
    .insert(merchants)
    .values({ name: `Offer merchant ${label}`, slug: `offer-merchant-${label}` })
    .returning({ id: merchants.id });
  createdMerchantIds.push(row.id);
  return row.id;
}

/** A DRAFT mapping ruleset, so its rules stay editable within one test. */
async function seedRuleset(provider: 'shopify' | 'woocommerce' | 'etsy' | 'prestashop'): Promise<string> {
  const [row] = await db
    .insert(conditionMappingRulesets)
    .values({ provider, version: 100_000 + Math.floor(Math.random() * 500_000) })
    .returning({ id: conditionMappingRulesets.id });
  createdRulesetIds.push(row.id);
  return row.id;
}

describe('#90 acceptance 4 — a catalogue image is never condition evidence', () => {
  it('refuses a condition photo whose file id belongs to a canonical image', async () => {
    const [source] = await db
      .insert(catalogSources)
      .values({
        kind: 'feed',
        name: `condition-source-${RUN}`,
        mayDisplay: true,
        mayStore: true,
        attributionRequired: false,
      })
      .returning({ id: catalogSources.id });
    createdSourceIds.push(source.id);

    const [record] = await db
      .insert(sourceRecords)
      .values({
        sourceId: source.id,
        externalType: 'product',
        externalId: `cond-rec-${RUN}`,
        observedAt: new Date(),
        contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      })
      .returning({ id: sourceRecords.id });
    createdSourceRecordIds.push(record.id);

    const [product] = await db
      .insert(canonicalProducts)
      .values({
        name: `Condition product ${RUN}`,
        normalizedName: `condition product ${RUN}`,
        slug: `cond-product-${RUN}`,
      })
      .returning({ id: canonicalProducts.id });
    createdProductIds.push(product.id);

    const stockPhotoFileId = `stock-photo-${RUN}`;
    const [image] = await db
      .insert(canonicalImages)
      .values({ productId: product.id, fileId: stockPhotoFileId, sourceRecordId: record.id })
      .returning({ id: canonicalImages.id });
    createdImageIds.push(image.id);

    const listingId = await seedListing();

    /**
     * The whole point of the trigger. This file id is a perfectly ordinary Oxy
     * media id and the provenance is a legitimate, seller-owned value — nothing
     * in the type system or the vocabulary can tell that it is the
     * manufacturer's product shot. Only the cross-table lookup can.
     */
    await expect(
      db.insert(listingConditionPhotos).values({
        listingId,
        fileId: stockPhotoFileId,
        provenance: 'seller_uploaded',
        uploadedByOxyUserId: `seller-${RUN}`,
        uploadedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);

    // The positive control: the SAME insert with a file id no canonical image
    // claims succeeds, so the trigger is restrictive rather than refusing every
    // photograph — which would pass the assertion above for the wrong reason.
    const [ownPhoto] = await db
      .insert(listingConditionPhotos)
      .values({
        listingId,
        fileId: `sellers-own-${RUN}`,
        provenance: 'seller_uploaded',
        uploadedByOxyUserId: `seller-${RUN}`,
        uploadedAt: new Date(),
      })
      .returning({ id: listingConditionPhotos.id });
    expect(ownPhoto.id).toBeTruthy();
  });

  it('refuses a photo that is UPDATED onto a catalogue file id', async () => {
    // The insert path is the obvious one; an update of `file_id` is the way
    // round it, which is why the trigger fires on `UPDATE OF file_id` too.
    const listingId = await seedListing();
    const [photo] = await db
      .insert(listingConditionPhotos)
      .values({
        listingId,
        fileId: `initially-fine-${RUN}`,
        provenance: 'seller_captured',
        uploadedByOxyUserId: `seller-${RUN}`,
        uploadedAt: new Date(),
      })
      .returning({ id: listingConditionPhotos.id });

    await expect(
      db
        .update(listingConditionPhotos)
        .set({ fileId: `stock-photo-${RUN}` })
        .where(eq(listingConditionPhotos.id, photo.id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a second evidence row for the same (listing, file)', async () => {
    const listingId = await seedListing();
    const fileId = `dupe-${RUN}`;
    const values = {
      listingId,
      fileId,
      provenance: 'seller_uploaded' as const,
      uploadedByOxyUserId: `seller-${RUN}`,
      uploadedAt: new Date(),
    };
    await db.insert(listingConditionPhotos).values(values);
    // Without this, a seller re-submitting one photograph would double the count
    // the evidence gate reads and satisfy a two-photo requirement with one.
    await expect(db.insert(listingConditionPhotos).values(values)).rejects.toSatisfy(
      isUniqueViolation,
    );
  });
});

describe('#90 migration rule 2 — an unrefined assertion cannot claim', () => {
  it('refuses `migrated_binary` beside `used_like_new`', async () => {
    await expect(
      seedListing({ condition: 'used_like_new', conditionAssertion: 'migrated_binary' }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a v1 client write claiming a refurbished condition', async () => {
    await expect(
      seedListing({
        condition: 'refurbished_manufacturer',
        conditionAssertion: 'legacy_client_binary',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('ADMITS the two conservative keys, so the CHECK is restrictive not universal', async () => {
    // The vacuity guard. A constraint refusing every migrated row would pass
    // both assertions above and would have failed the migration itself.
    await expect(
      seedListing({ condition: 'used_good', conditionAssertion: 'migrated_binary' }),
    ).resolves.toBeTruthy();
    await expect(
      seedListing({ condition: 'new', conditionAssertion: 'migrated_binary' }),
    ).resolves.toBeTruthy();
  });

  it('ADMITS a seller declaring `used_like_new` — a human may make that claim', async () => {
    await expect(
      seedListing({ condition: 'used_like_new', conditionAssertion: 'seller_declared' }),
    ).resolves.toBeTruthy();
  });

  it('refuses a source label beside a seller-declared condition', async () => {
    await expect(
      seedListing({ conditionAssertion: 'seller_declared', conditionSourceLabel: 'Gebraucht' }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('#90 acceptance 3 — an order snapshot is never rewritten', () => {
  /**
   * One order, through the REAL writer.
   *
   * `insertOrder` rather than raw column names, so the snapshot columns are
   * exercised on the path checkout actually takes — a fixture that typed the
   * flattened `totals_*` columns by hand would still pass if the repository
   * stopped writing the condition at all.
   */
  async function seedOrderItem(condition: {
    conditionKey?: 'used_good';
    conditionAssertion?: 'seller_declared';
    conditionNotes?: string;
  }): Promise<string> {
    const money = (amount: number) => ({
      shop: { amount, currency: 'EUR' as const },
      presentment: { amount, currency: 'EUR' as const },
    });

    const order = await insertOrder({
      orderNumber: `MRC-COND-${uuidv7().slice(-8)}`,
      buyerOrigin: 'oxy',
      buyerOxyUserId: `buyer-${RUN}`,
      sellerType: 'user',
      commercialRole: 'connected_marketplace',
      sellerOxyUserId: `seller-${RUN}`,
      items: [
        {
          listingId: uuidv7(),
          variantId: uuidv7(),
          title: 'A used thing',
          variantTitle: 'Default Title',
          optionValues: [],
          unitPrice: money(1_000),
          quantity: 1,
          lineTotal: money(1_000),
          ...condition,
        },
      ],
      shippingAddress: {
        recipientName: 'Buyer',
        line1: '1 Street',
        city: 'Barcelona',
        postalCode: '08001',
        country: 'ES',
      },
      shippingMethod: 'standard',
      shippingLabel: 'Standard shipping',
      shippingCost: money(0),
      totals: {
        subtotal: money(1_000),
        discountTotal: money(0),
        shipping: money(0),
        tax: money(0),
        grandTotal: money(1_000),
      },
      status: 'paid',
      paymentStatus: 'paid',
      checkoutGroupId: uuidv7(),
      // #106's `order_status_history_actor_check` demands that an `oxy` actor
      // name its account — the same "a person is named" shape #90's own
      // revision CHECK enforces one table over.
      statusHistory: [
        { status: 'paid', at: new Date(), actorKind: 'oxy', byOxyUserId: `buyer-${RUN}` },
      ],
      appliedDiscounts: [],
      taxLines: [],
    });
    createdOrderIds.push(order.id);
    return order.items[0].id;
  }

  it('refuses to change a recorded condition', async () => {
    const itemId = await seedOrderItem({
      conditionKey: 'used_good',
      conditionAssertion: 'seller_declared',
      conditionNotes: 'cosmetic_wear (light)',
    });

    await expect(
      db.update(orderItems).set({ conditionKey: null }).where(eq(orderItems.id, itemId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .update(orderItems)
        .set({ conditionNotes: 'nothing wrong with it' })
        .where(eq(orderItems.id, itemId)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a BACKFILL of a pre-#90 line, which is the whole of migration rule 3', async () => {
    // The weaker "immutable once set" rule would permit exactly this, and it is
    // the one thing #90 says must not happen: an order placed before the
    // taxonomy existed has no condition, and its honest answer is "not recorded
    // at purchase".
    const itemId = await seedOrderItem({});
    await expect(
      db
        .update(orderItems)
        .set({ conditionKey: 'used_good', conditionAssertion: 'seller_declared' })
        .where(eq(orderItems.id, itemId)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('still permits an ordinary UPDATE that leaves the snapshot alone', async () => {
    // Vacuity: a trigger refusing every update to `order_items` would satisfy
    // both cases above while measuring nothing about the condition columns
    // specifically.
    //
    // This used to add "and would break refunds, which patch other columns".
    // That is not true and was measured in #375: NO production code path
    // updates `order_items` at all — a refund writes `refund_line_items` and
    // restocks `inventory_levels`. The guard is right and stays; its stated
    // reason was wrong. What actually depends on `position` remaining writable
    // is this case and the matching control in
    // `commerce-history-immutability.realdb.test.ts`, and #375 froze the other
    // twenty columns precisely because nothing writes them.
    const itemId = await seedOrderItem({
      conditionKey: 'used_good',
      conditionAssertion: 'seller_declared',
    });
    await expect(
      db.update(orderItems).set({ position: 3 }).where(eq(orderItems.id, itemId)),
    ).resolves.toBeDefined();
  });

  it('refuses half a snapshot — a key with no assertion', async () => {
    await expect(seedOrderItem({ conditionKey: 'used_good' })).rejects.toSatisfy(isCheckViolation);
  });
});

describe('#90 acceptance 5 — a sub-floor mapping never carries a key', () => {
  /**
   * The five `offers_condition_*_shape_check` constraints, each on the exact
   * shape it exists to refuse.
   *
   * They are what make evidence rule 6 unrepresentable rather than a promise the
   * mapper keeps: there is no column combination expressing "we think it is
   * refurbished but are not confident", so a mapper bug, a replay and a manual
   * `UPDATE` all fail instead of putting a guess on a product page.
   */
  async function seedOffer(condition: {
    condition: (typeof offers.$inferInsert)['condition'];
    conditionSourceLabel?: string;
    conditionMappingState: (typeof offers.$inferInsert)['conditionMappingState'];
    conditionMappingConfidence?: number;
    conditionMappingRulesetId?: string;
  }): Promise<unknown> {
    const now = new Date();
    const inserted = await db.insert(offers).values({
      kind: 'external',
      status: 'active',
      canonicalVariantId: await seedCanonicalVariant(),
      merchantId: await seedMerchant(),
      // `offers_kind_shape_check` demands all three of an `external` offer, and
      // a fixture that skipped them would fail on the WRONG constraint — which
      // is exactly the trap the repo's `expectRefused` helper exists to avoid.
      sourceRecordId: await seedSourceRecord(),
      destinationUrl: 'https://example.test/product',
      provider: 'test-feed',
      externalOfferId: `cond-offer-${uuidv7().slice(-10)}`,
      observedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      staleAt: new Date(now.getTime() + 86_400_000),
      ...condition,
    }).returning({ id: offers.id });
    for (const row of inserted) createdOfferIds.push(row.id);
    return inserted;
  }

  it('refuses a `review_pending` row that carries a taxonomy key', async () => {
    const ruleset = await seedRuleset('shopify');
    await expect(
      seedOffer({
        condition: 'refurbished_seller',
        conditionSourceLabel: 'Grado B',
        conditionMappingState: 'review_pending',
        conditionMappingConfidence: 0.4,
        conditionMappingRulesetId: ruleset,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a `mapped` row whose confidence is below the floor', async () => {
    const ruleset = await seedRuleset('woocommerce');
    await expect(
      seedOffer({
        condition: 'used_good',
        conditionSourceLabel: 'Usato',
        conditionMappingState: 'mapped',
        conditionMappingConfidence: CONDITION_MAPPING_CONFIDENCE_FLOOR - 0.01,
        conditionMappingRulesetId: ruleset,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses an `unmapped` row that claims a condition', async () => {
    await expect(
      seedOffer({ condition: 'new', conditionMappingState: 'unmapped' }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a `declared` row carrying a source label', async () => {
    // A first-party declaration has no source to have said anything.
    await expect(
      seedOffer({
        condition: 'new',
        conditionMappingState: 'declared',
        conditionSourceLabel: 'Brand new',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('ADMITS the three legitimate shapes, so the CHECKs are restrictive', async () => {
    // The vacuity guard. Constraints refusing every offer would satisfy all four
    // assertions above and would stop the converger dead.
    const ruleset = await seedRuleset('prestashop');
    await expect(
      seedOffer({ condition: 'new', conditionMappingState: 'declared' }),
    ).resolves.toBeDefined();
    await expect(
      seedOffer({
        condition: 'refurbished_seller',
        conditionSourceLabel: 'Ricondizionato — Grado B',
        conditionMappingState: 'mapped',
        conditionMappingConfidence: 0.9,
        conditionMappingRulesetId: ruleset,
      }),
    ).resolves.toBeDefined();
    await expect(
      seedOffer({
        condition: 'unknown',
        conditionSourceLabel: 'Zustand: siehe Beschreibung',
        conditionMappingState: 'review_pending',
        conditionMappingConfidence: 0.4,
        conditionMappingRulesetId: ruleset,
      }),
    ).resolves.toBeDefined();
  });

  it('a published ruleset and its rules are both FROZEN', async () => {
    const version = 800_000 + Math.floor(Math.random() * 100_000);
    const [ruleset] = await db
      .insert(conditionMappingRulesets)
      .values({ provider: 'woocommerce', version })
      .returning({ id: conditionMappingRulesets.id });
    createdRulesetIds.push(ruleset.id);

    // A draft accepts rules.
    await db.insert(conditionSourceMappings).values({
      rulesetId: ruleset.id,
      sourceLabel: 'Ricondizionato — Grado B',
      sourceLabelNormalized: 'ricondizionato grado b',
      conditionKey: 'refurbished_seller',
      confidence: 0.9,
    });

    await db
      .update(conditionMappingRulesets)
      .set({ state: 'active', publishedAt: new Date(), publishedByOxyUserId: `op-${RUN}` })
      .where(eq(conditionMappingRulesets.id, ruleset.id));

    // Published: the rules are frozen, so correcting one is publishing v2 and an
    // offer observed under v1 keeps citing v1.
    await expect(
      db.insert(conditionSourceMappings).values({
        rulesetId: ruleset.id,
        sourceLabel: 'Wie neu',
        sourceLabelNormalized: 'wie neu',
        conditionKey: 'used_like_new',
        confidence: 0.95,
      }),
    ).rejects.toSatisfy(isCheckViolation);

    await expect(
      db
        .update(conditionSourceMappings)
        .set({ conditionKey: 'used_good' })
        .where(eq(conditionSourceMappings.rulesetId, ruleset.id)),
    ).rejects.toSatisfy(isCheckViolation);

    // And its own identity cannot move.
    await expect(
      db
        .update(conditionMappingRulesets)
        .set({ version: version + 1 })
        .where(eq(conditionMappingRulesets.id, ruleset.id)),
    ).rejects.toSatisfy(isCheckViolation);

    // Vacuity: the lifecycle move a successor's publication performs is still
    // allowed, so the trigger is not simply refusing every update.
    await expect(
      db
        .update(conditionMappingRulesets)
        .set({ state: 'superseded' })
        .where(eq(conditionMappingRulesets.id, ruleset.id)),
    ).resolves.toBeDefined();
  });

  it('refuses a second ACTIVE ruleset for one provider', async () => {
    const base = 700_000 + Math.floor(Math.random() * 50_000);
    const rows = await db
      .insert(conditionMappingRulesets)
      .values([
        { provider: 'etsy', version: base },
        { provider: 'etsy', version: base + 1 },
      ])
      .returning({ id: conditionMappingRulesets.id });
    createdRulesetIds.push(...rows.map((row) => row.id));

    const publish = { state: 'active' as const, publishedAt: new Date(), publishedByOxyUserId: `op-${RUN}` };
    await db
      .update(conditionMappingRulesets)
      .set(publish)
      .where(eq(conditionMappingRulesets.id, rows[0].id));

    // The partial unique, not a service comparison: two operators publishing
    // concurrently cannot both win.
    await expect(
      db
        .update(conditionMappingRulesets)
        .set(publish)
        .where(eq(conditionMappingRulesets.id, rows[1].id)),
    ).rejects.toSatisfy(isUniqueViolation);
  });
});

describe('#90 evidence rule 8 — the revision trail is append-only', () => {
  it('refuses an UPDATE, and refuses a DELETE while the listing lives', async () => {
    const listingId = await seedListing();
    const [revision] = await db
      .insert(listingConditionRevisions)
      .values({
        listingId,
        fromCondition: 'used_good',
        toCondition: 'used_fair',
        fromAssertion: 'seller_declared',
        toAssertion: 'seller_declared',
        actorKind: 'seller',
        actorOxyUserId: `seller-${RUN}`,
        reason: 'Found a scratch',
      })
      .returning({ id: listingConditionRevisions.id });

    await expect(
      db
        .update(listingConditionRevisions)
        .set({ reason: 'Actually it is fine' })
        .where(eq(listingConditionRevisions.id, revision.id)),
    ).rejects.toSatisfy(isCheckViolation);

    await expect(
      db.delete(listingConditionRevisions).where(eq(listingConditionRevisions.id, revision.id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('PERMITS the deletion that is the listing’s own cascade', async () => {
    // The precise version of append-only this table needs: the foreign key
    // already says `cascade`, so an unconditional refusal would make a listing
    // undeletable, while an unconditional permission would let an operator
    // remove one correction to hide it.
    const listingId = await seedListing();
    await db.insert(listingConditionRevisions).values({
      listingId,
      toCondition: 'used_good',
      toAssertion: 'migrated_binary',
      actorKind: 'migration',
      reason: 'Migrated from the binary field',
    });

    await db.delete(listings).where(eq(listings.id, listingId));
    const survivors = await db
      .select({ id: listingConditionRevisions.id })
      .from(listingConditionRevisions)
      .where(eq(listingConditionRevisions.listingId, listingId));
    expect(survivors).toEqual([]);

    // Already gone — keep teardown from trying again.
    const index = createdListingIds.indexOf(listingId);
    if (index >= 0) createdListingIds.splice(index, 1);
  });

  it('refuses a migration revision that names a person, and a seller one that does not', async () => {
    const listingId = await seedListing();
    await expect(
      db.insert(listingConditionRevisions).values({
        listingId,
        toCondition: 'used_good',
        toAssertion: 'migrated_binary',
        actorKind: 'migration',
        actorOxyUserId: `op-${RUN}`,
        reason: 'A backfill has nobody to blame',
      }),
    ).rejects.toSatisfy(isCheckViolation);

    await expect(
      db.insert(listingConditionRevisions).values({
        listingId,
        toCondition: 'used_good',
        toAssertion: 'seller_declared',
        actorKind: 'seller',
        reason: 'An anonymous correction is unattributable',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a revision in which nothing changed', async () => {
    const listingId = await seedListing();
    await expect(
      db.insert(listingConditionRevisions).values({
        listingId,
        fromCondition: 'used_good',
        toCondition: 'used_good',
        fromAssertion: 'seller_declared',
        toAssertion: 'seller_declared',
        actorKind: 'seller',
        actorOxyUserId: `seller-${RUN}`,
        reason: 'Nothing moved',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('#90 — a photo can only evidence a defect on its OWN listing', () => {
  it('refuses a cross-listing annotation, by composite foreign key', async () => {
    const listingA = await seedListing();
    const listingB = await seedListing();

    const [defect] = await db
      .insert(listingConditionDetails)
      .values({
        listingId: listingA,
        kind: 'functional_defect',
        severity: 'moderate',
        note: 'The hinge is loose',
      })
      .returning({ id: listingConditionDetails.id });

    await expect(
      db.insert(listingConditionPhotos).values({
        listingId: listingB,
        fileId: `cross-listing-${RUN}`,
        provenance: 'seller_captured',
        uploadedByOxyUserId: `seller-${RUN}`,
        uploadedAt: new Date(),
        conditionDetailId: defect.id,
      }),
    ).rejects.toThrow();

    // Vacuity: the same annotation on its OWN listing is accepted.
    await expect(
      db.insert(listingConditionPhotos).values({
        listingId: listingA,
        fileId: `same-listing-${RUN}`,
        provenance: 'seller_captured',
        uploadedByOxyUserId: `seller-${RUN}`,
        uploadedAt: new Date(),
        showsDefect: true,
        conditionDetailId: defect.id,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a disclosure that says nothing, and a severity on a kind that has none', async () => {
    const listingId = await seedListing();
    await expect(
      db
        .insert(listingConditionDetails)
        .values({ listingId, kind: 'functional_defect', note: '   ' }),
    ).rejects.toSatisfy(isCheckViolation);

    await expect(
      db
        .insert(listingConditionDetails)
        .values({ listingId, kind: 'warranty', severity: 'heavy', note: '12 months' }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('#90 policy rule 5 — a category may refuse a condition', () => {
  it('records one restriction per (category, condition) and replaces rather than duplicates', async () => {
    const [category] = await db
      .insert(categories)
      .values({ key: `cond-cat-${RUN}`, name: `Condition category ${RUN}`, slug: `cond-cat-${RUN}` })
      .returning({ id: categories.id });
    createdCategoryIds.push(category.id);

    const values = {
      categoryId: category.id,
      conditionKey: 'for_parts' as const,
      restriction: 'safety' as const,
      includeDescendants: true,
      reason: 'Non-functional units of this kind cannot be sold to consumers',
      createdByOxyUserId: `op-${RUN}`,
    };
    await db.insert(conditionCategoryPolicies).values(values);
    await expect(db.insert(conditionCategoryPolicies).values(values)).rejects.toSatisfy(
      isUniqueViolation,
    );

    const rows = await db
      .select()
      .from(conditionCategoryPolicies)
      .where(
        and(
          eq(conditionCategoryPolicies.categoryId, category.id),
          eq(conditionCategoryPolicies.conditionKey, 'for_parts'),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
