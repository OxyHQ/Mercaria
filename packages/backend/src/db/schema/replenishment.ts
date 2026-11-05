/**
 * Replenishment planning (#89 `replenishment_planning`) — two tables:
 * `replenishment_settings` (one store's planning defaults) and
 * `replenishment_variant_overrides` (a variant's own lead time, cover or safety
 * stock).
 *
 * ## Only the settings are stored
 *
 * A plan row — demand, days of cover, projected stock-out, suggested quantity —
 * is DERIVED on read from `inventory_levels` and the store's order lines
 * (`db/replenishment/replenishmentRepository.ts`). A stored forecast beside the
 * stock and the sales it was computed from would be a second representation of
 * both, and the stale one the moment a till rang.
 *
 * ## Absent means "the default", so a store that never opened the tool has no row
 *
 * `REPLENISHMENT_DEFAULT_SETTINGS` (shared-types) answers until the store saves
 * its own. An override field is NULL to inherit the store's value, and a row
 * whose three fields are all NULL is refused: an override of nothing is no
 * override, and the service deletes the row instead.
 *
 * Both tables CASCADE from their parent: a setting exists only to configure the
 * store or the variant it names, and nothing else reads it.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { REPLENISHMENT_SETTING_BOUNDS, type ReplenishmentSettingKey } from '@mercaria/shared-types';
import { productVariants } from './catalog';
import { stores } from './stores';

/** `min <= column <= max`, from the shared bounds, optionally admitting NULL. */
function boundsCheck(
  name: string,
  column: AnyPgColumn,
  key: ReplenishmentSettingKey,
  nullable: boolean,
) {
  const { min, max } = REPLENISHMENT_SETTING_BOUNDS[key];
  const range = sql`${column} between ${sql.raw(String(min))} and ${sql.raw(String(max))}`;
  return check(name, nullable ? sql`${column} is null or (${range})` : range);
}

/** `replenishment_settings` — one store's planning defaults, in whole days. */
export const replenishmentSettings = pgTable(
  'replenishment_settings',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    leadTimeDays: integer().notNull(),
    targetCoverDays: integer().notNull(),
    safetyStockDays: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('replenishment_settings_store_id_key').on(t.storeId),
    boundsCheck(
      'replenishment_settings_lead_time_days_check',
      t.leadTimeDays,
      'leadTimeDays',
      false,
    ),
    boundsCheck(
      'replenishment_settings_target_cover_days_check',
      t.targetCoverDays,
      'targetCoverDays',
      false,
    ),
    boundsCheck(
      'replenishment_settings_safety_stock_days_check',
      t.safetyStockDays,
      'safetyStockDays',
      false,
    ),
  ],
);

/**
 * `replenishment_variant_overrides` — one variant's own settings.
 *
 * Unique on the VARIANT alone: a variant belongs to exactly one store (through
 * its listing), so a second key column could only ever disagree. `store_id` is
 * carried for the store-scoped read and is checked against the variant's listing
 * by the service on every write. The variant index also serves the cascade from
 * `product_variants`.
 */
export const replenishmentVariantOverrides = pgTable(
  'replenishment_variant_overrides',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    leadTimeDays: integer(),
    targetCoverDays: integer(),
    safetyStockDays: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('replenishment_variant_overrides_variant_id_key').on(t.variantId),
    index('replenishment_variant_overrides_store_id_idx').on(t.storeId),
    check(
      'replenishment_variant_overrides_not_empty_check',
      sql`num_nonnulls(${t.leadTimeDays}, ${t.targetCoverDays}, ${t.safetyStockDays}) > 0`,
    ),
    boundsCheck(
      'replenishment_variant_overrides_lead_time_days_check',
      t.leadTimeDays,
      'leadTimeDays',
      true,
    ),
    boundsCheck(
      'replenishment_variant_overrides_target_cover_days_check',
      t.targetCoverDays,
      'targetCoverDays',
      true,
    ),
    boundsCheck(
      'replenishment_variant_overrides_safety_stock_days_check',
      t.safetyStockDays,
      'safetyStockDays',
      true,
    ),
  ],
);
