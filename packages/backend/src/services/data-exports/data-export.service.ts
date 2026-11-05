/**
 * Store data exports: the free on-demand export and the paid schedule over it
 * (`docs/data-exports.md`).
 *
 * ## What the plan gates, and what it never touches
 *
 * `scheduled_exports` is a `per_period` capability, and the SCHEDULE is the only
 * thing it buys:
 *
 * - **Creating a schedule, re-enabling one, or editing one that stays enabled**
 *   calls {@link requireCapability}: the store must hold the tool to set up more
 *   recurring work. Pausing and deleting never ask — a merchant may always stop
 *   something.
 * - **Each scheduled occurrence** takes ONE unit of the per-period allowance with
 *   {@link consumeCapabilityOrThrow}, in the transaction that materializes the
 *   run and BEFORE any file is produced. A refusal is recorded on the run
 *   (`skipped_limit` / `skipped_not_entitled`) and the schedule moves on to its
 *   next occurrence: no retry, no storm, and the merchant sees exactly which
 *   occurrence their plan did not cover. A unit is never given back — a period
 *   allowance measures use, and a run that later failed still read the store.
 * - **Reading schedules and runs, downloading a file and exporting on demand**
 *   never read the plan. `data_export` is ungateable: a store that stops paying
 *   keeps every schedule (it stops producing), every run and every file still in
 *   retention, and can export the same data whenever it likes.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DATA_EXPORT_DATASET_PERMISSIONS,
  DATA_EXPORT_DATASETS,
  DATA_EXPORT_FILE_RETENTION_DAYS,
  DATA_EXPORT_MAX_SCHEDULES_PER_STORE,
  isSupportedTimeZone,
  type CreateDataExportScheduleInput,
  type DataExportDataset,
  type DataExportDownloadView,
  type DataExportRunFailure,
  type DataExportRunView,
  type DataExportScheduleView,
  type StorePermission,
  type UpdateDataExportScheduleInput,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { log } from '../../lib/logger.js';
import { conflict, gone, notFound, validationError } from '../../lib/errors/error-codes.js';
import {
  advanceDataExportSchedule,
  countDataExportSchedules,
  deleteDataExportSchedule,
  findDataExportSchedule,
  insertDataExportSchedule,
  listDataExportSchedules,
  lockNextDueSchedule,
  updateDataExportSchedule,
  type DataExportScheduleRow,
  type DataExportScheduleTiming,
} from '../../db/dataExports/scheduleRepository.js';
import {
  claimDataExportRuns,
  completeDataExportRun,
  enqueueOnDemandDataExportRun,
  failDataExportRun,
  findDataExportRun,
  insertScheduledDataExportRun,
  listDataExportRuns,
  markDataExportRunSkipped,
  releaseDataExportRun,
  releaseExpiredDataExportFiles,
  renewDataExportRunLease,
  type DataExportRunRow,
} from '../../db/dataExports/runRepository.js';
import {
  PlanCapabilityRefusal,
  consumeCapabilityOrThrow,
  requireCapability,
} from '../entitlements/enforce.js';
import { buildDataExportFile, DataExportLeaseLost, type DataExportFile } from './datasets.js';
import { nextDataExportOccurrence } from './occurrence.js';
import { oxyDataExportStorage, type DataExportStorage } from './storage.js';

const CAPABILITY = 'scheduled_exports' as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Attempts before a run is `failed`. A crash mid-read counts as one. */
export const DATA_EXPORT_MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Runs listed at most per read. */
const RUN_HISTORY_LIMIT = 100;

// ── Views ──────────────────────────────────────────────────────────────────

export function toDataExportScheduleView(row: DataExportScheduleRow): DataExportScheduleView {
  return {
    id: row.id,
    dataset: row.dataset,
    format: row.format,
    cadence: row.cadence,
    hour: row.hour,
    weekday: row.weekday,
    dayOfMonth: row.dayOfMonth,
    timeZone: row.timeZone,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The run as a merchant reads it. Never the file id, the lease or the operator message. */
export function toDataExportRunView(row: DataExportRunRow, now = new Date()): DataExportRunView {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    trigger: row.trigger,
    dataset: row.dataset,
    format: row.format,
    status: row.status,
    occurrenceAt: row.occurrenceAt?.toISOString() ?? null,
    rowCount: row.rowCount,
    byteSize: row.byteSize,
    truncated: row.truncated,
    failure: row.failure,
    downloadable:
      row.status === 'succeeded' &&
      row.fileId !== null &&
      row.fileExpiresAt !== null &&
      row.fileExpiresAt.getTime() > now.getTime(),
    fileExpiresAt: row.fileExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** The datasets a caller holding `permissions` may export, read and schedule. */
export function readableDataExportDatasets(
  permissions: readonly StorePermission[],
): DataExportDataset[] {
  return DATA_EXPORT_DATASETS.filter((dataset) =>
    permissions.includes(DATA_EXPORT_DATASET_PERMISSIONS[dataset]),
  );
}

function assertReadable(dataset: DataExportDataset, permissions: readonly StorePermission[]) {
  if (!permissions.includes(DATA_EXPORT_DATASET_PERMISSIONS[dataset])) {
    // The same answer as a schedule of another store: nothing to see here.
    throw notFound('Export not found');
  }
}

// ── Schedules ──────────────────────────────────────────────────────────────

function normalizedTiming(input: {
  cadence: DataExportScheduleTiming['cadence'];
  hour: number;
  weekday?: number | null;
  dayOfMonth?: number | null;
  timeZone: string;
}): DataExportScheduleTiming {
  if (!isSupportedTimeZone(input.timeZone)) {
    throw validationError(`Unknown time zone: ${input.timeZone}`);
  }
  if (input.cadence === 'weekly' && (input.weekday === undefined || input.weekday === null)) {
    throw validationError('A weekly export names its weekday');
  }
  if (
    input.cadence === 'monthly' &&
    (input.dayOfMonth === undefined || input.dayOfMonth === null)
  ) {
    throw validationError('A monthly export names its day of the month');
  }
  return {
    cadence: input.cadence,
    hour: input.hour,
    // A cadence carries exactly its own field; anything else is dropped here so
    // the row's shape CHECK is met by construction.
    weekday: input.cadence === 'weekly' ? (input.weekday ?? null) : null,
    dayOfMonth: input.cadence === 'monthly' ? (input.dayOfMonth ?? null) : null,
    timeZone: input.timeZone,
  };
}

export async function listDataExportSchedulesForCaller(
  storeId: string,
  permissions: readonly StorePermission[],
): Promise<DataExportScheduleView[]> {
  const readable = new Set(readableDataExportDatasets(permissions));
  const rows = await listDataExportSchedules(storeId);
  return rows.filter((row) => readable.has(row.dataset)).map(toDataExportScheduleView);
}

/** Create a schedule. Requires the plan's tool; consumes nothing (each RUN does). */
export async function createDataExportSchedule(
  storeId: string,
  actor: { oxyUserId: string; permissions: readonly StorePermission[] },
  input: CreateDataExportScheduleInput,
  now = new Date(),
): Promise<DataExportScheduleView> {
  assertReadable(input.dataset, actor.permissions);
  const timing = normalizedTiming(input);
  await requireCapability({ storeId, capability: CAPABILITY });
  if ((await countDataExportSchedules(storeId)) >= DATA_EXPORT_MAX_SCHEDULES_PER_STORE) {
    throw conflict(
      `A store may keep at most ${DATA_EXPORT_MAX_SCHEDULES_PER_STORE} export schedules`,
    );
  }
  const enabled = input.enabled ?? true;
  const row = await insertDataExportSchedule(getDb(), {
    storeId,
    dataset: input.dataset,
    ...timing,
    enabled,
    nextRunAt: enabled ? nextDataExportOccurrence(timing, now) : null,
    actorOxyUserId: actor.oxyUserId,
  });
  return toDataExportScheduleView(row);
}

/**
 * Edit a schedule. Pausing never asks the plan; anything that leaves the
 * schedule ENABLED (re-enabling, or changing one that runs) requires the tool.
 */
export async function updateDataExportScheduleForCaller(
  storeId: string,
  scheduleId: string,
  actor: { oxyUserId: string; permissions: readonly StorePermission[] },
  patch: UpdateDataExportScheduleInput,
  now = new Date(),
): Promise<DataExportScheduleView> {
  const existing = await findDataExportSchedule(storeId, scheduleId);
  if (!existing) throw notFound('Export schedule not found');
  assertReadable(existing.dataset, actor.permissions);

  const cadence = patch.cadence ?? existing.cadence;
  const timing = normalizedTiming({
    cadence,
    hour: patch.hour ?? existing.hour,
    weekday: patch.weekday === undefined ? existing.weekday : patch.weekday,
    dayOfMonth: patch.dayOfMonth === undefined ? existing.dayOfMonth : patch.dayOfMonth,
    timeZone: patch.timeZone ?? existing.timeZone,
  });
  const enabled = patch.enabled ?? existing.enabled;
  if (enabled) await requireCapability({ storeId, capability: CAPABILITY });

  const timingChanged =
    timing.cadence !== existing.cadence ||
    timing.hour !== existing.hour ||
    timing.weekday !== existing.weekday ||
    timing.dayOfMonth !== existing.dayOfMonth ||
    timing.timeZone !== existing.timeZone;
  // Keep the due instant when nothing about it changed, so an edit cannot
  // skip (or repeat) an occurrence; otherwise the next one from now.
  const nextRunAt = !enabled
    ? null
    : existing.enabled && !timingChanged && existing.nextRunAt
      ? existing.nextRunAt
      : nextDataExportOccurrence(timing, now);

  const row = await updateDataExportSchedule(getDb(), {
    storeId,
    scheduleId,
    ...timing,
    enabled,
    nextRunAt,
    actorOxyUserId: actor.oxyUserId,
  });
  if (!row) throw notFound('Export schedule not found');
  return toDataExportScheduleView(row);
}

/** Delete a schedule. Never gated; its runs and their files stay. */
export async function deleteDataExportScheduleForCaller(
  storeId: string,
  scheduleId: string,
  permissions: readonly StorePermission[],
): Promise<void> {
  const existing = await findDataExportSchedule(storeId, scheduleId);
  if (!existing) throw notFound('Export schedule not found');
  assertReadable(existing.dataset, permissions);
  if (!(await deleteDataExportSchedule(getDb(), storeId, scheduleId))) {
    throw notFound('Export schedule not found');
  }
}

// ── Runs ───────────────────────────────────────────────────────────────────

export async function listDataExportRunsForCaller(
  storeId: string,
  permissions: readonly StorePermission[],
  filter: { scheduleId?: string; dataset?: DataExportDataset } = {},
): Promise<DataExportRunView[]> {
  const readable = readableDataExportDatasets(permissions).filter(
    (dataset) => filter.dataset === undefined || dataset === filter.dataset,
  );
  const rows = await listDataExportRuns({
    storeId,
    datasets: readable,
    ...(filter.scheduleId === undefined ? {} : { scheduleId: filter.scheduleId }),
    limit: RUN_HISTORY_LIMIT,
  });
  const now = new Date();
  return rows.map((row) => toDataExportRunView(row, now));
}

/**
 * Export a dataset NOW — free and ungateable. Answers the queued (or already
 * open) run and starts producing it on this task without waiting for the loop,
 * so the export works whatever the worker lever says.
 */
export async function requestOnDemandDataExport(
  storeId: string,
  actor: { oxyUserId: string; permissions: readonly StorePermission[] },
  dataset: DataExportDataset,
  options: { storage?: DataExportStorage; drainInline?: boolean } = {},
): Promise<DataExportRunView> {
  assertReadable(dataset, actor.permissions);
  const { run, created } = await enqueueOnDemandDataExportRun(getDb(), {
    storeId,
    dataset,
    requestedByOxyUserId: actor.oxyUserId,
    now: new Date(),
  });
  if (created && options.drainInline !== false) {
    void processDataExportRuns({
      onlyRunIds: [run.id],
      ...(options.storage ? { storage: options.storage } : {}),
    }).catch((err: unknown) =>
      log.general.warn(
        { err, runId: run.id },
        '[DataExports] inline export failed; the loop retries',
      ),
    );
  }
  return toDataExportRunView(run);
}

/** The file's name as a merchant saves it. */
export function dataExportFilename(
  row: Pick<DataExportRunRow, 'dataset' | 'occurrenceAt' | 'createdAt'>,
): string {
  const at = (row.occurrenceAt ?? row.createdAt).toISOString().slice(0, 10);
  return `mercaria-${row.dataset}-${at}.csv`;
}

/** A short-lived link to one run's file. Never gated by the plan. */
export async function dataExportDownload(
  storeId: string,
  runId: string,
  permissions: readonly StorePermission[],
  storage: DataExportStorage = oxyDataExportStorage,
  now = new Date(),
): Promise<DataExportDownloadView> {
  const run = await findDataExportRun(storeId, runId);
  if (!run) throw notFound('Export not found');
  assertReadable(run.dataset, permissions);
  if (!toDataExportRunView(run, now).downloadable || !run.fileId) {
    throw gone('This export file is no longer available. Export the data again.');
  }
  const url = await storage.downloadUrl(run.fileId);
  if (!url) throw gone('This export file is no longer available. Export the data again.');
  return { url, filename: dataExportFilename(run) };
}

// ── The worker ─────────────────────────────────────────────────────────────

export type MaterializeOutcome = 'pending' | 'skipped_limit' | 'skipped_not_entitled' | 'existing';

/**
 * Turn every due schedule into ONE run, each in its own transaction:
 * lock the schedule → insert the occurrence's run (idempotent) → take the
 * allowance → advance the schedule. A refused allowance marks the run skipped;
 * the schedule advances either way.
 */
export async function materializeDueDataExportSchedules(
  options: { now?: Date; limit?: number; onlyStoreIds?: readonly string[] } = {},
): Promise<{ scheduleId: string; runId: string | null; outcome: MaterializeOutcome }[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const results: { scheduleId: string; runId: string | null; outcome: MaterializeOutcome }[] = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await getDb().transaction(async (tx) => {
      const schedule = await lockNextDueSchedule(tx, {
        now,
        ...(options.onlyStoreIds ? { onlyStoreIds: options.onlyStoreIds } : {}),
      });
      if (!schedule?.nextRunAt) return undefined;
      const occurrenceAt = schedule.nextRunAt;

      let outcome: MaterializeOutcome = 'existing';
      const run = await insertScheduledDataExportRun(tx, {
        storeId: schedule.storeId,
        scheduleId: schedule.id,
        dataset: schedule.dataset,
        occurrenceAt,
        now,
      });
      if (run) {
        outcome = 'pending';
        try {
          await consumeCapabilityOrThrow(tx, {
            storeId: schedule.storeId,
            capability: CAPABILITY,
            at: now,
          });
        } catch (error) {
          if (!(error instanceof PlanCapabilityRefusal)) throw error;
          outcome = error.reason === 'limit_reached' ? 'skipped_limit' : 'skipped_not_entitled';
          await markDataExportRunSkipped(tx, { runId: run.id, status: outcome, now });
        }
      }
      // The next occurrence after NOW: a schedule reached late runs once for
      // the missed time, never once per missed day.
      const after = now.getTime() > occurrenceAt.getTime() ? now : occurrenceAt;
      await advanceDataExportSchedule(tx, {
        scheduleId: schedule.id,
        nextRunAt: nextDataExportOccurrence(schedule, after),
      });
      return { scheduleId: schedule.id, runId: run?.id ?? null, outcome };
    });
    if (!result) break;
    results.push(result);
  }
  return results;
}

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

const WORKER_OWNER = `data-export:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Why a step failed, safe to store: a message, never a row value or URL. */
function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

async function retryOrFail(
  run: DataExportRunRow,
  leaseOwner: string,
  failure: DataExportRunFailure,
  error: unknown,
): Promise<'failed' | 'retry'> {
  const message = messageOf(error);
  const now = new Date();
  if (run.attempts >= DATA_EXPORT_MAX_ATTEMPTS) {
    await failDataExportRun({ runId: run.id, leaseOwner, failure, message, now });
    return 'failed';
  }
  await releaseDataExportRun({
    runId: run.id,
    leaseOwner,
    availableAt: new Date(now.getTime() + backoffMs(run.attempts)),
    message,
    now,
  });
  return 'retry';
}

/** Produce one claimed run's file. Never throws for the run's own failure. */
async function executeDataExportRun(
  run: DataExportRunRow,
  leaseOwner: string,
  storage: DataExportStorage,
): Promise<'succeeded' | 'failed' | 'retry' | 'lost'> {
  if (run.attempts > DATA_EXPORT_MAX_ATTEMPTS) {
    // A run whose lease kept expiring mid-read (a task that dies on it).
    await failDataExportRun({
      runId: run.id,
      leaseOwner,
      failure: 'generation_failed',
      message: 'attempts exhausted',
    });
    return 'failed';
  }

  let file: DataExportFile;
  try {
    file = await buildDataExportFile(run.storeId, run.dataset, () =>
      renewDataExportRunLease({ runId: run.id, leaseOwner, leaseMs: config.dataExports.leaseMs }),
    );
  } catch (error) {
    if (error instanceof DataExportLeaseLost) return 'lost';
    log.general.warn({ err: error, runId: run.id }, '[DataExports] reading the dataset failed');
    return retryOrFail(run, leaseOwner, 'generation_failed', error);
  }

  let stored: { fileId: string };
  try {
    stored = await storage.store(file.body, dataExportFilename(run));
  } catch (error) {
    log.general.warn({ err: error, runId: run.id }, '[DataExports] storing the file failed');
    return retryOrFail(run, leaseOwner, 'storage_unavailable', error);
  }

  const now = new Date();
  const completed = await completeDataExportRun({
    runId: run.id,
    leaseOwner,
    rowCount: file.rowCount,
    byteSize: file.byteSize,
    truncated: file.truncated,
    fileId: stored.fileId,
    fileExpiresAt: new Date(now.getTime() + DATA_EXPORT_FILE_RETENTION_DAYS * DAY_MS),
    now,
  });
  // A lost lease means another task owns the run now; the file we stored is
  // referenced by nothing, so Oxy collects it.
  return completed ? 'succeeded' : 'lost';
}

/** Claim and produce due runs. Exported so the request path and tests can drive it. */
export async function processDataExportRuns(
  options: {
    storage?: DataExportStorage;
    batchSize?: number;
    onlyStoreIds?: readonly string[];
    onlyRunIds?: readonly string[];
    leaseOwner?: string;
    now?: Date;
  } = {},
): Promise<Record<'succeeded' | 'failed' | 'retry' | 'lost', number>> {
  const leaseOwner = options.leaseOwner ?? WORKER_OWNER;
  const claimed = await claimDataExportRuns({
    leaseOwner,
    batchSize: options.batchSize ?? config.dataExports.batchSize,
    leaseMs: config.dataExports.leaseMs,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onlyStoreIds ? { onlyStoreIds: options.onlyStoreIds } : {}),
    ...(options.onlyRunIds ? { onlyRunIds: options.onlyRunIds } : {}),
  });
  const tally = { succeeded: 0, failed: 0, retry: 0, lost: 0 };
  for (const run of claimed) {
    try {
      tally[await executeDataExportRun(run, leaseOwner, options.storage ?? oxyDataExportStorage)] +=
        1;
    } catch (err) {
      // Per-run isolation: a pass must not strand the rest of its batch leased.
      log.general.error({ err, runId: run.id }, '[DataExports] a run threw; it will be reclaimed');
      tally.lost += 1;
    }
  }
  return tally;
}

/** One worker pass: release expired files, materialize due schedules, produce runs. */
export async function runDataExportWorkerPass(): Promise<void> {
  const released = await releaseExpiredDataExportFiles({ now: new Date(), limit: 200 });
  const materialized = await materializeDueDataExportSchedules();
  const produced = await processDataExportRuns();
  if (released > 0 || materialized.length > 0 || produced.succeeded + produced.failed > 0) {
    log.general.info(
      { released, materialized: materialized.length, ...produced },
      '[DataExports] worker pass',
    );
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

/**
 * Start the export worker on this task. On EVERY task, no leader: schedules are
 * locked `FOR UPDATE SKIP LOCKED` and runs are leased with an owner check.
 *
 * `DATA_EXPORT_WORKER_ENABLED` gates the LOOP and nothing durable. With it off,
 * schedules stay readable and editable, on-demand exports are still produced
 * inline by the request that asked, and turning it back on runs each overdue
 * schedule ONCE.
 */
export function startDataExportWorker(): void {
  if (timer) return;
  if (!config.dataExports.workerEnabled) {
    log.general.info(
      {},
      '[DataExports] worker not started (DATA_EXPORT_WORKER_ENABLED=false); schedules wait, on-demand exports still run',
    );
    return;
  }
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runDataExportWorkerPass()
      .catch((err: unknown) => log.general.error({ err }, '[DataExports] worker pass failed'))
      .finally(() => {
        inFlight = false;
      });
  }, config.dataExports.pollIntervalMs);
  timer.unref?.();
}

/** Stop the worker — test support and graceful shutdown. */
export function stopDataExportWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
