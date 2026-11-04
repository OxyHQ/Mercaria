/**
 * `oxy_file_references` — the references Oxy has acknowledged for Mercaria.
 *
 * Written only by the reference worker (after Oxy answered) and by the
 * reconciliation's ledger pass (after Oxy committed a full inventory). Read by
 * the worker, to know what a removal must withdraw once the holding row is gone,
 * and by the file-event handler, to find which entities were told about a file.
 */

import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { OxyFileReferenceEntityType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { oxyFileReferences, type OxyFileReferenceState } from '../schema/oxyFiles.js';

export interface FileReferenceLedgerEntry {
  readonly entityId: string;
  readonly fileId: string;
  readonly state: OxyFileReferenceState;
}

/** Every acknowledged reference of these entities. */
export async function findFileReferenceLedger(
  entityType: OxyFileReferenceEntityType,
  entityIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<FileReferenceLedgerEntry[]> {
  if (entityIds.length === 0) return [];
  return db
    .select({
      entityId: oxyFileReferences.entityId,
      fileId: oxyFileReferences.fileId,
      state: oxyFileReferences.state,
    })
    .from(oxyFileReferences)
    .where(
      and(
        eq(oxyFileReferences.entityType, entityType),
        inArray(oxyFileReferences.entityId, [...entityIds]),
      ),
    );
}

/**
 * Record what Oxy answered for these pairs. An existing pair takes the NEW
 * state: a reference refused yesterday and accepted today is registered.
 */
export async function recordFileReferences(
  entityType: OxyFileReferenceEntityType,
  entries: readonly FileReferenceLedgerEntry[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  for (let start = 0; start < entries.length; start += 500) {
    const batch = entries.slice(start, start + 500);
    await db
      .insert(oxyFileReferences)
      .values(batch.map((entry) => ({ entityType, ...entry })))
      .onConflictDoUpdate({
        target: [
          oxyFileReferences.entityType,
          oxyFileReferences.entityId,
          oxyFileReferences.fileId,
        ],
        set: { state: sql`excluded.state` },
      });
  }
}

/** Forget pairs Oxy no longer holds (or never accepted). */
export async function forgetFileReferences(
  entityType: OxyFileReferenceEntityType,
  pairs: readonly { entityId: string; fileId: string }[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  for (let start = 0; start < pairs.length; start += 500) {
    const batch = pairs.slice(start, start + 500);
    await db.delete(oxyFileReferences).where(
      and(
        eq(oxyFileReferences.entityType, entityType),
        sql`(${oxyFileReferences.entityId}, ${oxyFileReferences.fileId}) in (${sql.join(
          batch.map((pair) => sql`(${pair.entityId}, ${pair.fileId})`),
          sql`, `,
        )})`,
      ),
    );
  }
}

/** One keyset page of the entity ids the ledger holds for a type. */
export async function findFileReferenceLedgerEntityPage(
  entityType: OxyFileReferenceEntityType,
  after: string | undefined,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ entityId: oxyFileReferences.entityId })
    .from(oxyFileReferences)
    .where(
      and(
        eq(oxyFileReferences.entityType, entityType),
        after === undefined ? undefined : gt(oxyFileReferences.entityId, after),
      ),
    )
    .orderBy(asc(oxyFileReferences.entityId))
    .limit(limit);
  return rows.map((row) => row.entityId);
}

/** Every entity the ledger says was told about a file. */
export async function findFileReferenceLedgerByFile(
  fileId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ entityType: OxyFileReferenceEntityType; entityId: string }[]> {
  return db
    .select({ entityType: oxyFileReferences.entityType, entityId: oxyFileReferences.entityId })
    .from(oxyFileReferences)
    .where(eq(oxyFileReferences.fileId, fileId));
}
