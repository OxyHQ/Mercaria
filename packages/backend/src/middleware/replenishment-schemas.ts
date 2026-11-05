/**
 * Request schemas for replenishment planning (#89 `replenishment_planning`).
 *
 * The bodies are `.strict()`: a planning setting the schema does not name would
 * otherwise be silently dropped, and the merchant would plan with a number they
 * believe they changed. The bounds are the shared ones the table CHECKs render.
 */

import { z } from 'zod';
import {
  REPLENISHMENT_ROW_STATUSES,
  REPLENISHMENT_SETTING_BOUNDS,
  type ReplenishmentSettingKey,
} from '@mercaria/shared-types';

function days(key: ReplenishmentSettingKey) {
  const { min, max } = REPLENISHMENT_SETTING_BOUNDS[key];
  return z.number().int().min(min).max(max);
}

/** `PUT …/replenishment/settings` — all three, whole. */
export const replenishmentSettingsSchema = z
  .object({
    leadTimeDays: days('leadTimeDays'),
    targetCoverDays: days('targetCoverDays'),
    safetyStockDays: days('safetyStockDays'),
  })
  .strict();

/** `PUT …/replenishment/overrides/:variantId` — absent or `null` inherits. */
export const replenishmentOverrideSchema = z
  .object({
    leadTimeDays: days('leadTimeDays').nullable().optional(),
    targetCoverDays: days('targetCoverDays').nullable().optional(),
    safetyStockDays: days('safetyStockDays').nullable().optional(),
  })
  .strict();

/** `GET …/replenishment/plan`. */
export const replenishmentPlanQuerySchema = z
  .object({
    locationId: z.string().min(1).max(64).optional(),
    status: z.enum(REPLENISHMENT_ROW_STATUSES).optional(),
    limit: z.coerce.number().int().positive().max(5_000).optional(),
    format: z.enum(['json', 'csv']).optional(),
  })
  .strict();
