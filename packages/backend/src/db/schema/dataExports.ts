/**
 * Store data exports — `data_export_schedules` and `data_export_runs`.
 * Postgres-born; no source model. Reference: `docs/data-exports.md`.
 *
 * ## A run is ONE table for both ways of asking
 *
 * An on-demand export (free, ungateable: `data_export`) and a scheduled
 * occurrence (the paid `scheduled_exports` capability) are the same row shape,
 * the same CSV and the same file. `trigger` says which; the shape CHECKs tie the
 * occurrence columns to it. Keeping them apart would make "a scheduled file
 * equals an on-demand one" a promise two code paths have to keep.
 *
 * ## The occurrence is the idempotency
 *
 * `data_export_runs_schedule_occurrence_key` is UNIQUE on `(schedule_id,
 * occurrence_at)`: a schedule's due instant materializes into at most one run,
 * so a retried claim, a second task or a crash between the claim and the
 * schedule's advance can never produce (or charge for) the same occurrence
 * twice. The materializing statement is `ON CONFLICT DO NOTHING` with the
 * index's predicate repeated.
 *
 * ## A deleted schedule keeps its history
 *
 * `schedule_id` is `ON DELETE SET NULL`: the runs a schedule produced, their
 * figures and (within retention) their files stay readable after the schedule is
 * gone — what a tool created stays the merchant's. `dataset` is therefore on the
 * run itself rather than read through the schedule.
 *
 * ## The file is an Oxy file, held while it is within retention
 *
 * `file_id` is a PRIVATE file of the Mercaria application (Oxy ADR 0043),
 * registered as a `data_export_file` reference by the trigger of the migration
 * that added this table. The worker clears `file_id` once `file_expires_at`
 * passes; the trigger withdraws the reference and Oxy collects the bytes. The row
 * itself is swept a year later (`db/expiryTargets.ts`).
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  DATA_EXPORT_CADENCES,
  DATA_EXPORT_DATASETS,
  DATA_EXPORT_FORMATS,
  DATA_EXPORT_MAX_DAY_OF_MONTH,
  DATA_EXPORT_RUN_FAILURES,
  DATA_EXPORT_RUN_STATUSES,
  DATA_EXPORT_RUN_TRIGGERS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { stores } from './stores';

/** The longest IANA zone name accepted (the request schema bounds it the same). */
export const DATA_EXPORT_MAX_TIME_ZONE_LENGTH = 64;

/** `data_export_schedules` — one recurring export a store configured. */
export const dataExportSchedules = pgTable(
  'data_export_schedules',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    dataset: text({ enum: asEnumValues(DATA_EXPORT_DATASETS) }).notNull(),
    format: text({ enum: asEnumValues(DATA_EXPORT_FORMATS) })
      .notNull()
      .default('csv'),
    cadence: text({ enum: asEnumValues(DATA_EXPORT_CADENCES) }).notNull(),
    /** The local hour, 0–23, in `time_zone`. */
    hour: integer().notNull(),
    /** 0 = Sunday … 6 = Saturday, exactly for `weekly`. */
    weekday: integer(),
    /** 1–28, exactly for `monthly`. */
    dayOfMonth: integer(),
    /** An IANA zone, checked against the runtime by the service. */
    timeZone: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** The next due instant — present exactly while enabled. */
    nextRunAt: timestamptz(),
    createdByOxyUserId: text().notNull(),
    updatedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('data_export_schedules_dataset_check', t.dataset, DATA_EXPORT_DATASETS),
    checkOneOf('data_export_schedules_format_check', t.format, DATA_EXPORT_FORMATS),
    checkOneOf('data_export_schedules_cadence_check', t.cadence, DATA_EXPORT_CADENCES),
    check('data_export_schedules_hour_check', sql`${t.hour} between 0 and 23`),
    // Two biconditionals, never one over a conjunction (house-invariants).
    check(
      'data_export_schedules_weekday_shape_check',
      sql`(${t.cadence} = 'weekly') = (${t.weekday} is not null)
          and (${t.weekday} is null or ${t.weekday} between 0 and 6)`,
    ),
    check(
      'data_export_schedules_day_of_month_shape_check',
      sql`(${t.cadence} = 'monthly') = (${t.dayOfMonth} is not null)
          and (${t.dayOfMonth} is null
               or ${t.dayOfMonth} between 1 and ${sql.raw(String(DATA_EXPORT_MAX_DAY_OF_MONTH))})`,
    ),
    check(
      'data_export_schedules_time_zone_shape_check',
      sql`length(${t.timeZone}) between 1 and ${sql.raw(String(DATA_EXPORT_MAX_TIME_ZONE_LENGTH))}`,
    ),
    check(
      'data_export_schedules_enabled_shape_check',
      sql`${t.enabled} = (${t.nextRunAt} is not null)`,
    ),
    index('data_export_schedules_store_idx').on(t.storeId, t.createdAt),
    /** The materializer's claim read: enabled schedules by due instant. */
    index('data_export_schedules_due_idx').on(t.nextRunAt).where(sql`${t.nextRunAt} is not null`),
  ],
);

/** `data_export_runs` — one export: an on-demand request or a scheduled occurrence. */
export const dataExportRuns = pgTable(
  'data_export_runs',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    scheduleId: text().references(() => dataExportSchedules.id, { onDelete: 'set null' }),
    trigger: text({ enum: asEnumValues(DATA_EXPORT_RUN_TRIGGERS) }).notNull(),
    dataset: text({ enum: asEnumValues(DATA_EXPORT_DATASETS) }).notNull(),
    format: text({ enum: asEnumValues(DATA_EXPORT_FORMATS) })
      .notNull()
      .default('csv'),
    /** The scheduled instant this run answers — exactly for a `schedule` run. */
    occurrenceAt: timestamptz(),
    status: text({ enum: asEnumValues(DATA_EXPORT_RUN_STATUSES) })
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    rowCount: integer(),
    byteSize: bigint({ mode: 'number' }),
    truncated: boolean().notNull().default(false),
    /** The produced file: a PRIVATE Oxy file of the application, cleared at retention. */
    fileId: text(),
    fileExpiresAt: timestamptz(),
    failure: text({ enum: asEnumValues(DATA_EXPORT_RUN_FAILURES) }),
    /** A bounded, redacted message for operators — never a row value. Not on the DTO. */
    lastError: text(),
    /** Who asked, for an on-demand run. A schedule's run names nobody. */
    requestedByOxyUserId: text(),
    completedAt: timestamptz(),
    /** The ROW's retention deadline. Swept by `expiryTargets.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('data_export_runs_trigger_check', t.trigger, DATA_EXPORT_RUN_TRIGGERS),
    checkOneOf('data_export_runs_dataset_check', t.dataset, DATA_EXPORT_DATASETS),
    checkOneOf('data_export_runs_format_check', t.format, DATA_EXPORT_FORMATS),
    checkOneOf('data_export_runs_status_check', t.status, DATA_EXPORT_RUN_STATUSES),
    checkOneOf('data_export_runs_failure_check', t.failure, DATA_EXPORT_RUN_FAILURES),
    check('data_export_runs_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'data_export_runs_figures_check',
      sql`(${t.rowCount} is null or ${t.rowCount} >= 0)
          and (${t.byteSize} is null or ${t.byteSize} >= 0)`,
    ),
    // A schedule run names its occurrence; an on-demand run names neither the
    // occurrence nor a schedule, and names who asked. `schedule_id` may go NULL
    // on a schedule run when the schedule is deleted, so it is one-directional.
    check(
      'data_export_runs_trigger_shape_check',
      sql`(${t.trigger} = 'schedule') = (${t.occurrenceAt} is not null)
          and (${t.trigger} = 'on_demand') = (${t.requestedByOxyUserId} is not null)
          and (${t.trigger} <> 'on_demand' or ${t.scheduleId} is null)`,
    ),
    check(
      'data_export_runs_lease_shape_check',
      sql`(${t.status} = 'running') = (${t.leaseOwner} is not null)
          and (${t.leaseOwner} is null) = (${t.leaseUntil} is null)`,
    ),
    check(
      'data_export_runs_succeeded_shape_check',
      sql`(${t.status} = 'succeeded') = (${t.rowCount} is not null
            and ${t.byteSize} is not null and ${t.fileExpiresAt} is not null)`,
    ),
    check(
      'data_export_runs_failed_shape_check',
      sql`(${t.status} = 'failed') = (${t.failure} is not null)`,
    ),
    check(
      'data_export_runs_file_shape_check',
      sql`${t.fileId} is null or ${t.status} = 'succeeded'`,
    ),
    check(
      'data_export_runs_completed_shape_check',
      sql`(${t.status} in ('pending', 'running')) = (${t.completedAt} is null)`,
    ),
    check(
      'data_export_runs_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= 512`,
    ),
    /** One run per scheduled occurrence: the idempotency of materialization. */
    uniqueIndex('data_export_runs_schedule_occurrence_key')
      .on(t.scheduleId, t.occurrenceAt)
      .where(sql`${t.scheduleId} is not null`),
    /**
     * One OPEN on-demand export per store and dataset: asking again while one is
     * queued or running answers that run instead of reading the store twice.
     */
    uniqueIndex('data_export_runs_open_on_demand_key')
      .on(t.storeId, t.dataset)
      .where(sql`${t.trigger} = 'on_demand' and ${t.status} in ('pending', 'running')`),
    /** The run history read. */
    index('data_export_runs_store_idx').on(t.storeId, t.createdAt),
    /** The worker's claim read. */
    index('data_export_runs_claim_idx')
      .on(t.status, t.availableAt)
      .where(sql`${t.status} in ('pending', 'running')`),
    /** The file-retention read: files still held, by deadline. */
    index('data_export_runs_file_expiry_idx')
      .on(t.fileExpiresAt)
      .where(sql`${t.fileId} is not null`),
    // `data_export_schedules` rows are deleted by a merchant; each delete sets this NULL.
    index('data_export_runs_schedule_id_idx')
      .on(t.scheduleId)
      .where(sql`${t.scheduleId} is not null`),
    /** The EXPIRY SWEEP's own index, leading on the deadline. */
    index('data_export_runs_expiry_idx').on(t.expiresAt),
  ],
);
