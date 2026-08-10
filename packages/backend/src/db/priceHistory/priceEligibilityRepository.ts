/**
 * The two LIVE inputs the derivation takes and cannot compute (#78).
 *
 * Both are reads of a permission rather than of a fact about a price, which is
 * why they are live where the freshness verdict is historical: a right that has
 * been withdrawn must stop applying to old points, and a relationship that has
 * lapsed must stop producing a badge-backed series. `derive.ts` states the
 * asymmetry in full.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { catalogSources } from '../schema/provenance.js';
import { catalogSourcePolicies } from '../schema/ingestion.js';
import { commerceRelationships } from '../schema/relationships.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';

/**
 * Sources whose facts may carry a PRICE today.
 *
 * Two admitting shapes, and the second is not laxity. A source with an active
 * #62 rights policy is judged on `may_display_price`, the fine right. A source
 * with NO policy at all — the operator registry entry and #60's backfill source,
 * which ingest nothing and so have no agreement to resolve — is judged on
 * `catalog_sources.may_display`, the coarse column those sources state for
 * themselves. Refusing the second group would withdraw #60's whole backfilled
 * catalogue from every chart on the deploy that added this domain, which is the
 * ADR 0002 D24 rollout rule about never introducing a lever in the position
 * that removes a live surface.
 */
export async function listPriceDisplayPermittedSourceIds(
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  const rows = await db
    .select({ id: catalogSources.id })
    .from(catalogSources)
    .leftJoin(
      catalogSourcePolicies,
      and(
        eq(catalogSourcePolicies.sourceId, catalogSources.id),
        eq(catalogSourcePolicies.status, 'active'),
      ),
    )
    .where(
      or(
        eq(catalogSourcePolicies.mayDisplayPrice, true),
        and(isNull(catalogSourcePolicies.id), eq(catalogSources.mayDisplay, true)),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * Merchants #55 has VERIFIED as an OFFICIAL channel for this scope's brand,
 * inside the claim's validity window.
 *
 * The window is checked here and not left to `status` alone, which is #55's own
 * rule: a lapsed claim produces no badge whether or not a sweep has run. An
 * empty result is the ordinary state — a merchant with no verified relationship
 * has no relationship row at all — and produces an empty
 * `official_store_item_price` series rather than one filled from a domain match.
 */
export async function listOfficialStoreMerchantIds(
  scope: { canonicalProductId?: string | null; canonicalVariantId?: string | null },
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  const brandId = await resolveBrandId(scope, db);
  if (!brandId) return new Set();

  const rows = await db
    .select({ merchantId: commerceRelationships.merchantId })
    .from(commerceRelationships)
    .where(
      and(
        eq(commerceRelationships.kind, 'merchant_official_channel_for_brand'),
        eq(commerceRelationships.brandId, brandId),
        eq(commerceRelationships.status, 'verified'),
        sql`${commerceRelationships.validFrom} <= ${now.toISOString()}::timestamptz`,
        or(
          isNull(commerceRelationships.validTo),
          sql`${commerceRelationships.validTo} > ${now.toISOString()}::timestamptz`,
        ),
      ),
    );
  return new Set(rows.flatMap((row) => (row.merchantId ? [row.merchantId] : [])));
}

/** A variant reaches its brand through its product; a product carries it directly. */
async function resolveBrandId(
  scope: { canonicalProductId?: string | null; canonicalVariantId?: string | null },
  db: DatabaseOrTransaction,
): Promise<string | undefined> {
  if (scope.canonicalProductId) {
    const rows = await db
      .select({ brandId: canonicalProducts.brandId })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, scope.canonicalProductId))
      .limit(1);
    return rows[0]?.brandId ?? undefined;
  }
  if (scope.canonicalVariantId) {
    const rows = await db
      .select({ brandId: canonicalProducts.brandId })
      .from(canonicalVariants)
      .innerJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
      .where(eq(canonicalVariants.id, scope.canonicalVariantId))
      .limit(1);
    return rows[0]?.brandId ?? undefined;
  }
  return undefined;
}
