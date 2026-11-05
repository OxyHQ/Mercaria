/**
 * Reads and writes for `data_export_runs` — one export, on demand or one
 * scheduled occurrence.
 *
 * The lease shape every dispatcher here shares: a claim is `FOR UPDATE SKIP
 * LOCKED` over the due rows and takes a lease with an owner, and every later
 * write on a claimed run carries the owner check — so a worker whose lease
 * expired and was reclaimed cannot complete, fail or release a run it no longer
 * holds.
 *
 * Two idempotency keys, each a partial unique with `ON CONFLICT DO NOTHING
 * RETURNING` repeating its predicate: one run per scheduled occurrence
 * (`data_export_runs_schedule_occurrence_key`), and one OPEN on-demand run per
 * store and dataset (`data_export_runs_open_on_demand_key`).
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type {
  DataExportDataset,
  DataExportRunFailure,
  DataExportRunStatus,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import { dataExportRuns } from '../schema/dataExports.js';

export type DataExportRunRow = typeof dataExportRuns.$inferSelect;

const MAX_ERROR_LENGTH = 512;

function rowExpiry(now: Date): Date {
  return new Date(now.getTime() + RETENTION_SECONDS.dataExportRun * 1_000);
}

/**
 * Materialize one scheduled occurrence, or answer `undefined` when it already
 * exists. MUST run in the transaction that locked the schedule and that takes
 * the allowance, so the three commit together.
 */
export async function insertScheduledDataExportRun(
  tx: DatabaseOrTransaction,
  input: {
    storeId: string;
    scheduleId: string;
    dataset: DataExportDataset;
    occurrenceAt: Date;
    now: Date;
  },
): Promise<DataExportRunRow | undefined> {
  const [row] = await tx
    .insert(dataExportRuns)
    .values({
      storeId: input.storeId,
      scheduleId: input.scheduleId,
      trigger: 'schedule',
      dataset: input.dataset,
      occurrenceAt: input.occurrenceAt,
      status: 'pending',
      availableAt: input.now,
      expiresAt: rowExpiry(input.now),
    })
    .onConflictDoNothing({
      target: [dataExportRuns.scheduleId, dataExportRuns.occurrenceAt],
      where: sql`${dataExportRuns.scheduleId} is not null`,
    })
    .returning();
  return row;
}

/** Record that the plan refused a just-materialized occurrence. Terminal, never retried. */
export async function markDataExportRunSkipped(
  tx: DatabaseOrTransaction,
  input: { runId: string; status: 'skipped_limit' | 'skipped_not_entitled'; now: Date },
): Promise<void> {
  await tx
    .update(dataExportRuns)
    .set({ status: input.status, completedAt: input.now })
    .where(and(eq(dataExportRuns.id, input.runId), eq(dataExportRuns.status, 'pending')));
}

/**
 * Queue an on-demand export, or answer the one already open for this store and
 * dataset — asking twice while the first is running reads the store once.
 */
export async function enqueueOnDemandDataExportRun(
  db: DatabaseOrTransaction,
  input: {
    storeId: string;
    dataset: DataExportDataset;
    requestedByOxyUserId: string;
    now: Date;
  },
): Promise<{ run: DataExportRunRow; created: boolean }> {
  const [inserted] = await db
    .insert(dataExportRuns)
    .values({
      storeId: input.storeId,
      trigger: 'on_demand',
      dataset: input.dataset,
      status: 'pending',
      availableAt: input.now,
      requestedByOxyUserId: input.requestedByOxyUserId,
      expiresAt: rowExpiry(input.now),
    })
    .onConflictDoNothing({
      target: [dataExportRuns.storeId, dataExportRuns.dataset],
      where: sql`${dataExportRuns.trigger} = 'on_demand' and ${dataExportRuns.status} in ('pending', 'running')`,
    })
    .returning();
  if (inserted) return { run: inserted, created: true };
  const [open] = await db
    .select()
    .from(dataExportRuns)
    .where(
      and(
        eq(dataExportRuns.storeId, input.storeId),
        eq(dataExportRuns.dataset, input.dataset),
        eq(dataExportRuns.trigger, 'on_demand'),
        inArray(dataExportRuns.status, ['pending', 'running']),
      ),
    )
    .limit(1);
  // The open run finished between the insert and this read: enqueue afresh.
  if (!open) return enqueueOnDemandDataExportRun(db, input);
  return { run: open, created: false };
}

export async function findDataExportRun(
  storeId: string,
  runId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<DataExportRunRow | undefined> {
  const [row] = await db
    .select()
    .from(dataExportRuns)
    .where(and(eq(dataExportRuns.storeId, storeId), eq(dataExportRuns.id, runId)))
    .limit(1);
  return row;
}

/** A store's runs over the datasets the caller may read, newest first. */
export async function listDataExportRuns(
  input: {
    storeId: string;
    datasets: readonly DataExportDataset[];
    scheduleId?: string;
    limit: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<DataExportRunRow[]> {
  if (input.datasets.length === 0) return [];
  return db
    .select()
    .from(dataExportRuns)
    .where(
      and(
        eq(dataExportRuns.storeId, input.storeId),
        inArray(dataExportRuns.dataset, [...input.datasets]),
        ...(input.scheduleId === undefined
          ? []
          : [eq(dataExportRuns.scheduleId, input.scheduleId)]),
      ),
    )
    .orderBy(desc(dataExportRuns.createdAt), desc(dataExportRuns.id))
    .limit(Math.max(1, input.limit));
}

/**
 * Claim due runs: pending and available, or running with an expired lease.
 * `onlyStoreIds` narrows the claim for a test on the shared database.
 */
export async function claimDataExportRuns(
  options: {
    leaseOwner: string;
    batchSize: number;
    leaseMs: number;
    now?: Date;
    onlyStoreIds?: readonly string[];
    onlyRunIds?: readonly string[];
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<DataExportRunRow[]> {
  const now = options.now ?? new Date();
  const due = or(
    and(eq(dataExportRuns.status, 'pending'), lte(dataExportRuns.availableAt, now)),
    and(eq(dataExportRuns.status, 'running'), lte(dataExportRuns.leaseUntil, now)),
  );
  const scopes = [
    ...(options.onlyStoreIds === undefined
      ? []
      : [
          options.onlyStoreIds.length === 0
            ? sql`false`
            : inArray(dataExportRuns.storeId, [...options.onlyStoreIds]),
        ]),
    ...(options.onlyRunIds === undefined
      ? []
      : [
          options.onlyRunIds.length === 0
            ? sql`false`
            : inArray(dataExportRuns.id, [...options.onlyRunIds]),
        ]),
  ];
  const where = and(due, ...scopes);
  return db
    .update(dataExportRuns)
    .set({
      status: 'running',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + options.leaseMs),
      attempts: sql`${dataExportRuns.attempts} + 1`,
    })
    .where(
      sql`${dataExportRuns.id} in (
        select ${dataExportRuns.id} from ${dataExportRuns}
        where ${where}
        order by ${asc(dataExportRuns.availableAt)}
        limit ${Math.max(1, options.batchSize)}
        for update skip locked
      )`,
    )
    .returning();
}

/** The owner check every write on a claimed run shares. */
function ownedLease(runId: string, leaseOwner: string, now: Date) {
  return and(
    eq(dataExportRuns.id, runId),
    eq(dataExportRuns.status, 'running' satisfies DataExportRunStatus),
    eq(dataExportRuns.leaseOwner, leaseOwner),
    gt(dataExportRuns.leaseUntil, now),
  );
}

/** Extend a held lease. `false` means it is no longer held: stop working on it. */
export async function renewDataExportRunLease(
  options: { runId: string; leaseOwner: string; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(dataExportRuns)
    .set({ leaseUntil: new Date(now.getTime() + options.leaseMs) })
    .where(ownedLease(options.runId, options.leaseOwner, now))
    .returning({ id: dataExportRuns.id });
  return rows.length === 1;
}

/** The file is stored: the run succeeded. `false` when the lease was lost first. */
export async function completeDataExportRun(
  options: {
    runId: string;
    leaseOwner: string;
    rowCount: number;
    byteSize: number;
    truncated: boolean;
    fileId: string;
    fileExpiresAt: Date;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(dataExportRuns)
    .set({
      status: 'succeeded',
      rowCount: options.rowCount,
      byteSize: options.byteSize,
      truncated: options.truncated,
      fileId: options.fileId,
      fileExpiresAt: options.fileExpiresAt,
      completedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(options.runId, options.leaseOwner, now))
    .returning({ id: dataExportRuns.id });
  return rows.length === 1;
}

/** Retries are spent: terminal, with the reason a merchant reads. */
export async function failDataExportRun(
  options: {
    runId: string;
    leaseOwner: string;
    failure: DataExportRunFailure;
    message: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(dataExportRuns)
    .set({
      status: 'failed',
      failure: options.failure,
      lastError: options.message.slice(0, MAX_ERROR_LENGTH),
      completedAt: now,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.runId, options.leaseOwner, now))
    .returning({ id: dataExportRuns.id });
  return rows.length === 1;
}

/** A retryable failure: back to `pending` after a backoff. */
export async function releaseDataExportRun(
  options: {
    runId: string;
    leaseOwner: string;
    availableAt: Date;
    message: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(dataExportRuns)
    .set({
      status: 'pending',
      availableAt: options.availableAt,
      lastError: options.message.slice(0, MAX_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.runId, options.leaseOwner, now))
    .returning({ id: dataExportRuns.id });
  return rows.length === 1;
}

/**
 * Let go of files whose retention ended: clear `file_id`, which the reference
 * trigger turns into a withdrawn Oxy reference (Oxy then collects the bytes).
 * The row and its figures stay. Answers how many were released.
 */
export async function releaseExpiredDataExportFiles(
  input: { now: Date; limit: number; onlyStoreIds?: readonly string[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const scope =
    input.onlyStoreIds === undefined
      ? []
      : [
          input.onlyStoreIds.length === 0
            ? sql`false`
            : inArray(dataExportRuns.storeId, [...input.onlyStoreIds]),
        ];
  const rows = await db
    .update(dataExportRuns)
    .set({ fileId: null })
    .where(
      sql`${dataExportRuns.id} in (
        select ${dataExportRuns.id} from ${dataExportRuns}
        where ${and(isNotNull(dataExportRuns.fileId), lt(dataExportRuns.fileExpiresAt, input.now), ...scope)}
        order by ${asc(dataExportRuns.fileExpiresAt)}
        limit ${Math.max(1, input.limit)}
        for update skip locked
      )`,
    )
    .returning({ id: dataExportRuns.id });
  return rows.length;
}
