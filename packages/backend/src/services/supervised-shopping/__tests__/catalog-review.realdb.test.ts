import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../../db/postgres.js';
import {
  listings,
  listingOptions,
  productVariants,
  productVariantOptionValues,
} from '../../../db/schema/catalog.js';
import { catalogSafetyReviews } from '../../../db/schema/supervisedShopping.js';
import { insertVariants } from '../../../db/catalog/variantRepository.js';
import {
  readCatalogReviewSources,
  readCatalogReviewCandidates,
  recordCatalogSafetyReview,
  reviewedShoppingProjection,
} from '../catalog-review.service.js';

beforeAll(async () => {
  await connectPostgres();
});
afterAll(closePostgres);

async function seed() {
  const [listing] = await getDb()
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: 'catalog-review-seller',
      title: 'Wooden blocks',
      description: 'Plain wooden building blocks.',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning();
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Natural',
      priceAmount: 1200,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5,
      position: 0,
      optionValues: [{ name: 'Finish', value: 'Natural' }],
    },
  ]);
  return { listing, variant };
}

async function candidate(id: string) {
  const [result] = await readCatalogReviewCandidates([id]);
  if ('unavailableReason' in result) throw new Error(result.unavailableReason);
  return result;
}
async function approve(id: string) {
  const row = await candidate(id);
  const result = await recordCatalogSafetyReview({
    listingId: id,
    contentDigest: row.listing.reviewDigest,
    decision: 'allow',
    reviewerOxyUserId: 'catalog-platform-operator',
  });
  if ('unavailableReason' in result) throw new Error(result.unavailableReason);
  return result;
}

describe('platform-reviewed shopping projection, real PostgreSQL', () => {
  it('publishing does not classify content; explicit review exposes only the bounded projection', async () => {
    const { listing } = await seed();
    expect(reviewedShoppingProjection(await candidate(listing.id))).toBeNull();
    const projection = reviewedShoppingProjection(await approve(listing.id));
    expect(projection).toMatchObject({ title: 'Wooden blocks', variants: [{ title: 'Natural' }] });
    if (!projection) throw new Error('Expected reviewed projection');
    expect(Object.keys(projection).sort()).toEqual(['id', 'reviewDigest', 'title', 'variants']);
    expect(projection).not.toHaveProperty('description');
    expect(projection).not.toHaveProperty('imageFileIds');
  });

  it.each(['title', 'description', 'variant', 'option', 'price'] as const)(
    'revokes a reviewed projection after a %s change, including non-primary writers',
    async (field) => {
      const { listing, variant } = await seed();
      const before = await approve(listing.id);
      if (field === 'title' || field === 'description') {
        await getDb()
          .update(listings)
          .set({ [field]: 'Changed content' })
          .where(eq(listings.id, listing.id));
      } else if (field === 'option') {
        await getDb()
          .update(productVariantOptionValues)
          .set({ value: 'Changed option' })
          .where(eq(productVariantOptionValues.variantId, variant.id));
      } else {
        await getDb()
          .update(productVariants)
          .set(field === 'price' ? { priceAmount: 1300 } : { title: 'Changed variant' })
          .where(eq(productVariants.id, variant.id));
      }
      expect(reviewedShoppingProjection(await candidate(listing.id))).toBeNull();
      await expect(
        recordCatalogSafetyReview({
          listingId: listing.id,
          contentDigest: before.listing.reviewDigest,
          decision: 'allow',
          reviewerOxyUserId: 'catalog-platform-operator',
        }),
      ).rejects.toThrow('changed');
    },
  );

  it('binds reviewed labels to their persisted option identities', async () => {
    const { listing, variant } = await seed();
    const [option] = await getDb()
      .insert(listingOptions)
      .values({ listingId: listing.id, name: 'Finish', values: ['Natural'] })
      .returning();
    const [assignment] = await getDb()
      .select()
      .from(productVariantOptionValues)
      .where(eq(productVariantOptionValues.variantId, variant.id));
    const reviewed = await approve(listing.id);
    expect(reviewed.options).toEqual([{ id: option.id, name: 'Finish', values: ['Natural'] }]);
    expect(reviewed.listing.variants[0].options).toEqual([
      { id: assignment.id, name: 'Finish', value: 'Natural' },
    ]);
    await getDb()
      .delete(productVariantOptionValues)
      .where(eq(productVariantOptionValues.id, assignment.id));
    await getDb().insert(productVariantOptionValues).values({
      variantId: variant.id,
      name: 'Finish',
      value: 'Natural',
    });
    const refreshed = await candidate(listing.id);
    expect(refreshed.listing.variants[0].options[0].id).not.toBe(assignment.id);
    expect(refreshed.listing.reviewDigest).not.toBe(reviewed.listing.reviewDigest);
    expect(reviewedShoppingProjection(refreshed)).toBeNull();
  });

  it('stock movements preserve review while explicit withdrawal supersedes approval', async () => {
    const { listing, variant } = await seed();
    await approve(listing.id);
    await getDb()
      .update(productVariants)
      .set({ inventoryAvailable: 3, inventoryCommitted: 2 })
      .where(eq(productVariants.id, variant.id));
    expect(reviewedShoppingProjection(await candidate(listing.id))).not.toBeNull();
    const current = await candidate(listing.id);
    await recordCatalogSafetyReview({
      listingId: listing.id,
      contentDigest: current.listing.reviewDigest,
      decision: 'withhold',
      reviewerOxyUserId: 'catalog-platform-operator',
    });
    expect(reviewedShoppingProjection(await candidate(listing.id))).toBeNull();
    const reviews = await getDb()
      .select()
      .from(catalogSafetyReviews)
      .where(eq(catalogSafetyReviews.listingId, listing.id));
    expect(reviews).toHaveLength(2);
    await expect(
      getDb().delete(catalogSafetyReviews).where(eq(catalogSafetyReviews.listingId, listing.id)),
    ).rejects.toThrow();
    await expect(
      getDb()
        .update(catalogSafetyReviews)
        .set({ decision: 'allow' })
        .where(eq(catalogSafetyReviews.listingId, listing.id)),
    ).rejects.toThrow();
  });

  it.each([0, -60_000])(
    'revocation wins when the reviewer clock moves by %s ms',
    async (clockChange) => {
      const { listing } = await seed();
      vi.useFakeTimers({ toFake: ['Date'] });
      const firstTime = new Date('2025-01-15T12:00:00.000Z');
      try {
        vi.setSystemTime(firstTime);
        const approved = await approve(listing.id);
        vi.setSystemTime(new Date(firstTime.getTime() + clockChange));
        await recordCatalogSafetyReview({
          listingId: listing.id,
          contentDigest: approved.listing.reviewDigest,
          decision: 'withhold',
          reviewerOxyUserId: 'catalog-platform-operator',
        });
        expect(reviewedShoppingProjection(await candidate(listing.id))).toBeNull();
        const rows = await getDb()
          .select()
          .from(catalogSafetyReviews)
          .where(eq(catalogSafetyReviews.listingId, listing.id));
        const allow = rows.find((row) => row.decision === 'allow');
        const deny = rows.find((row) => row.decision === 'withhold');
        if (!allow || !deny) throw new Error('Expected both review revisions');
        expect(deny.revision).toBeGreaterThan(allow.revision);
        expect(deny.createdAt.getTime()).toBeLessThanOrEqual(allow.createdAt.getTime());
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(['variants', 'bytes'] as const)(
    'refuses oversized %s before hydrating or returning partial review material',
    async (kind) => {
      const { listing } = await seed();
      const approved = await approve(listing.id);
      if (kind === 'variants') {
        await insertVariants(
          listing.id,
          Array.from({ length: 20 }, (_, position) => ({
            title: `Option ${position}`,
            priceAmount: 1200,
            priceCurrency: 'EUR' as const,
            inventoryTracked: true,
            inventoryAvailable: 5,
            position: position + 1,
            optionValues: [],
          })),
        );
      } else {
        await getDb()
          .update(listings)
          .set({ description: 'a'.repeat(70_000) })
          .where(eq(listings.id, listing.id));
      }
      const [unavailable] = await readCatalogReviewCandidates([listing.id]);
      expect(unavailable).toEqual({
        listingId: listing.id,
        unavailableReason: 'review_limit_exceeded',
      });
      expect(reviewedShoppingProjection(unavailable)).toBeNull();
      await expect(
        recordCatalogSafetyReview({
          listingId: listing.id,
          contentDigest: approved.listing.reviewDigest,
          decision: 'allow',
          reviewerOxyUserId: 'catalog-platform-operator',
        }),
      ).rejects.toThrow('review limits');
    },
  );

  it('binds the reviewed text and author to one snapshot across a concurrent ownership change', async () => {
    const { listing } = await seed();
    await approve(listing.id);
    await getDb().transaction(
      async (tx) => {
        // Establish the reader snapshot, then commit an independent writer.
        await tx.select({ id: listings.id }).from(listings).where(eq(listings.id, listing.id));
        await getDb()
          .update(listings)
          .set({ oxyUserId: 'different-catalog-author', title: 'New author text' })
          .where(eq(listings.id, listing.id));
        const [source] = await readCatalogReviewSources([listing.id], tx);
        expect(source.authorAccountId).toBe('catalog-review-seller');
        expect(reviewedShoppingProjection(source.candidate)?.title).toBe('Wooden blocks');
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const [current] = await readCatalogReviewSources([listing.id]);
    expect(current.authorAccountId).toBe('different-catalog-author');
    expect(reviewedShoppingProjection(current.candidate)).toBeNull();
  });
});
