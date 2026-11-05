/**
 * The replenishment arithmetic, pure: no database, no clock of its own.
 *
 * Deliberately simple enough to explain on one line per number, because a
 * merchant buying stock on a suggestion has to be able to check it:
 *
 * - **Demand** is a weighted moving average of two trailing windows' daily
 *   rates (60% the last 28 days, 40% the last 90). A variant younger than a
 *   window is measured over its own age, never fewer than 7 days.
 * - **Days of cover** is sellable stock ÷ demand.
 * - **Projected stock-out** is today plus the whole days of cover.
 * - **Reorder point** is demand × (lead time + safety stock): below it, stock
 *   ordered today arrives after the buffer is already being spent.
 * - **Suggested quantity** is demand × (lead time + target cover + safety
 *   stock) − sellable stock, rounded UP to a whole unit and never negative.
 *
 * There is no incoming-stock term: Mercaria holds no purchase orders for a
 * merchant's own suppliers, so "on order" is unknown and treated as zero. And
 * there is no weekly seasonality: two windows of daily totals cannot support
 * one honestly, and a factor nobody can explain is worse than none.
 */

import {
  REPLENISHMENT_MIN_OBSERVED_DAYS,
  REPLENISHMENT_WINDOW_DAYS,
  REPLENISHMENT_WINDOW_WEIGHTS,
  type ReplenishmentRowStatus,
  type ReplenishmentSettingValues,
} from '@mercaria/shared-types';

const MS_PER_DAY = 86_400_000;

/**
 * Float noise allowance before rounding up. `0.1 × 30` is `3.0000000000000004`,
 * and a merchant told to buy 4 units where the arithmetic meant 3 would be right
 * to distrust every other number on the screen.
 */
const ROUNDING_EPSILON = 1e-9;

/** Sales observed for one variant (store-wide or at one location). */
export interface DemandInput {
  /** Net units sold in the recent window. */
  readonly unitsRecent: number;
  /** Net units sold in the long window (includes the recent one). */
  readonly unitsLong: number;
  /** Whole days since the variant was created. */
  readonly ageDays: number;
}

/** The days a window actually observed for a variant of `ageDays`. */
export function observedDays(windowDays: number, ageDays: number): number {
  const age = Number.isFinite(ageDays) ? Math.max(0, ageDays) : windowDays;
  return Math.min(windowDays, Math.max(REPLENISHMENT_MIN_OBSERVED_DAYS, age));
}

/** Forecast units per day. Never negative; zero when nothing sold. */
export function averageDailyDemand(input: DemandInput): number {
  const recent = Math.max(0, input.unitsRecent);
  const long = Math.max(recent, Math.max(0, input.unitsLong));
  const recentRate = recent / observedDays(REPLENISHMENT_WINDOW_DAYS.recent, input.ageDays);
  const longRate = long / observedDays(REPLENISHMENT_WINDOW_DAYS.long, input.ageDays);
  return (
    REPLENISHMENT_WINDOW_WEIGHTS.recent * recentRate + REPLENISHMENT_WINDOW_WEIGHTS.long * longRate
  );
}

/** Settings after a variant's overrides are laid over the store's. */
export interface EffectiveSettings extends ReplenishmentSettingValues {
  readonly overridden: boolean;
}

/** One variant's partial override: a `null` (or absent) field inherits. */
export interface SettingOverride {
  readonly leadTimeDays: number | null;
  readonly targetCoverDays: number | null;
  readonly safetyStockDays: number | null;
}

export function effectiveSettings(
  store: ReplenishmentSettingValues,
  override: SettingOverride | undefined,
): EffectiveSettings {
  if (!override) return { ...store, overridden: false };
  return {
    leadTimeDays: override.leadTimeDays ?? store.leadTimeDays,
    targetCoverDays: override.targetCoverDays ?? store.targetCoverDays,
    safetyStockDays: override.safetyStockDays ?? store.safetyStockDays,
    overridden:
      override.leadTimeDays !== null ||
      override.targetCoverDays !== null ||
      override.safetyStockDays !== null,
  };
}

/** What the plan says about one variant's stock. */
export interface StockProjection {
  readonly daysOfCover: number | null;
  readonly projectedStockoutDate: string | null;
  readonly reorderPoint: number;
  readonly suggestedOrderQuantity: number;
  readonly status: ReplenishmentRowStatus;
}

/** `YYYY-MM-DD` of `now` plus `days` whole days, in UTC. */
export function addDaysIsoDate(now: Date, days: number): string {
  return new Date(now.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Round up to a whole unit, forgiving float noise. */
function wholeUnitsUp(value: number): number {
  return Math.max(0, Math.ceil(value - ROUNDING_EPSILON));
}

/**
 * Project one variant's stock against its demand.
 *
 * `available` may be negative (an oversold level): it then counts as a deficit
 * the suggestion makes up, and the row is `stocked_out` whether or not it still
 * sells — the units are owed either way.
 */
export function projectStock(input: {
  readonly demandPerDay: number;
  readonly available: number;
  readonly settings: ReplenishmentSettingValues;
  readonly now: Date;
}): StockProjection {
  const demand = Number.isFinite(input.demandPerDay) ? Math.max(0, input.demandPerDay) : 0;
  const position = Math.trunc(input.available);
  const { leadTimeDays, targetCoverDays, safetyStockDays } = input.settings;

  const reorderPoint = wholeUnitsUp(demand * (leadTimeDays + safetyStockDays));
  const target = demand * (leadTimeDays + targetCoverDays + safetyStockDays);
  const suggestedOrderQuantity = wholeUnitsUp(target - position);

  if (demand === 0) {
    return {
      daysOfCover: null,
      projectedStockoutDate: position < 0 ? addDaysIsoDate(input.now, 0) : null,
      reorderPoint,
      suggestedOrderQuantity,
      status: position < 0 ? 'stocked_out' : 'no_recent_sales',
    };
  }

  const daysOfCover = Math.max(0, position) / demand;
  const status: ReplenishmentRowStatus =
    position <= 0
      ? 'stocked_out'
      : position <= reorderPoint && suggestedOrderQuantity > 0
        ? 'reorder_now'
        : 'healthy';

  return {
    daysOfCover,
    projectedStockoutDate: addDaysIsoDate(input.now, Math.floor(daysOfCover + ROUNDING_EPSILON)),
    reorderPoint,
    suggestedOrderQuantity,
    status,
  };
}

/** Round for display; the arithmetic above always uses the unrounded value. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Whole days between `since` and `now`, floored, never negative. */
export function wholeDaysBetween(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / MS_PER_DAY));
}
