/**
 * `catalog_backfill_records` — the per-record report (#60 job behaviour 3 and 4).
 *
 * ONE writer, {@link recordBackfillOutcome}, and it is an upsert on the identity
 * key `(mapping_version, mode, stage, subject_key)`. Every property this table
 * claims follows from that being the only way in:
 *
 * - a re-run of an unchanged catalogue writes the same values back to the same
 *   rows and grows the table by nothing;
 * - `attempts` counts how many times a subject has been examined under one
 *   mapping version, so a poison record is visible without reading a log;
 * - a NEW mapping version writes a NEW row beside the old one, which is what
 *   makes two rule sets comparable rather than sequential;
 * - a dry run and the apply it predicts can never overwrite one another,
 *   because `mode` is inside the key.
 *
 * There is deliberately no delete. Issue job behaviour 7: rollback disables
 * reads and offer publication WITHOUT deleting migration evidence.
 */

import { and, count, desc, eq, sql } from 'drizzle-orm';
import type {
  CatalogBackfillMode,
  CatalogBackfillOutcome,
  CatalogBackfillReasonCode,
  CatalogBackfillStage,
  CatalogBackfillSubjectKind,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { CATALOG_BACKFILL_MAX_TEXT_LENGTH, catalogBackfillRecords } from '../schema/backfill.js';

export type CatalogBackfillRecordRow = typeof catalogBackfillRecords.$inferSelect;

export interface RecordBackfillOutcomeInput {
  readonly runId: string;
  readonly stage: CatalogBackfillStage;
  readonly mode: CatalogBackfillMode;
  readonly mappingVersion: number;
  readonly subjectKind: CatalogBackfillSubjectKind;
  readonly subjectKey: string;
  readonly outcome: CatalogBackfillOutcome;
  readonly reasonCode: CatalogBackfillReasonCode;
  readonly detail?: string | null;
  readonly canonicalProductId?: string | null;
  readonly canonicalVariantId?: string | null;
}

/**
 * Record what a stage did with one subject.
 *
 * Takes an OPTIONAL transaction so a stage that mutates the graph can write its
 * evidence in the SAME transaction as the mutation — which is what stops a crash
 * leaving a minted canonical product with no report row explaining where it came
 * from. Stages that only read pass nothing.
 */
export async function recordBackfillOutcome(
  input: RecordBackfillOutcomeInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(catalogBackfillRecords)
    .values({
      runId: input.runId,
      stage: input.stage,
      mode: input.mode,
      mappingVersion: input.mappingVersion,
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      detail: input.detail?.slice(0, CATALOG_BACKFILL_MAX_TEXT_LENGTH) ?? null,
      canonicalProductId: input.canonicalProductId ?? null,
      canonicalVariantId: input.canonicalVariantId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        catalogBackfillRecords.mappingVersion,
        catalogBackfillRecords.mode,
        catalogBackfillRecords.stage,
        catalogBackfillRecords.subjectKey,
      ],
      set: {
        runId: input.runId,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        detail: input.detail?.slice(0, CATALOG_BACKFILL_MAX_TEXT_LENGTH) ?? null,
        canonicalProductId: input.canonicalProductId ?? null,
        canonicalVariantId: input.canonicalVariantId ?? null,
        // Off the EXISTING row, never `excluded` — CONVENTIONS.md's third
        // concurrency shape. `excluded.attempts` is always the literal 1 this
        // insert supplies, so the count would never leave 1.
        attempts: sql`${catalogBackfillRecords.attempts} + 1`,
      },
    });
}

/** One subject's verdict under one mapping version and mode, if it has one. */
export async function findBackfillRecord(
  input: {
    mappingVersion: number;
    mode: CatalogBackfillMode;
    stage: CatalogBackfillStage;
    subjectKey: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRecordRow | undefined> {
  const rows = await db
    .select()
    .from(catalogBackfillRecords)
    .where(
      and(
        eq(catalogBackfillRecords.mappingVersion, input.mappingVersion),
        eq(catalogBackfillRecords.mode, input.mode),
        eq(catalogBackfillRecords.stage, input.stage),
        eq(catalogBackfillRecords.subjectKey, input.subjectKey),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Every stage's verdict on one subject — the operator trace. */
export async function listBackfillRecordsForSubject(
  subjectKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRecordRow[]> {
  return db
    .select()
    .from(catalogBackfillRecords)
    .where(eq(catalogBackfillRecords.subjectKey, subjectKey))
    .orderBy(desc(catalogBackfillRecords.updatedAt))
    .limit(100);
}

/** One run's rows, worst outcomes first is the caller's job; this filters. */
export async function listBackfillRecordsForRun(
  options: { runId: string; outcome?: CatalogBackfillOutcome; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogBackfillRecordRow[]> {
  return db
    .select()
    .from(catalogBackfillRecords)
    .where(
      options.outcome === undefined
        ? eq(catalogBackfillRecords.runId, options.runId)
        : and(
            eq(catalogBackfillRecords.runId, options.runId),
            eq(catalogBackfillRecords.outcome, options.outcome),
          ),
    )
    .orderBy(desc(catalogBackfillRecords.updatedAt))
    .limit(Math.min(500, Math.max(1, options.limit)));
}

/** One outcome's count, for the dry-run/apply comparison. */
export interface BackfillOutcomeTally {
  readonly outcome: CatalogBackfillOutcome;
  readonly records: number;
}

/**
 * Tally one (mapping version, mode) by outcome — the substrate of the dry-run
 * comparison, and the ONE place a report's total can be re-derived from the rows
 * rather than read off a counter.
 *
 * That redundancy is the point: `catalog_backfill_runs.scanned` is a counter the
 * runner maintains, and this is the same number counted from the evidence. A
 * report surface that shows both is a report a broken runner cannot fake.
 */
export async function tallyBackfillRecords(
  input: { mappingVersion: number; mode: CatalogBackfillMode; stage?: CatalogBackfillStage },
  db: DatabaseOrTransaction = getDb(),
): Promise<BackfillOutcomeTally[]> {
  const predicate =
    input.stage === undefined
      ? and(
          eq(catalogBackfillRecords.mappingVersion, input.mappingVersion),
          eq(catalogBackfillRecords.mode, input.mode),
        )
      : and(
          eq(catalogBackfillRecords.mappingVersion, input.mappingVersion),
          eq(catalogBackfillRecords.mode, input.mode),
          eq(catalogBackfillRecords.stage, input.stage),
        );

  const rows = await db
    .select({ outcome: catalogBackfillRecords.outcome, records: count() })
    .from(catalogBackfillRecords)
    .where(predicate)
    .groupBy(catalogBackfillRecords.outcome);
  return rows;
}
