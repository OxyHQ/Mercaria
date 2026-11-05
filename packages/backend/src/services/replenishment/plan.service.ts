/**
 * Replenishment planning (#89 `replenishment_planning`): a store's forecast and
 * purchase suggestions, computed on read, plus the settings it is computed with.
 *
 * ## What the plan holds the capability for, and what it does not
 *
 * Computing a plan, and changing the settings it is computed with, are the
 * tool's work and require the capability (`requireCapability`, a `flag`: there
 * is nothing to count). READING the settings a store already saved, and
 * deleting an override, never do — a store whose plan ended keeps what it
 * configured, readable, and can tidy it away. Nothing else is stored: there is
 * no forecast row to keep or lose.
 *
 * A suggestion is a list to export. Nothing here creates a purchase order, a
 * supplier order or a stock movement.
 */

import {
  REPLENISHMENT_DEFAULT_SETTINGS,
  REPLENISHMENT_ROW_STATUSES,
  REPLENISHMENT_WINDOW_DAYS,
  type ReplenishmentPlan,
  type ReplenishmentPlanRow,
  type ReplenishmentRowStatus,
  type ReplenishmentSettingValues,
  type ReplenishmentSettingsView,
  type UpsertReplenishmentOverrideInput,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findLocationsByStore } from '../../db/stores/locationRepository.js';
import {
  deleteReplenishmentOverride,
  findReplenishmentSettings,
  findStoreVariant,
  listReplenishmentOverrides,
  putReplenishmentOverride,
  readPlanLevels,
  readPlanSales,
  readPlanVariants,
  upsertReplenishmentSettings,
  type PlanVariant,
} from '../../db/replenishment/replenishmentRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { requireCapability } from '../entitlements/enforce.js';
import {
  averageDailyDemand,
  effectiveSettings,
  projectStock,
  roundTo,
  wholeDaysBetween,
  type SettingOverride,
} from './forecast.js';

const CAPABILITY = 'replenishment_planning' as const;

/** The most tracked variants one plan reads; beyond it the plan says `truncated`. */
export const MAX_PLAN_VARIANTS = 20_000;

/** Rows a JSON plan answers by default, and at most. The CSV carries every row. */
export const DEFAULT_PLAN_ROW_LIMIT = 500;
export const MAX_PLAN_ROW_LIMIT = 5_000;

/** The settings view: what the store saved (or the defaults) and its overrides. */
export async function readReplenishmentSettings(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReplenishmentSettingsView> {
  const [stored, overrides] = await Promise.all([
    findReplenishmentSettings(db, storeId),
    listReplenishmentOverrides(db, storeId),
  ]);
  return {
    settings: {
      storeId,
      ...(stored
        ? {
            leadTimeDays: stored.leadTimeDays,
            targetCoverDays: stored.targetCoverDays,
            safetyStockDays: stored.safetyStockDays,
          }
        : REPLENISHMENT_DEFAULT_SETTINGS),
      saved: stored !== null,
      updatedAt: stored ? stored.updatedAt.toISOString() : null,
    },
    overrides: overrides.map((row) => ({
      variantId: row.variantId,
      listingId: row.listingId,
      productTitle: row.productTitle,
      variantTitle: row.variantTitle,
      sku: row.sku,
      leadTimeDays: row.leadTimeDays,
      targetCoverDays: row.targetCoverDays,
      safetyStockDays: row.safetyStockDays,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

/** Save the store's settings. Requires the capability. */
export async function updateReplenishmentSettings(
  storeId: string,
  values: ReplenishmentSettingValues,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReplenishmentSettingsView> {
  await requireCapability({ storeId, capability: CAPABILITY });
  await upsertReplenishmentSettings(db, storeId, {
    leadTimeDays: values.leadTimeDays,
    targetCoverDays: values.targetCoverDays,
    safetyStockDays: values.safetyStockDays,
  });
  return readReplenishmentSettings(storeId, db);
}

/**
 * Set a variant's override whole. Requires the capability. A field left out or
 * `null` inherits the store's value; all three inheriting removes the override.
 */
export async function setReplenishmentOverride(
  storeId: string,
  variantId: string,
  input: UpsertReplenishmentOverrideInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReplenishmentSettingsView> {
  await requireCapability({ storeId, capability: CAPABILITY });
  const variant = await findStoreVariant(db, storeId, variantId);
  if (!variant) throw notFound('Variant not found');
  await putReplenishmentOverride(db, {
    storeId,
    variantId,
    leadTimeDays: input.leadTimeDays ?? null,
    targetCoverDays: input.targetCoverDays ?? null,
    safetyStockDays: input.safetyStockDays ?? null,
  });
  return readReplenishmentSettings(storeId, db);
}

/** Remove a variant's override. Never gated: it only removes what the store made. */
export async function removeReplenishmentOverride(
  storeId: string,
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReplenishmentSettingsView> {
  const removed = await deleteReplenishmentOverride(db, storeId, variantId);
  if (!removed) throw notFound('Override not found');
  return readReplenishmentSettings(storeId, db);
}

/** What a plan is asked for. */
export interface PlanRequest {
  readonly storeId: string;
  /** One of the store's locations, or absent for store-wide. */
  readonly locationId?: string;
  readonly status?: ReplenishmentRowStatus;
  /** Rows to answer; the CSV passes `Infinity`. */
  readonly limit?: number;
  readonly now?: Date;
}

/** Soonest stock-out first; then the largest suggestion; then by name. */
export function comparePlanRows(a: ReplenishmentPlanRow, b: ReplenishmentPlanRow): number {
  if (a.projectedStockoutDate !== b.projectedStockoutDate) {
    if (a.projectedStockoutDate === null) return 1;
    if (b.projectedStockoutDate === null) return -1;
    return a.projectedStockoutDate < b.projectedStockoutDate ? -1 : 1;
  }
  if (a.suggestedOrderQuantity !== b.suggestedOrderQuantity) {
    return b.suggestedOrderQuantity - a.suggestedOrderQuantity;
  }
  const byProduct = a.productTitle.localeCompare(b.productTitle);
  if (byProduct !== 0) return byProduct;
  const byVariant = a.variantTitle.localeCompare(b.variantTitle);
  if (byVariant !== 0) return byVariant;
  return a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;
}

interface Stock {
  available: number;
  committed: number;
  hasLevel: boolean;
}

interface Sold {
  unitsRecent: number;
  unitsLong: number;
}

/**
 * Compute a store's plan. Requires the capability.
 *
 * Four bounded reads (locations, variants, levels, sales) and arithmetic in
 * memory over at most {@link MAX_PLAN_VARIANTS} variants.
 */
export async function computeReplenishmentPlan(
  request: PlanRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReplenishmentPlan> {
  const { storeId } = request;
  await requireCapability({ storeId, capability: CAPABILITY });
  const now = request.now ?? new Date();

  const storeLocations = await findLocationsByStore(storeId, db);
  const locationId = request.locationId ?? null;
  if (locationId !== null && !storeLocations.some((location) => location.id === locationId)) {
    throw notFound('Location not found');
  }
  const defaultLocationId =
    storeLocations.find((location) => location.isDefault)?.id ??
    storeLocations.find((location) => location.isActive)?.id ??
    null;

  const [stored, overrides, universe, levels, sales] = await Promise.all([
    findReplenishmentSettings(db, storeId),
    listReplenishmentOverrides(db, storeId),
    readPlanVariants(db, storeId, MAX_PLAN_VARIANTS),
    readPlanLevels(db, storeId),
    readPlanSales(db, { storeId, now, defaultLocationId }),
  ]);
  const truncated = universe.length > MAX_PLAN_VARIANTS;
  const variants = truncated ? universe.slice(0, MAX_PLAN_VARIANTS) : universe;

  const storeSettings: ReplenishmentSettingValues = stored
    ? {
        leadTimeDays: stored.leadTimeDays,
        targetCoverDays: stored.targetCoverDays,
        safetyStockDays: stored.safetyStockDays,
      }
    : REPLENISHMENT_DEFAULT_SETTINGS;
  const overrideByVariant = new Map<string, SettingOverride>(
    overrides.map((row) => [row.variantId, row]),
  );

  // Fold levels and sales into the requested scope: one location, or all of them.
  const inScope = (rowLocation: string | null) => locationId === null || rowLocation === locationId;
  const stockByVariant = new Map<string, Stock>();
  for (const level of levels) {
    if (!inScope(level.locationId)) continue;
    const stock = stockByVariant.get(level.variantId) ?? {
      available: 0,
      committed: 0,
      hasLevel: false,
    };
    stock.available += level.available;
    stock.committed += level.committed;
    stock.hasLevel = true;
    stockByVariant.set(level.variantId, stock);
  }
  const soldByVariant = new Map<string, Sold>();
  for (const sale of sales) {
    if (!inScope(sale.locationId)) continue;
    const sold = soldByVariant.get(sale.variantId) ?? { unitsRecent: 0, unitsLong: 0 };
    sold.unitsRecent += sale.unitsRecent;
    sold.unitsLong += sale.unitsLong;
    soldByVariant.set(sale.variantId, sold);
  }

  const allRows: ReplenishmentPlanRow[] = [];
  for (const variant of variants) {
    const stock = stockByVariant.get(variant.variantId);
    const sold = soldByVariant.get(variant.variantId);
    // At one location, a variant that is neither stocked nor sold there is not
    // that location's to plan.
    if (locationId !== null && !stock?.hasLevel && !sold) continue;
    allRows.push(
      planRow({
        variant,
        locationId,
        stock: stock ?? { available: 0, committed: 0, hasLevel: false },
        sold: sold ?? { unitsRecent: 0, unitsLong: 0 },
        settings: effectiveSettings(storeSettings, overrideByVariant.get(variant.variantId)),
        now,
      }),
    );
  }
  allRows.sort(comparePlanRows);

  const counted = (status: ReplenishmentRowStatus) =>
    allRows.filter((row) => row.status === status).length;
  const filtered = request.status
    ? allRows.filter((row) => row.status === request.status)
    : allRows;
  const limit = request.limit ?? DEFAULT_PLAN_ROW_LIMIT;

  return {
    storeId,
    generatedAt: now.toISOString(),
    locationId,
    locations: storeLocations.map((location) => ({
      id: location.id,
      name: location.name,
      isDefault: location.isDefault,
      isActive: location.isActive,
    })),
    settings: storeSettings,
    windowDays: REPLENISHMENT_WINDOW_DAYS,
    rows: Number.isFinite(limit) ? filtered.slice(0, limit) : filtered,
    totalRows: filtered.length,
    truncated,
    summary: {
      stockedOut: counted('stocked_out'),
      reorderNow: counted('reorder_now'),
      healthy: counted('healthy'),
      noRecentSales: counted('no_recent_sales'),
      suggestedUnits: allRows.reduce((sum, row) => sum + row.suggestedOrderQuantity, 0),
    },
  };
}

function planRow(input: {
  variant: PlanVariant;
  locationId: string | null;
  stock: Stock;
  sold: Sold;
  settings: ReturnType<typeof effectiveSettings>;
  now: Date;
}): ReplenishmentPlanRow {
  const { variant, stock, sold, settings, now } = input;
  const demand = averageDailyDemand({
    unitsRecent: sold.unitsRecent,
    unitsLong: sold.unitsLong,
    ageDays: wholeDaysBetween(variant.createdAt, now),
  });
  const projection = projectStock({
    demandPerDay: demand,
    available: stock.available,
    settings,
    now,
  });
  return {
    variantId: variant.variantId,
    listingId: variant.listingId,
    productTitle: variant.productTitle,
    variantTitle: variant.variantTitle,
    sku: variant.sku,
    locationId: input.locationId,
    unitsSoldRecent: sold.unitsRecent,
    unitsSoldLong: sold.unitsLong,
    averageDailyDemand: roundTo(demand, 2),
    available: stock.available,
    committed: stock.committed,
    onHand: stock.available + stock.committed,
    daysOfCover: projection.daysOfCover === null ? null : roundTo(projection.daysOfCover, 1),
    projectedStockoutDate: projection.projectedStockoutDate,
    leadTimeDays: settings.leadTimeDays,
    targetCoverDays: settings.targetCoverDays,
    safetyStockDays: settings.safetyStockDays,
    overridden: settings.overridden,
    reorderPoint: projection.reorderPoint,
    suggestedOrderQuantity: projection.suggestedOrderQuantity,
    status: projection.status,
  };
}

/** The statuses, for validating a filter. */
export const PLAN_ROW_STATUSES: readonly ReplenishmentRowStatus[] = REPLENISHMENT_ROW_STATUSES;

/**
 * One CSV cell. A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe,
 * because a spreadsheet reads it as a formula and product titles are text
 * somebody else may have typed. Numbers are written bare.
 */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** The plan as a purchase-suggestion CSV, in the plan's order. */
export function toReplenishmentCsv(plan: ReplenishmentPlan): string {
  const locationName =
    plan.locationId === null
      ? 'All locations'
      : (plan.locations.find((location) => location.id === plan.locationId)?.name ?? '');
  const header = [
    'product',
    'variant',
    'sku',
    'variant_id',
    'location',
    'status',
    'suggested_order_quantity',
    'projected_stockout_date',
    'days_of_cover',
    'available',
    'committed',
    'on_hand',
    `units_sold_${plan.windowDays.recent}d`,
    `units_sold_${plan.windowDays.long}d`,
    'average_daily_demand',
    'reorder_point',
    'lead_time_days',
    'target_cover_days',
    'safety_stock_days',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of plan.rows) {
    lines.push(
      [
        row.productTitle,
        row.variantTitle,
        row.sku,
        row.variantId,
        locationName,
        row.status,
        row.suggestedOrderQuantity,
        row.projectedStockoutDate,
        row.daysOfCover,
        row.available,
        row.committed,
        row.onHand,
        row.unitsSoldRecent,
        row.unitsSoldLong,
        row.averageDailyDemand,
        row.reorderPoint,
        row.leadTimeDays,
        row.targetCoverDays,
        row.safetyStockDays,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
