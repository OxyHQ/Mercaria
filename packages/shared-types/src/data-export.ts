/**
 * Store data exports: the free on-demand CSV every store may take of its own
 * data, and the paid SCHEDULE that takes the same CSV on a cadence (#89,
 * `scheduled_exports`).
 *
 * ## One file, two ways to ask for it
 *
 * An on-demand export and a scheduled one are the same RUN: the same dataset
 * reader, the same CSV columns, the same stored file and the same download. The
 * only differences are who asked (a person, or a schedule's occurrence) and
 * that a scheduled run takes one unit of the store's per-period allowance. So a
 * merchant who stops paying loses the schedule and never the export:
 * `data_export` is ungateable, and nothing on the on-demand path reads the plan.
 *
 * Every tuple here types a column AND renders that column's CHECK, so the two
 * can never disagree.
 */

import type { StorePermission } from './store';

/** What an export can contain. Each is the merchant's own data, read the way the dashboard reads it. */
export const DATA_EXPORT_DATASETS = ['orders', 'products', 'customers'] as const;
export type DataExportDataset = (typeof DATA_EXPORT_DATASETS)[number];

/**
 * The store permission that reading each dataset already requires. An export
 * reuses it rather than inventing one: whoever can read a store's orders on the
 * dashboard can export them, and nobody else can.
 */
export const DATA_EXPORT_DATASET_PERMISSIONS: Readonly<Record<DataExportDataset, StorePermission>> =
  {
    orders: 'orders:read',
    products: 'products:read',
    customers: 'customers:read',
  };

/** How often a schedule runs. `weekly` names a weekday, `monthly` a day of the month. */
export const DATA_EXPORT_CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type DataExportCadence = (typeof DATA_EXPORT_CADENCES)[number];

/** The file formats an export is written in. */
export const DATA_EXPORT_FORMATS = ['csv'] as const;
export type DataExportFormat = (typeof DATA_EXPORT_FORMATS)[number];

/** Who asked for a run: a person, now (free), or a schedule's occurrence (paid). */
export const DATA_EXPORT_RUN_TRIGGERS = ['on_demand', 'schedule'] as const;
export type DataExportRunTrigger = (typeof DATA_EXPORT_RUN_TRIGGERS)[number];

/**
 * Where a run stands.
 *
 * `skipped_limit` and `skipped_not_entitled` are a scheduled occurrence the
 * store's plan refused — recorded once, with the schedule moved on to its next
 * occurrence, so a refusal is visible in the history and never retried.
 */
export const DATA_EXPORT_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped_limit',
  'skipped_not_entitled',
] as const;
export type DataExportRunStatus = (typeof DATA_EXPORT_RUN_STATUSES)[number];

/** Why a run failed, once its retries ran out. Never a message: these reach a merchant. */
export const DATA_EXPORT_RUN_FAILURES = ['generation_failed', 'storage_unavailable'] as const;
export type DataExportRunFailure = (typeof DATA_EXPORT_RUN_FAILURES)[number];

/** How long a produced file stays downloadable. The run's row and figures outlive it. */
export const DATA_EXPORT_FILE_RETENTION_DAYS = 30;

/**
 * The most rows one file holds. A larger dataset is written newest first up to
 * this many and the run says it was `truncated`, rather than failing every
 * occurrence of a schedule for ever.
 */
export const DATA_EXPORT_MAX_ROWS = 100_000;

/** How many schedules one store may keep. A bound on configuration, not a plan limit. */
export const DATA_EXPORT_MAX_SCHEDULES_PER_STORE = 20;

/** The last day of the month a monthly schedule may name — every month has it. */
export const DATA_EXPORT_MAX_DAY_OF_MONTH = 28;

/** One export schedule, as the dashboard reads it. */
export interface DataExportScheduleView {
  id: string;
  dataset: DataExportDataset;
  format: DataExportFormat;
  cadence: DataExportCadence;
  /** The local hour (0–23) in {@link timeZone} the run is due at. */
  hour: number;
  /** 0 = Sunday … 6 = Saturday; present exactly for `weekly`. */
  weekday: number | null;
  /** 1–28; present exactly for `monthly`. */
  dayOfMonth: number | null;
  /** An IANA time zone. */
  timeZone: string;
  enabled: boolean;
  /** When the next run is due — `null` while paused. ISO-8601. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One export run — an on-demand export or one scheduled occurrence. */
export interface DataExportRunView {
  id: string;
  /** The schedule that produced it; `null` for an on-demand run or once the schedule was deleted. */
  scheduleId: string | null;
  trigger: DataExportRunTrigger;
  dataset: DataExportDataset;
  format: DataExportFormat;
  status: DataExportRunStatus;
  /** The scheduled instant this run answers; `null` for an on-demand run. ISO-8601. */
  occurrenceAt: string | null;
  rowCount: number | null;
  byteSize: number | null;
  /** The dataset held more than {@link DATA_EXPORT_MAX_ROWS} rows; the file holds the newest. */
  truncated: boolean;
  failure: DataExportRunFailure | null;
  /** Whether a file can be downloaded now (succeeded, and not yet past its retention). */
  downloadable: boolean;
  /** When the file stops being downloadable. ISO-8601. */
  fileExpiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** `POST /admin/stores/:storeId/exports/schedules`. */
export interface CreateDataExportScheduleInput {
  dataset: DataExportDataset;
  cadence: DataExportCadence;
  hour: number;
  weekday?: number;
  dayOfMonth?: number;
  timeZone: string;
  enabled?: boolean;
}

/** `PATCH /admin/stores/:storeId/exports/schedules/:id`. The dataset never changes. */
export interface UpdateDataExportScheduleInput {
  cadence?: DataExportCadence;
  hour?: number;
  weekday?: number | null;
  dayOfMonth?: number | null;
  timeZone?: string;
  enabled?: boolean;
}

/** A short-lived link to one run's file. The URL is a credential: open it, never store it. */
export interface DataExportDownloadView {
  url: string;
  filename: string;
}
