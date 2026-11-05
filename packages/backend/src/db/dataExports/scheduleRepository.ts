/**
 * Reads and writes for `data_export_schedules` — a store's recurring exports.
 *
 * Every read and write is scoped by `store_id` as well as the id: the scoping IS
 * the authorization, so a schedule id from another store answers nothing.
 *
 * The materializer's claim ({@link lockNextDueSchedule}) is `FOR UPDATE SKIP
 * LOCKED` inside the CALLER's transaction, because the run row, the allowance it
 * consumes and the schedule's advance must commit together — a crash between
 * them would either charge for an occurrence that produced nothing or run one
 * that was never charged.
 */

import { and, asc, count, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { DataExportCadence, DataExportDataset } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { dataExportSchedules } from '../schema/dataExports.js';

export type DataExportScheduleRow = typeof dataExportSchedules.$inferSelect;

/** The cadence half of a schedule — what the next-occurrence arithmetic reads. */
export interface DataExportScheduleTiming {
  cadence: DataExportCadence;
  hour: number;
  weekday: number | null;
  dayOfMonth: number | null;
  timeZone: string;
}

export async function insertDataExportSchedule(
  db: DatabaseOrTransaction,
  input: DataExportScheduleTiming & {
    storeId: string;
    dataset: DataExportDataset;
    enabled: boolean;
    nextRunAt: Date | null;
    actorOxyUserId: string;
  },
): Promise<DataExportScheduleRow> {
  const [row] = await db
    .insert(dataExportSchedules)
    .values({
      storeId: input.storeId,
      dataset: input.dataset,
      cadence: input.cadence,
      hour: input.hour,
      weekday: input.weekday,
      dayOfMonth: input.dayOfMonth,
      timeZone: input.timeZone,
      enabled: input.enabled,
      nextRunAt: input.nextRunAt,
      createdByOxyUserId: input.actorOxyUserId,
      updatedByOxyUserId: input.actorOxyUserId,
    })
    .returning();
  if (!row) throw new Error('data_export_schedules insert returned no row');
  return row;
}

export async function findDataExportSchedule(
  storeId: string,
  scheduleId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<DataExportScheduleRow | undefined> {
  const [row] = await db
    .select()
    .from(dataExportSchedules)
    .where(and(eq(dataExportSchedules.storeId, storeId), eq(dataExportSchedules.id, scheduleId)))
    .limit(1);
  return row;
}

/** The store's schedules, newest first. Bounded by the per-store cap. */
export async function listDataExportSchedules(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<DataExportScheduleRow[]> {
  return db
    .select()
    .from(dataExportSchedules)
    .where(eq(dataExportSchedules.storeId, storeId))
    .orderBy(desc(dataExportSchedules.createdAt), desc(dataExportSchedules.id));
}

export async function countDataExportSchedules(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(dataExportSchedules)
    .where(eq(dataExportSchedules.storeId, storeId));
  return row?.total ?? 0;
}

/** Replace a schedule's timing and state. `undefined` when it is not this store's. */
export async function updateDataExportSchedule(
  db: DatabaseOrTransaction,
  input: DataExportScheduleTiming & {
    storeId: string;
    scheduleId: string;
    enabled: boolean;
    nextRunAt: Date | null;
    actorOxyUserId: string;
  },
): Promise<DataExportScheduleRow | undefined> {
  const [row] = await db
    .update(dataExportSchedules)
    .set({
      cadence: input.cadence,
      hour: input.hour,
      weekday: input.weekday,
      dayOfMonth: input.dayOfMonth,
      timeZone: input.timeZone,
      enabled: input.enabled,
      nextRunAt: input.nextRunAt,
      updatedByOxyUserId: input.actorOxyUserId,
    })
    .where(
      and(
        eq(dataExportSchedules.storeId, input.storeId),
        eq(dataExportSchedules.id, input.scheduleId),
      ),
    )
    .returning();
  return row;
}

/** Delete one schedule. Its runs stay, with `schedule_id` set NULL by the foreign key. */
export async function deleteDataExportSchedule(
  db: DatabaseOrTransaction,
  storeId: string,
  scheduleId: string,
): Promise<boolean> {
  const rows = await db
    .delete(dataExportSchedules)
    .where(and(eq(dataExportSchedules.storeId, storeId), eq(dataExportSchedules.id, scheduleId)))
    .returning({ id: dataExportSchedules.id });
  return rows.length === 1;
}

/**
 * Lock the most overdue enabled schedule, skipping any another task holds.
 *
 * MUST run inside the transaction that materializes its run: the row lock is
 * what stops a second task from materializing the same occurrence while this
 * one decides, and it is released only when that transaction commits.
 * `onlyStoreIds` narrows the claim for a test that must not touch a sibling
 * file's schedules on the shared database.
 */
export async function lockNextDueSchedule(
  tx: DatabaseOrTransaction,
  input: { now: Date; onlyStoreIds?: readonly string[] },
): Promise<DataExportScheduleRow | undefined> {
  const scope =
    input.onlyStoreIds === undefined
      ? undefined
      : input.onlyStoreIds.length === 0
        ? sql`false`
        : sql`${dataExportSchedules.storeId} in (${sql.join(
            input.onlyStoreIds.map((id) => sql`${id}`),
            sql`, `,
          )})`;
  const [row] = await tx
    .select()
    .from(dataExportSchedules)
    .where(
      and(
        isNotNull(dataExportSchedules.nextRunAt),
        lte(dataExportSchedules.nextRunAt, input.now),
        ...(scope ? [scope] : []),
      ),
    )
    .orderBy(asc(dataExportSchedules.nextRunAt))
    .limit(1)
    .for('update', { skipLocked: true });
  return row;
}

/** Move a locked schedule on to its next occurrence. The worker's own statement. */
export async function advanceDataExportSchedule(
  tx: DatabaseOrTransaction,
  input: { scheduleId: string; nextRunAt: Date },
): Promise<void> {
  await tx
    .update(dataExportSchedules)
    // `updated_at` is the merchant's last EDIT; the worker's advance keeps it.
    .set({ nextRunAt: input.nextRunAt, updatedAt: sql`${dataExportSchedules.updatedAt}` })
    .where(
      and(eq(dataExportSchedules.id, input.scheduleId), eq(dataExportSchedules.enabled, true)),
    );
}
