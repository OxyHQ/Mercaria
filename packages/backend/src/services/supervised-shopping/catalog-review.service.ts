import { createHash } from 'node:crypto';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  CatalogSafetyReviewCandidate,
  CatalogSafetyReviewMaterial,
  CatalogSafetyReviewDecision,
  CurrencyCode,
  ReviewedShoppingListing,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { catalogSafetyReviews } from '../../db/schema/supervisedShopping.js';
import { listingConditionDetails } from '../../db/schema/condition.js';
import { listings, listingImages, listingOptions } from '../../db/schema/catalog.js';
import { findStoresByIds } from '../../db/stores/storeRepository.js';
import { findListingsByIds } from '../../db/catalog/listingRepository.js';
import {
  findVariantOptionValues,
  findVariantsByListingIds,
} from '../../db/catalog/variantRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';

/** Stable digest of the fully enumerated review material, never a truncated description. */
export function shoppingContentDigest(material: unknown): string {
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export interface CatalogReviewSource {
  candidate: CatalogSafetyReviewCandidate;
  /** Bound to the same snapshot and digest as the text; never part of the public projection. */
  authorAccountId: string | null;
}

export async function readCatalogReviewCandidates(
  ids: readonly string[],
  db?: DatabaseOrTransaction,
): Promise<CatalogSafetyReviewCandidate[]> {
  return (await readCatalogReviewSources(ids, db)).map((source) => source.candidate);
}

/** Bounded snapshot; query count is independent of the number of listings. */
export async function readCatalogReviewSources(
  ids: readonly string[],
  db?: DatabaseOrTransaction,
): Promise<CatalogReviewSource[]> {
  if (!db)
    return getDb().transaction((tx) => readCatalogReviewSources(ids, tx), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  const requestedIds = [...new Set(ids)];
  const listingIds = requestedIds;
  if (listingIds.length > 100) throw validationError('At most 100 items may be reviewed together.');
  if (!listingIds.length) return [];
  // Count and byte probes stop at each limit + 1. A repeatable-read snapshot
  // makes these bounds apply to the child hydration below as well.
  const budgets = await db.execute<{ id: string; reviewable: boolean }>(sql`
    SELECT l.id,
      v.n <= 20 AND o.n <= 16 AND i.n <= 20 AND d.n <= 32 AND vo.n <= 320 AND
      octet_length(to_jsonb(l)::text) + v.bytes + o.bytes + i.bytes + d.bytes + vo.bytes <= 65536 AS reviewable
    FROM listings l
    CROSS JOIN LATERAL (SELECT count(*) n, coalesce(sum(octet_length(to_jsonb(x)::text)),0) bytes
      FROM (SELECT * FROM product_variants WHERE listing_id=l.id LIMIT 21) x) v
    CROSS JOIN LATERAL (SELECT count(*) n, coalesce(sum(octet_length(to_jsonb(x)::text)),0) bytes
      FROM (SELECT * FROM listing_options WHERE listing_id=l.id LIMIT 17) x) o
    CROSS JOIN LATERAL (SELECT count(*) n, coalesce(sum(octet_length(to_jsonb(x)::text)),0) bytes
      FROM (SELECT * FROM listing_images WHERE listing_id=l.id LIMIT 21) x) i
    CROSS JOIN LATERAL (SELECT count(*) n, coalesce(sum(octet_length(to_jsonb(x)::text)),0) bytes
      FROM (SELECT * FROM listing_condition_details WHERE listing_id=l.id LIMIT 33) x) d
    CROSS JOIN LATERAL (SELECT count(*) n, coalesce(sum(octet_length(to_jsonb(x)::text)),0) bytes
      FROM (SELECT ov.* FROM product_variant_option_values ov JOIN product_variants pv ON pv.id=ov.variant_id
        WHERE pv.listing_id=l.id LIMIT 321) x) vo
    WHERE l.id IN (${sql.join(
      listingIds.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  const unavailable: CatalogReviewSource[] = budgets
    .filter((row) => !row.reviewable)
    .map(({ id }) => ({
      candidate: { listingId: id, unavailableReason: 'review_limit_exceeded' },
      authorAccountId: null,
    }));
  const eligibleIds = budgets.filter((row) => row.reviewable).map(({ id }) => id);
  if (!eligibleIds.length) return unavailable;
  const [rows, imageRows, optionRows, variants, details, reviews] = await Promise.all([
    findListingsByIds(eligibleIds, db),
    db.select().from(listingImages).where(inArray(listingImages.listingId, eligibleIds)),
    db.select().from(listingOptions).where(inArray(listingOptions.listingId, eligibleIds)),
    findVariantsByListingIds(eligibleIds, db),
    db
      .select()
      .from(listingConditionDetails)
      .where(inArray(listingConditionDetails.listingId, eligibleIds))
      .orderBy(asc(listingConditionDetails.position), asc(listingConditionDetails.id)),
    db
      .selectDistinctOn([catalogSafetyReviews.listingId])
      .from(catalogSafetyReviews)
      .where(inArray(catalogSafetyReviews.listingId, eligibleIds))
      .orderBy(asc(catalogSafetyReviews.listingId), desc(catalogSafetyReviews.revision)),
  ]);
  const variantOptions = await findVariantOptionValues(
    variants.map((row) => row.id),
    db,
  );
  const reviewsById = new Map(reviews.map((row) => [row.listingId, row]));
  const storeRows = await findStoresByIds(
    [...new Set(rows.flatMap((row) => (row.storeId ? [row.storeId] : [])))],
    db,
  );
  const storeOwners = new Map(storeRows.map((row) => [row.id, row.oxyAccountId]));
  const material: CatalogReviewSource[] = rows.map((row) => {
    const authorAccountId =
      row.ownerType === 'user'
        ? row.oxyUserId
        : ((row.storeId ? storeOwners.get(row.storeId) : undefined) ?? null);
    const listingVariants = variants
      .filter((variant) => variant.listingId === row.id)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((variant) => ({
        id: variant.id,
        title: variant.title,
        options: [...(variantOptions.get(variant.id) ?? [])]
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
          .map(({ id, name, value }) => ({ id, name, value })),
        price:
          variant.priceAmount === null || variant.priceCurrency === null
            ? null
            : {
                amount: variant.priceAmount,
                currency: variant.priceCurrency as CurrencyCode,
              },
      }));
    const options = optionRows
      .filter((option) => option.listingId === row.id)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(({ id, name, values }) => ({ id, name, values }));
    const conditionDetails = details
      .filter((detail) => detail.listingId === row.id)
      .map(({ kind, severity, note }) => ({ kind, severity, note }));
    const imageFileIds = imageRows
      .filter((image) => image.listingId === row.id)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(({ fileId }) => fileId);
    const material = {
      version: 1,
      authorAccountId,
      id: row.id,
      title: row.title,
      description: row.description,
      ownerType: row.ownerType,
      oxyUserId: row.oxyUserId,
      storeId: row.storeId,
      condition: row.condition,
      conditionDetails,
      categoryId: row.categoryId,
      productType: row.productType,
      productTypeDefinitionId: row.productTypeDefinitionId,
      tags: row.tags,
      options,
      imageFileIds,
      variants: listingVariants,
    };
    if (
      row.title.length > 300 ||
      listingVariants.some(
        (variant) =>
          [variant.title, ...variant.options.map((option) => `${option.name}: ${option.value}`)]
            .filter(Boolean)
            .join(' · ').length > 300,
      )
    ) {
      return {
        candidate: { listingId: row.id, unavailableReason: 'review_limit_exceeded' },
        authorAccountId: null,
      };
    }
    const digest = shoppingContentDigest(material);
    const review = reviewsById.get(row.id);
    const candidate: CatalogSafetyReviewMaterial = {
      listing: { id: row.id, title: row.title, reviewDigest: digest, variants: listingVariants },
      description: row.description,
      condition: row.condition,
      conditionDetails,
      options,
      imageFileIds,
      status: row.status,
      latestDecision: review?.decision ?? null,
      reviewCurrent: review?.contentDigest === digest,
    };
    return { candidate, authorAccountId };
  });
  return [...material, ...unavailable];
}

/** Caller identity comes only from the platform operator middleware. */
export async function recordCatalogSafetyReview(input: {
  listingId: string;
  contentDigest: string;
  decision: CatalogSafetyReviewDecision;
  reviewerOxyUserId: string;
}): Promise<CatalogSafetyReviewCandidate> {
  return getDb().transaction(
    async (tx) => {
      // Serialize review/revocation decisions for this listing. Child edits are also
      // compared on every read, so no writer can accidentally retain old approval.
      await tx
        .select({ id: listings.id })
        .from(listings)
        .where(eq(listings.id, input.listingId))
        .for('update');
      const [candidate] = await readCatalogReviewCandidates([input.listingId], tx);
      if (!candidate) throw notFound('Item not found.');
      if ('unavailableReason' in candidate)
        throw conflict(
          'This item exceeds the review limits and is unavailable for supervised shopping.',
        );
      if (candidate.listing.reviewDigest !== input.contentDigest) {
        throw conflict('This item changed. Review its current content before deciding.');
      }
      await tx.insert(catalogSafetyReviews).values({ ...input, createdAt: new Date() });
      return { ...candidate, latestDecision: input.decision, reviewCurrent: true };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/** Local review only establishes classification. The central Oxy decision still gates delivery. */
export function reviewedShoppingProjection(
  candidate: CatalogSafetyReviewCandidate,
): ReviewedShoppingListing | null {
  if ('unavailableReason' in candidate) return null;
  return candidate.status === 'active' &&
    candidate.reviewCurrent &&
    candidate.latestDecision === 'allow'
    ? candidate.listing
    : null;
}
