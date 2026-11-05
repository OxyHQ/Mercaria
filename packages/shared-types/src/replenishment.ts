/**
 * Replenishment planning (#89 `replenishment_planning`): a store's own demand
 * forecast and purchase suggestions over its multi-location inventory.
 *
 * Everything here describes the merchant's OWN stock and sales. A plan row is
 * computed on read from `inventory_levels` and the store's order lines; only the
 * planning SETTINGS are stored. A purchase suggestion is a list the merchant
 * exports — nothing in this domain creates a supplier order.
 */

import type { ListingStatus } from './listing';
import type { OrderStatus } from './order';
import type { RefundStatus } from './refund';

/**
 * The order statuses whose lines count as a SALE: the order was paid and not
 * cancelled. `pending_payment` is a reservation, `cancelled` and `refunded`
 * gave every unit (and the money) back. A `partially_refunded` order counts,
 * minus its refunded units.
 */
export const REPLENISHMENT_SALE_ORDER_STATUSES = [
  'paid',
  'processing',
  'shipped',
  'delivered',
  'digitally_delivered',
  'partially_refunded',
] as const satisfies readonly OrderStatus[];

/** The refund statuses whose units are subtracted from a sale. */
export const REPLENISHMENT_COUNTED_REFUND_STATUSES = [
  'refunded',
  'restocked',
] as const satisfies readonly RefundStatus[];

/** The listing statuses whose tracked variants are planned. */
export const REPLENISHMENT_LISTING_STATUSES = [
  'active',
  'sold',
] as const satisfies readonly ListingStatus[];

/** The two trailing windows the demand forecast reads, in days. */
export const REPLENISHMENT_WINDOW_DAYS = { recent: 28, long: 90 } as const;

/**
 * How the two windows' daily rates are blended: the recent month weighs more,
 * so a product picking up (or slowing down) moves the forecast within weeks,
 * while the quarter keeps one unusual week from swinging it.
 */
export const REPLENISHMENT_WINDOW_WEIGHTS = { recent: 0.6, long: 0.4 } as const;

/**
 * A variant younger than a window is measured over its own age instead, but
 * never over fewer than this many days — one sale on a variant created
 * yesterday is not a rate of one a day.
 */
export const REPLENISHMENT_MIN_OBSERVED_DAYS = 7;

/** The three planning settings, in whole days. */
export interface ReplenishmentSettingValues {
  /** Days between placing a purchase and the stock being sellable. */
  readonly leadTimeDays: number;
  /** Days of demand a purchase should cover once it arrives. */
  readonly targetCoverDays: number;
  /** Extra days of demand held as a buffer against a slow supplier or a busy week. */
  readonly safetyStockDays: number;
}

export type ReplenishmentSettingKey = keyof ReplenishmentSettingValues;

export const REPLENISHMENT_SETTING_KEYS = [
  'leadTimeDays',
  'targetCoverDays',
  'safetyStockDays',
] as const satisfies readonly ReplenishmentSettingKey[];

/** Inclusive bounds for each setting; the table CHECKs render the same numbers. */
export const REPLENISHMENT_SETTING_BOUNDS: Readonly<
  Record<ReplenishmentSettingKey, { readonly min: number; readonly max: number }>
> = {
  leadTimeDays: { min: 0, max: 365 },
  targetCoverDays: { min: 0, max: 365 },
  safetyStockDays: { min: 0, max: 180 },
};

/** What a store plans with until it saves settings of its own. */
export const REPLENISHMENT_DEFAULT_SETTINGS: ReplenishmentSettingValues = {
  leadTimeDays: 14,
  targetCoverDays: 28,
  safetyStockDays: 7,
};

/** A store's planning settings. */
export interface ReplenishmentSettings extends ReplenishmentSettingValues {
  readonly storeId: string;
  /** False until the store saves its own; the values are then the defaults. */
  readonly saved: boolean;
  readonly updatedAt: string | null;
}

/** One variant's own settings; a `null` field inherits the store's. */
export interface ReplenishmentVariantOverride {
  readonly variantId: string;
  readonly listingId: string;
  readonly productTitle: string;
  readonly variantTitle: string;
  readonly sku: string | null;
  readonly leadTimeDays: number | null;
  readonly targetCoverDays: number | null;
  readonly safetyStockDays: number | null;
  readonly updatedAt: string;
}

/** `GET …/replenishment/settings`. */
export interface ReplenishmentSettingsView {
  readonly settings: ReplenishmentSettings;
  readonly overrides: readonly ReplenishmentVariantOverride[];
}

/** `PUT …/replenishment/settings`. */
export type UpdateReplenishmentSettingsInput = ReplenishmentSettingValues;

/** `PUT …/replenishment/overrides/:variantId` — at least one field set. */
export interface UpsertReplenishmentOverrideInput {
  readonly leadTimeDays?: number | null;
  readonly targetCoverDays?: number | null;
  readonly safetyStockDays?: number | null;
}

/**
 * Where a row stands.
 *
 * - `stocked_out` — nothing sellable left (or oversold) while it still sells.
 * - `reorder_now` — stock will not outlast the lead time plus safety stock.
 * - `healthy` — selling, and stock covers the lead time plus safety stock.
 * - `no_recent_sales` — nothing sold in the long window.
 */
export const REPLENISHMENT_ROW_STATUSES = [
  'stocked_out',
  'reorder_now',
  'healthy',
  'no_recent_sales',
] as const;
export type ReplenishmentRowStatus = (typeof REPLENISHMENT_ROW_STATUSES)[number];

/** One variant, store-wide or at one location. */
export interface ReplenishmentPlanRow {
  readonly variantId: string;
  readonly listingId: string;
  readonly productTitle: string;
  readonly variantTitle: string;
  readonly sku: string | null;
  /** The location the row is for; `null` for the store-wide row. */
  readonly locationId: string | null;
  /** Units sold net of refunds, over the recent and the long window. */
  readonly unitsSoldRecent: number;
  readonly unitsSoldLong: number;
  /** Forecast units per day, rounded to two decimals. */
  readonly averageDailyDemand: number;
  /** Sellable now (`inventory_levels.available`); negative when oversold. */
  readonly available: number;
  /** Reserved by placed orders that have not shipped. */
  readonly committed: number;
  /** `available + committed`. */
  readonly onHand: number;
  /** Days `available` lasts at the forecast; `null` when nothing sells. */
  readonly daysOfCover: number | null;
  /** `YYYY-MM-DD` (UTC) the forecast runs out; `null` when nothing sells. */
  readonly projectedStockoutDate: string | null;
  readonly leadTimeDays: number;
  readonly targetCoverDays: number;
  readonly safetyStockDays: number;
  /** Whether any of the three settings came from a variant override. */
  readonly overridden: boolean;
  /** Units of `available` at which to reorder: demand × (lead time + safety stock). */
  readonly reorderPoint: number;
  /** Units to buy now, whole and never negative. */
  readonly suggestedOrderQuantity: number;
  readonly status: ReplenishmentRowStatus;
}

/** One of the store's locations, for the filter. */
export interface ReplenishmentLocation {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

/** `GET …/replenishment/plan`. */
export interface ReplenishmentPlan {
  readonly storeId: string;
  readonly generatedAt: string;
  /** `null` for store-wide. */
  readonly locationId: string | null;
  readonly locations: readonly ReplenishmentLocation[];
  readonly settings: ReplenishmentSettingValues;
  readonly windowDays: typeof REPLENISHMENT_WINDOW_DAYS;
  /** Soonest stock-out first. */
  readonly rows: readonly ReplenishmentPlanRow[];
  /** Rows before `limit` was applied. */
  readonly totalRows: number;
  /** True when the store has more tracked variants than one plan reads. */
  readonly truncated: boolean;
  readonly summary: {
    readonly stockedOut: number;
    readonly reorderNow: number;
    readonly healthy: number;
    readonly noRecentSales: number;
    readonly suggestedUnits: number;
  };
}
