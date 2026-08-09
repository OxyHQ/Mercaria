/**
 * Reads and writes for `catalog_source_rejections` — the RESIDUAL (#62
 * §"Observability" 2, §"Health" 4/9).
 *
 * `~/Oxy/AGENTS.md` states the rule this table exists for: an inventory whose
 * output is "nothing is wrong" cannot distinguish finding less from there being
 * less, and the defence is to print what could not be classified and make a
 * person explain it. A `rejected` counter says a page dropped eleven records;
 * only these rows say all eleven were the same field a provider renamed, which
 * is what tells schema drift from one bad page.
 *
 * The detail composed here names FIELDS and never VALUES. A rejection note
 * carrying the payload that caused it would put exactly the content the
 * allow-list exists to exclude into the one table nobody thought to check.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  CatalogSourceRejectionReason,
  SourceRecordExternalType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import { CATALOG_SOURCE_MAX_TEXT_LENGTH, catalogSourceRejections } from '../schema/ingestion.js';

export type CatalogSourceRejectionRow = typeof catalogSourceRejections.$inferSelect;

export interface RecordRejectionInput {
  runId: string;
  sourceId: string;
  externalType: SourceRecordExternalType | null;
  externalId: string | null;
  reasonCode: CatalogSourceRejectionReason;
  detail: string | null;
  rawPayloadDigest: string | null;
  now: Date;
}

/**
 * Record one refused record.
 *
 * `expires_at` is stamped at WRITE time from `RETENTION_SECONDS`, so the sweep
 * needs no filter — the registry has no way to express one, and computing the
 * deadline here keeps the writer and `expiryTargets.ts` reading the same
 * constant instead of two copies of thirty days.
 */
export async function recordSourceRejection(
  db: DatabaseOrTransaction,
  input: RecordRejectionInput,
): Promise<void> {
  await db.insert(catalogSourceRejections).values({
    runId: input.runId,
    sourceId: input.sourceId,
    externalType: input.externalType,
    externalId: input.externalId,
    reasonCode: input.reasonCode,
    detail: input.detail === null ? null : input.detail.slice(0, CATALOG_SOURCE_MAX_TEXT_LENGTH),
    rawPayloadDigest: input.rawPayloadDigest,
    expiresAt: new Date(input.now.getTime() + RETENTION_SECONDS.catalogSourceRejection * 1_000),
  });
}

/** One source's rejections, newest first — the diagnosis read. */
export async function listSourceRejections(
  db: DatabaseOrTransaction = getDb(),
  input: { sourceId: string; reasonCode?: CatalogSourceRejectionReason; limit: number },
): Promise<CatalogSourceRejectionRow[]> {
  const scope =
    input.reasonCode === undefined
      ? eq(catalogSourceRejections.sourceId, input.sourceId)
      : and(
          eq(catalogSourceRejections.sourceId, input.sourceId),
          eq(catalogSourceRejections.reasonCode, input.reasonCode),
        );
  return db
    .select()
    .from(catalogSourceRejections)
    .where(scope)
    .orderBy(desc(catalogSourceRejections.createdAt))
    .limit(input.limit);
}

/**
 * One source's rejections grouped by reason — the shape that tells drift apart
 * from noise.
 *
 * Eleven rejections spread across five reasons is a feed with some bad rows;
 * eleven under one reason is a provider that changed something. The counter on
 * the run cannot express that difference, which is why this read exists beside
 * it rather than instead of it.
 */
export async function summarizeSourceRejections(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      reasonCode: catalogSourceRejections.reasonCode,
      total: sql<number>`count(*)::int`,
    })
    .from(catalogSourceRejections)
    .where(eq(catalogSourceRejections.sourceId, sourceId))
    .groupBy(catalogSourceRejections.reasonCode);
  const result: Record<string, number> = {};
  for (const row of rows) result[row.reasonCode] = row.total;
  return result;
}
