/**
 * Request schemas for store data exports (`routes/admin/data-exports.ts`).
 *
 * The time zone is bounded in SHAPE here and checked against the runtime by the
 * service (`isSupportedTimeZone`), the price-alert precedent: an unbounded
 * string must never reach `Intl`.
 */

import { z } from 'zod';
import {
  DATA_EXPORT_CADENCES,
  DATA_EXPORT_DATASETS,
  DATA_EXPORT_MAX_DAY_OF_MONTH,
} from '@mercaria/shared-types';

const dataset = z.enum(DATA_EXPORT_DATASETS);
const cadence = z.enum(DATA_EXPORT_CADENCES);
const hour = z.number().int().min(0).max(23);
const weekday = z.number().int().min(0).max(6);
const dayOfMonth = z.number().int().min(1).max(DATA_EXPORT_MAX_DAY_OF_MONTH);
const timeZone = z.string().trim().min(1).max(64);

/** `POST …/exports/schedules`. */
export const createDataExportScheduleSchema = z
  .object({
    dataset,
    cadence,
    hour,
    weekday: weekday.optional(),
    dayOfMonth: dayOfMonth.optional(),
    timeZone,
    enabled: z.boolean().optional(),
  })
  .strict();

/** `PATCH …/exports/schedules/:scheduleId`. The dataset is not editable. */
export const updateDataExportScheduleSchema = z
  .object({
    cadence: cadence.optional(),
    hour: hour.optional(),
    weekday: weekday.nullable().optional(),
    dayOfMonth: dayOfMonth.nullable().optional(),
    timeZone: timeZone.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** `POST …/exports/runs` — export one dataset now. */
export const requestDataExportSchema = z.object({ dataset }).strict();

/** `GET …/exports/runs`. */
export const listDataExportRunsQuerySchema = z
  .object({
    dataset: dataset.optional(),
    scheduleId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
