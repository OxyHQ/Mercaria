/**
 * Replenishment planning's reads and writes: the two settings tables, and the
 * three bounded aggregates a plan is computed from.
 *
 * ## What counts as a sale, and when
 *
 * A line of one of the store's orders whose status is in
 * `REPLENISHMENT_SALE_ORDER_STATUSES` — paid and not cancelled or fully refunded
 * — minus the units refunded against that order line (`refund_line_items` of a
 * refund in `REPLENISHMENT_COUNTED_REFUND_STATUSES`), floored at zero. A refund
 * subtracts whether or not it restocked: a unit the buyer was refunded for is not
 * demand to plan for, and a restock already raised `available` on its own.
 *
 * The sale is dated by the ORDER's `created_at`, which is when the line reserved
 * its stock, and not by the payment: that is the moment the unit left
 * `available`, and it is what lets the scan ride
 * `orders_store_id_status_created_at_idx` — one index range per counted status,
 * bounded by the long window. A paid-moment anchor is an expression no index
 * serves.
 *
 * ## Which location a sale belongs to
 *
 * `order_items.location_id` where the line carries one (a POS register, a
 * pickup), else the store's default location — exactly where
 * `inventory.service` reserved and committed a line that named none. A line
 * naming a location the store has since deleted still counts store-wide; it has
 * no level to plan against at any surviving location.
 *
 * ## Bounded per store
 *
 * Each statement is scoped to ONE store by an indexed predicate, and the
 * variant universe stops at `limit + 1` rows so the caller can say it was
 * truncated rather than reading an unbounded catalogue into memory.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  REPLENISHMENT_COUNTED_REFUND_STATUSES,
  REPLENISHMENT_LISTING_STATUSES,
  REPLENISHMENT_SALE_ORDER_STATUSES,
  REPLENISHMENT_WINDOW_DAYS,
  type ReplenishmentSettingValues,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { inventoryLevels, listings, productVariants } from '../schema/catalog.js';
import { locations } from '../schema/stores.js';
import { replenishmentSettings, replenishmentVariantOverrides } from '../schema/replenishment.js';

const MS_PER_DAY = 86_400_000;

/** The store's saved settings, or `null` when it plans with the defaults. */
export interface StoredReplenishmentSettings extends ReplenishmentSettingValues {
  readonly updatedAt: Date;
}

export async function findReplenishmentSettings(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<StoredReplenishmentSettings | null> {
  const [row] = await db
    .select({
      leadTimeDays: replenishmentSettings.leadTimeDays,
      targetCoverDays: replenishmentSettings.targetCoverDays,
      safetyStockDays: replenishmentSettings.safetyStockDays,
      updatedAt: replenishmentSettings.updatedAt,
    })
    .from(replenishmentSettings)
    .where(eq(replenishmentSettings.storeId, storeId))
    .limit(1);
  return row ?? null;
}

/** Save the store's settings: one row per store, replaced whole. */
export async function upsertReplenishmentSettings(
  db: DatabaseOrTransaction,
  storeId: string,
  values: ReplenishmentSettingValues,
): Promise<StoredReplenishmentSettings> {
  const [row] = await db
    .insert(replenishmentSettings)
    .values({ storeId, ...values })
    .onConflictDoUpdate({
      target: replenishmentSettings.storeId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({
      leadTimeDays: replenishmentSettings.leadTimeDays,
      targetCoverDays: replenishmentSettings.targetCoverDays,
      safetyStockDays: replenishmentSettings.safetyStockDays,
      updatedAt: replenishmentSettings.updatedAt,
    });
  if (!row) throw new Error('replenishment settings upsert returned no row');
  return row;
}

/** One override as stored, with the titles a screen and a CSV show. */
export interface StoredReplenishmentOverride {
  readonly variantId: string;
  readonly listingId: string;
  readonly productTitle: string;
  readonly variantTitle: string;
  readonly sku: string | null;
  readonly leadTimeDays: number | null;
  readonly targetCoverDays: number | null;
  readonly safetyStockDays: number | null;
  readonly updatedAt: Date;
}

/** Every override of a store, by product then variant title. */
export async function listReplenishmentOverrides(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<StoredReplenishmentOverride[]> {
  return db
    .select({
      variantId: replenishmentVariantOverrides.variantId,
      listingId: productVariants.listingId,
      productTitle: listings.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      leadTimeDays: replenishmentVariantOverrides.leadTimeDays,
      targetCoverDays: replenishmentVariantOverrides.targetCoverDays,
      safetyStockDays: replenishmentVariantOverrides.safetyStockDays,
      updatedAt: replenishmentVariantOverrides.updatedAt,
    })
    .from(replenishmentVariantOverrides)
    .innerJoin(productVariants, eq(productVariants.id, replenishmentVariantOverrides.variantId))
    .innerJoin(listings, eq(listings.id, productVariants.listingId))
    .where(eq(replenishmentVariantOverrides.storeId, storeId))
    .orderBy(asc(listings.title), asc(productVariants.title), asc(productVariants.id));
}

/** The variant, when it is one of this store's own — the scoping IS the authorization. */
export async function findStoreVariant(
  db: DatabaseOrTransaction,
  storeId: string,
  variantId: string,
): Promise<{ variantId: string; listingId: string } | null> {
  const [row] = await db
    .select({ variantId: productVariants.id, listingId: productVariants.listingId })
    .from(productVariants)
    .innerJoin(listings, eq(listings.id, productVariants.listingId))
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(listings.storeId, storeId),
        eq(listings.ownerType, 'store'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Write a variant's override whole; every field `null` deletes it instead. */
export async function putReplenishmentOverride(
  db: DatabaseOrTransaction,
  input: {
    storeId: string;
    variantId: string;
    leadTimeDays: number | null;
    targetCoverDays: number | null;
    safetyStockDays: number | null;
  },
): Promise<'saved' | 'cleared'> {
  const { storeId, variantId, ...fields } = input;
  if (
    fields.leadTimeDays === null &&
    fields.targetCoverDays === null &&
    fields.safetyStockDays === null
  ) {
    await deleteReplenishmentOverride(db, storeId, variantId);
    return 'cleared';
  }
  await db
    .insert(replenishmentVariantOverrides)
    .values({ storeId, variantId, ...fields })
    .onConflictDoUpdate({
      target: replenishmentVariantOverrides.variantId,
      set: { ...fields, updatedAt: new Date() },
    });
  return 'saved';
}

/** Remove a variant's override. Returns whether there was one. */
export async function deleteReplenishmentOverride(
  db: DatabaseOrTransaction,
  storeId: string,
  variantId: string,
): Promise<boolean> {
  const rows = await db
    .delete(replenishmentVariantOverrides)
    .where(
      and(
        eq(replenishmentVariantOverrides.storeId, storeId),
        eq(replenishmentVariantOverrides.variantId, variantId),
      ),
    )
    .returning({ id: replenishmentVariantOverrides.id });
  return rows.length > 0;
}

/** One tracked variant a plan covers. */
export interface PlanVariant {
  readonly variantId: string;
  readonly listingId: string;
  readonly productTitle: string;
  readonly variantTitle: string;
  readonly sku: string | null;
  readonly createdAt: Date;
}

/**
 * The store's tracked variants on a plannable listing, at most `limit + 1`.
 *
 * Rides `listings_owner_store_status_published_at_id_idx` (owner type, store,
 * status) into `product_variants_listing_id_position_idx`.
 */
export async function readPlanVariants(
  db: DatabaseOrTransaction,
  storeId: string,
  limit: number,
): Promise<PlanVariant[]> {
  return db
    .select({
      variantId: productVariants.id,
      listingId: productVariants.listingId,
      productTitle: listings.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      createdAt: productVariants.createdAt,
    })
    .from(listings)
    .innerJoin(productVariants, eq(productVariants.listingId, listings.id))
    .where(
      and(
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
        inArray(listings.status, [...REPLENISHMENT_LISTING_STATUSES]),
        eq(productVariants.inventoryTracked, true),
      ),
    )
    .orderBy(asc(productVariants.id))
    .limit(limit + 1);
}

/** One `inventory_levels` row at one of the store's locations. */
export interface PlanLevel {
  readonly variantId: string;
  readonly locationId: string;
  readonly available: number;
  readonly committed: number;
}

/** Every level at the store's locations — one probe per location on its index. */
export async function readPlanLevels(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<PlanLevel[]> {
  return db
    .select({
      variantId: inventoryLevels.variantId,
      locationId: inventoryLevels.locationId,
      available: inventoryLevels.available,
      committed: inventoryLevels.committed,
    })
    .from(inventoryLevels)
    .innerJoin(locations, eq(locations.id, inventoryLevels.locationId))
    .where(eq(locations.storeId, storeId));
}

/** Net units one variant sold at one attributed location, per window. */
export interface PlanSales {
  readonly variantId: string;
  /** The attributed location; `null` only when the store has no location at all. */
  readonly locationId: string | null;
  readonly unitsRecent: number;
  readonly unitsLong: number;
}

/**
 * Net units sold per (variant, attributed location) over both windows.
 *
 * One statement: the refunded units are pre-aggregated per (order, variant)
 * over the store's refunds created inside the long window (a refund is never
 * older than its order), then subtracted line by line and floored at zero, so a
 * refund can never make a line count negative.
 */
export async function readPlanSales(
  db: DatabaseOrTransaction,
  input: { storeId: string; now: Date; defaultLocationId: string | null },
): Promise<PlanSales[]> {
  const longSince = new Date(input.now.getTime() - REPLENISHMENT_WINDOW_DAYS.long * MS_PER_DAY);
  const recentSince = new Date(input.now.getTime() - REPLENISHMENT_WINDOW_DAYS.recent * MS_PER_DAY);
  const saleStatuses = sql.join(
    REPLENISHMENT_SALE_ORDER_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const refundStatuses = sql.join(
    REPLENISHMENT_COUNTED_REFUND_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const longFrom = sql`${longSince.toISOString()}::timestamptz`;
  const recentFrom = sql`${recentSince.toISOString()}::timestamptz`;
  const until = sql`${input.now.toISOString()}::timestamptz`;

  const rows = await db.execute<{
    variant_id: string;
    location_id: string | null;
    units_recent: string | number;
    units_long: string | number;
  }>(sql`
    with refunded as (
      select r.order_id, rli.variant_id, sum(rli.quantity) as quantity
      from refunds r
      join refund_line_items rli on rli.refund_id = r.id
      where r.store_id = ${input.storeId}
        and r.status in (${refundStatuses})
        and r.created_at >= ${longFrom}
      group by r.order_id, rli.variant_id
    ),
    lines as (
      select
        oi.variant_id,
        coalesce(oi.location_id, ${input.defaultLocationId}::text) as location_id,
        o.created_at,
        greatest(oi.quantity - coalesce(rf.quantity, 0), 0) as units
      from orders o
      join order_items oi on oi.order_id = o.id
      left join refunded rf on rf.order_id = o.id and rf.variant_id = oi.variant_id
      where o.store_id = ${input.storeId}
        and o.status in (${saleStatuses})
        and o.created_at >= ${longFrom}
        and o.created_at <= ${until}
    )
    select
      variant_id,
      location_id,
      coalesce(sum(units) filter (where created_at >= ${recentFrom}), 0)::bigint as units_recent,
      coalesce(sum(units), 0)::bigint as units_long
    from lines
    group by variant_id, location_id
  `);

  return [...rows].map((row) => ({
    variantId: row.variant_id,
    locationId: row.location_id,
    // `sum()::bigint` comes back from postgres.js as a STRING.
    unitsRecent: Number(row.units_recent),
    unitsLong: Number(row.units_long),
  }));
}
