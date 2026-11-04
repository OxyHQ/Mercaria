/**
 * `oxy_application_files` — the file ids Oxy has answered as the MERCARIA
 * APPLICATION's own (schema docblock: why the table exists).
 *
 * Written by `services/catalog-media/oxy-files.ts` after an import, upload or
 * adoption made as the application. Read by the maintenance selections that must
 * not ask Oxy about a row that is already done: every such question spends a unit
 * of Oxy's per-application upload budget (30 a minute), and a rerun that re-asked
 * about every finished row is what starved the tail of a production backfill.
 */

import { inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { isOxyFileId } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { oxyApplicationFiles } from '../schema/oxyFiles.js';

/** Record files Oxy answered as the application's. Idempotent. */
export async function recordApplicationFiles(
  fileIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const ids = [...new Set(fileIds.filter((fileId) => isOxyFileId(fileId)))];
  if (ids.length === 0) return;
  await db
    .insert(oxyApplicationFiles)
    .values(ids.map((fileId) => ({ fileId })))
    .onConflictDoNothing({ target: oxyApplicationFiles.fileId });
}

/** Which of these files Oxy has answered as the application's. */
export async function findApplicationFileIds(
  fileIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ fileId: oxyApplicationFiles.fileId })
    .from(oxyApplicationFiles)
    .where(inArray(oxyApplicationFiles.fileId, ids));
  return new Set(rows.map((row) => row.fileId));
}

/**
 * A WHERE predicate: the file `column` holds is NOT known to be the
 * application's — the row may still need Oxy. Only for a `.where()`: drizzle
 * qualifies both columns there (CONVENTIONS.md, "A `WHERE` clause is never
 * rewritten").
 */
export function notApplicationOwned(column: AnyPgColumn): SQL {
  return sql`not exists (select 1 from ${oxyApplicationFiles} where ${oxyApplicationFiles.fileId} = ${column})`;
}
