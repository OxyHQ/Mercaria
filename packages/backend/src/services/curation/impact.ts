/**
 * The downstream impact an operator is shown BEFORE a high-impact action
 * (#59 security 2).
 *
 * ## It is computed from the PLAN, not from a second list of tables
 *
 * Every count below runs the same predicate `applyRehomeTarget` will run, over
 * the same plan entries, so the number an operator approves is the number of
 * rows that will actually move. A separate "impact query" is the classic way
 * these two drift: the plan gains a table, the estimate does not, and a merge
 * quietly moves 400 rows after somebody approved 40.
 *
 * ## `untouchedOrderItems` is reported precisely because it does NOT move
 *
 * #59 merge invariant 3 says native listing and placed-order ids do not change.
 * That is true here by CONSTRUCTION — `orders` and `order_items` reference
 * `product_variants` and `listings`, which are the NATIVE catalogue, and no
 * mergeable entity's plan contains either. Showing the count beside a zero
 * moving figure is how an operator learns that a merge cannot disturb somebody's
 * purchase history, and `curation-isolation.test.ts` fails the build if a
 * curation module ever reaches the order tables to write.
 */

import { and, eq, getTableName, isNotNull, sql } from 'drizzle-orm';
import {
  totalMovingImpact,
  type CatalogImpactEstimate,
  type MergeableEntityType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { countRehomeTarget } from '../../db/curation/rehomeRepository.js';
import { MERGE_REHOMING_PLAN, type RehomeTarget } from './merge-plan.js';
import { listings, productVariants } from '../../db/schema/catalog.js';
import { orderItems } from '../../db/schema/orders.js';
import { nativeListingLinks } from '../../db/schema/offers.js';

/**
 * Which impact field a plan entry contributes to.
 *
 * Keyed on the TABLE rather than on the phase, because two different facts an
 * operator counts separately can share a phase: `canonical_images` and
 * `canonical_attribute_values` both move in `source_links` (they are all
 * source-derived children) and reporting them as "source links" would tell an
 * operator that a merge moves 40 provenance rows when it moves 12 of those, 20
 * facts and 8 photographs.
 *
 * An unmapped table returns `null` and is counted nowhere, which is correct for
 * the merge's own bookkeeping — a tombstone pointer is not a row anybody thinks
 * of as affected.
 */
const IMPACT_BUCKET_BY_TABLE: Readonly<Record<string, keyof CatalogImpactEstimate>> = {
  organization_aliases: 'aliases',
  brand_aliases: 'aliases',
  merchant_aliases: 'aliases',
  storefront_aliases: 'aliases',
  canonical_product_family_aliases: 'aliases',
  canonical_product_aliases: 'aliases',
  canonical_variant_aliases: 'aliases',
  organization_source_links: 'sourceLinks',
  brand_source_links: 'sourceLinks',
  merchant_source_links: 'sourceLinks',
  storefront_source_links: 'sourceLinks',
  canonical_product_family_source_links: 'sourceLinks',
  canonical_product_source_links: 'sourceLinks',
  canonical_variant_source_links: 'sourceLinks',
  canonical_field_provenance: 'sourceLinks',
  product_identifiers: 'identifiers',
  canonical_attribute_values: 'attributeValues',
  canonical_images: 'images',
  offers: 'offers',
  native_listing_links: 'nativeListingLinks',
  procurement_offers: 'offers',
  store_linkage_offer_overlaps: 'offers',
  commerce_relationships: 'relationships',
  merchant_claims: 'relationships',
  native_store_links: 'relationships',
  store_linkage_requests: 'relationships',
  reviews: 'reviews',
  review_eligibilities: 'reviews',
  review_aggregates: 'reviews',
  match_decisions: 'reviews',
  match_decision_candidates: 'reviews',
  match_blocked_pairs: 'reviews',
  canonical_products: 'childEntities',
  canonical_product_families: 'childEntities',
  canonical_variants: 'childEntities',
  storefronts: 'childEntities',
  suppliers: 'childEntities',
  merchant_domains: 'childEntities',
  bundle_components: 'childEntities',
  canonical_variant_attributes: 'childEntities',
};

function impactBucket(target: RehomeTarget): keyof CatalogImpactEstimate | null {
  return IMPACT_BUCKET_BY_TABLE[getTableName(target.column.table)] ?? null;
}

/**
 * How many order lines reference the entity's native listings — the count that
 * stays put.
 *
 * Only a canonical VARIANT can reach the native catalogue at all, and only
 * through `native_listing_links`; every other mergeable entity is further from
 * it still. Returning zero for the rest is not a shortcut, it is the fact.
 */
async function countUntouchedOrderItems(
  entityType: MergeableEntityType,
  entityId: string,
  db: DatabaseOrTransaction,
): Promise<number> {
  if (entityType !== 'canonical_variant') return 0;
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orderItems)
    .innerJoin(productVariants, eq(orderItems.variantId, productVariants.id))
    .innerJoin(listings, eq(productVariants.listingId, listings.id))
    .innerJoin(
      nativeListingLinks,
      and(
        eq(nativeListingLinks.productVariantId, productVariants.id),
        eq(nativeListingLinks.canonicalVariantId, entityId),
        eq(nativeListingLinks.status, 'active'),
      ),
    )
    .where(isNotNull(orderItems.variantId));
  return Number(rows[0]?.total ?? 0);
}

/**
 * Estimate what a merge of `entityId` into another row would move.
 *
 * The winner is deliberately not a parameter: the estimate counts the LOSER's
 * children, which is what moves. A count that depended on the winner would
 * change between the preview and the run whenever anybody else touched the
 * winner, and an approval given for one number would execute another.
 */
export async function estimateMergeImpact(
  entityType: MergeableEntityType,
  entityId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogImpactEstimate> {
  const counts: Record<string, number> = {
    sourceLinks: 0,
    identifiers: 0,
    aliases: 0,
    offers: 0,
    nativeListingLinks: 0,
    relationships: 0,
    reviews: 0,
    childEntities: 0,
    attributeValues: 0,
    images: 0,
  };

  for (const target of MERGE_REHOMING_PLAN[entityType]) {
    const bucket = impactBucket(target);
    if (!bucket || !(bucket in counts)) continue;
    counts[bucket] = (counts[bucket] ?? 0) + (await countRehomeTarget(target, entityId, db));
  }

  const partial = {
    sourceLinks: counts.sourceLinks ?? 0,
    identifiers: counts.identifiers ?? 0,
    aliases: counts.aliases ?? 0,
    offers: counts.offers ?? 0,
    nativeListingLinks: counts.nativeListingLinks ?? 0,
    relationships: counts.relationships ?? 0,
    reviews: counts.reviews ?? 0,
    childEntities: counts.childEntities ?? 0,
    attributeValues: counts.attributeValues ?? 0,
    images: counts.images ?? 0,
  };

  return {
    ...partial,
    untouchedOrderItems: await countUntouchedOrderItems(entityType, entityId, db),
    totalMoving: totalMovingImpact(partial),
  };
}

/**
 * The impact of a SPLIT, which is the size of the operator's own assignment
 * list rather than a count of everything hanging off the entity.
 *
 * A split moves exactly what was named (#59 split invariant 1), so estimating it
 * from the entity's children would report a number the job will never reach —
 * and the four-eyes threshold reads this figure.
 */
export function splitImpactFromAssignments(
  counts: Readonly<Partial<Record<keyof CatalogImpactEstimate, number>>>,
): CatalogImpactEstimate {
  const partial = {
    sourceLinks: counts.sourceLinks ?? 0,
    identifiers: counts.identifiers ?? 0,
    aliases: counts.aliases ?? 0,
    offers: counts.offers ?? 0,
    nativeListingLinks: counts.nativeListingLinks ?? 0,
    relationships: counts.relationships ?? 0,
    reviews: counts.reviews ?? 0,
    childEntities: counts.childEntities ?? 0,
    attributeValues: counts.attributeValues ?? 0,
    images: counts.images ?? 0,
  };
  return {
    ...partial,
    untouchedOrderItems: 0,
    totalMoving: totalMovingImpact(partial),
  };
}

/** The impact columns as the two job tables store them. */
export function impactColumnValues(estimate: CatalogImpactEstimate) {
  return {
    impactSourceLinks: estimate.sourceLinks,
    impactIdentifiers: estimate.identifiers,
    impactAliases: estimate.aliases,
    impactOffers: estimate.offers,
    impactNativeListingLinks: estimate.nativeListingLinks,
    impactRelationships: estimate.relationships,
    impactReviews: estimate.reviews,
    impactChildEntities: estimate.childEntities,
    impactAttributeValues: estimate.attributeValues,
    impactImages: estimate.images,
    impactUntouchedOrderItems: estimate.untouchedOrderItems,
    impactTotalMoving: estimate.totalMoving,
  };
}

/** The stored columns read back as an estimate — the projection's own inverse. */
export function impactFromColumns(row: {
  readonly impactSourceLinks: number;
  readonly impactIdentifiers: number;
  readonly impactAliases: number;
  readonly impactOffers: number;
  readonly impactNativeListingLinks: number;
  readonly impactRelationships: number;
  readonly impactReviews: number;
  readonly impactChildEntities: number;
  readonly impactAttributeValues: number;
  readonly impactImages: number;
  readonly impactUntouchedOrderItems: number;
  readonly impactTotalMoving: number;
}): CatalogImpactEstimate {
  return {
    sourceLinks: row.impactSourceLinks,
    identifiers: row.impactIdentifiers,
    aliases: row.impactAliases,
    offers: row.impactOffers,
    nativeListingLinks: row.impactNativeListingLinks,
    relationships: row.impactRelationships,
    reviews: row.impactReviews,
    childEntities: row.impactChildEntities,
    attributeValues: row.impactAttributeValues,
    images: row.impactImages,
    untouchedOrderItems: row.impactUntouchedOrderItems,
    totalMoving: row.impactTotalMoving,
  };
}
