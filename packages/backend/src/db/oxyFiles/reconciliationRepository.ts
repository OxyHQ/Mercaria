/**
 * `oxy_file_reference_reconciliations` — one row per entity type: when its next
 * full reconciliation is due, who is running it, and what the last one found.
 *
 * Oxy allows ONE open reconciliation per (application, entity type) and answers
 * a second with 409, so the claim here is a lease: exactly one task runs a type
 * at a time, and a dead task's lease is reclaimed when it expires.
 */

import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { OxyFileReferenceEntityType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  OXY_FILE_REFERENCE_MAX_LAST_ERROR_LENGTH,
  oxyFileReferenceReconciliations,
} from '../schema/oxyFiles.js';

export type OxyFileReferenceReconciliationRow = typeof oxyFileReferenceReconciliations.$inferSelect;

/** Make sure every reconciled type has its row, due now if it is new. */
export async function ensureFileReferenceReconciliations(
  entityTypes: readonly OxyFileReferenceEntityType[],
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (entityTypes.length === 0) return;
  await db
    .insert(oxyFileReferenceReconciliations)
    .values(entityTypes.map((entityType) => ({ entityType, nextRunAt: now })))
    .onConflictDoNothing({ target: oxyFileReferenceReconciliations.entityType });
}

/** Claim ONE due type (due, and not leased by a live task). */
export async function claimFileReferenceReconciliation(
  options: {
    entityTypes: readonly OxyFileReferenceEntityType[];
    leaseOwner: string;
    leaseMs: number;
    now: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<OxyFileReferenceReconciliationRow | undefined> {
  if (options.entityTypes.length === 0) return undefined;
  const due = and(
    inArray(oxyFileReferenceReconciliations.entityType, [...options.entityTypes]),
    lte(oxyFileReferenceReconciliations.nextRunAt, options.now),
    or(
      sql`${oxyFileReferenceReconciliations.leaseUntil} is null`,
      lte(oxyFileReferenceReconciliations.leaseUntil, options.now),
    ),
  );
  const [row] = await db
    .update(oxyFileReferenceReconciliations)
    .set({
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(options.now.getTime() + options.leaseMs),
      attempts: sql`${oxyFileReferenceReconciliations.attempts} + 1`,
      lastStartedAt: options.now,
    })
    .where(
      sql`${oxyFileReferenceReconciliations.id} = (
        select ${oxyFileReferenceReconciliations.id} from ${oxyFileReferenceReconciliations}
        where ${due}
        order by ${asc(oxyFileReferenceReconciliations.nextRunAt)}
        limit 1
        for update skip locked
      )`,
    )
    .returning();
  return row;
}

function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(oxyFileReferenceReconciliations.id, id),
    eq(oxyFileReferenceReconciliations.leaseOwner, leaseOwner),
    gt(oxyFileReferenceReconciliations.leaseUntil, now),
  );
}

export async function completeFileReferenceReconciliation(
  options: {
    id: string;
    leaseOwner: string;
    now: Date;
    nextRunAt: Date;
    dryRun: boolean;
    added: number;
    removed: number;
    unchanged: number;
    refused: number;
    inventory: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(oxyFileReferenceReconciliations)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      attempts: 0,
      nextRunAt: options.nextRunAt,
      lastCompletedAt: options.now,
      lastDryRun: options.dryRun,
      lastAdded: options.added,
      lastRemoved: options.removed,
      lastUnchanged: options.unchanged,
      lastRefused: options.refused,
      lastInventory: options.inventory,
      lastError: null,
    })
    .where(ownedLease(options.id, options.leaseOwner, options.now))
    .returning({ id: oxyFileReferenceReconciliations.id });
  return rows.length === 1;
}

export async function failFileReferenceReconciliation(
  options: { id: string; leaseOwner: string; now: Date; nextRunAt: Date; error: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(oxyFileReferenceReconciliations)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      nextRunAt: options.nextRunAt,
      lastError: options.error.slice(0, OXY_FILE_REFERENCE_MAX_LAST_ERROR_LENGTH),
    })
    .where(ownedLease(options.id, options.leaseOwner, options.now))
    .returning({ id: oxyFileReferenceReconciliations.id });
  return rows.length === 1;
}

/** Extend a live lease still owned by this task (a long inventory). */
export async function renewFileReferenceReconciliation(
  options: { id: string; leaseOwner: string; now: Date; leaseMs: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(oxyFileReferenceReconciliations)
    .set({ leaseUntil: new Date(options.now.getTime() + options.leaseMs) })
    .where(ownedLease(options.id, options.leaseOwner, options.now))
    .returning({ id: oxyFileReferenceReconciliations.id });
  return rows.length === 1;
}
