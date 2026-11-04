/**
 * `recordBackfillOutcomes` — a page of evidence in ONE upsert — keeps every
 * property the one-row-per-statement writer had.
 *
 * The batch exists because one statement per subject was one commit per
 * subject (`IO:WalSync`, ~13 a second from `rebuild_projections` alone). What
 * must not change with it:
 *
 *  - each row carries ITS OWN verdict (the upsert's `set` reads `excluded`, and
 *    a mistake there copies one subject's values onto every other);
 *  - `attempts` counts examinations: +1 per page that examined the subject;
 *  - a subject named twice in one page is one row (Postgres refuses to update a
 *    row twice in one statement), carrying the LAST verdict and BOTH
 *    examinations — what two sequential writes would have left.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { catalogBackfillRecords, catalogBackfillRuns } from '../schema/backfill.js';
import {
  recordBackfillOutcome,
  recordBackfillOutcomes,
  type RecordBackfillOutcomeInput,
} from '../backfill/backfillRecordRepository.js';
import { openBackfillRun } from '../backfill/backfillRunRepository.js';

let db: Database;
let runId: string;
const subjectKeys: string[] = [];

/** A mapping version no real run uses, so the rows are this file's alone. */
const MAPPING_VERSION = 9_000_000 + Math.floor(Math.random() * 1_000_000);

function verdict(
  subjectKey: string,
  reasonCode: 'projection_current' | 'projection_refreshed',
  detail: string,
): RecordBackfillOutcomeInput {
  return {
    runId,
    stage: 'rebuild_projections',
    mode: 'apply',
    mappingVersion: MAPPING_VERSION,
    subjectKind: 'canonical_product',
    subjectKey,
    outcome: reasonCode === 'projection_current' ? 'unchanged' : 'created',
    reasonCode,
    detail,
  };
}

async function rowsFor(keys: readonly string[]) {
  const rows = await db
    .select({
      subjectKey: catalogBackfillRecords.subjectKey,
      reasonCode: catalogBackfillRecords.reasonCode,
      outcome: catalogBackfillRecords.outcome,
      detail: catalogBackfillRecords.detail,
      attempts: catalogBackfillRecords.attempts,
      runId: catalogBackfillRecords.runId,
    })
    .from(catalogBackfillRecords)
    .where(inArray(catalogBackfillRecords.subjectKey, [...keys]));
  return new Map(rows.map((row) => [row.subjectKey, row]));
}

beforeAll(async () => {
  db = await connectPostgres();
  const { run } = await openBackfillRun({
    stage: 'rebuild_projections',
    mode: 'apply',
    mappingVersion: MAPPING_VERSION,
    cohortKind: 'store',
    cohortValue: uuidv7(),
    requestedByOxyUserId: 'system:backfill-record-batch-test',
  });
  runId = run.id;
}, 120_000);

afterAll(async () => {
  if (runId !== undefined) {
    await db.delete(catalogBackfillRecords).where(inArray(catalogBackfillRecords.runId, [runId]));
    await db.delete(catalogBackfillRuns).where(inArray(catalogBackfillRuns.id, [runId]));
  }
  await closePostgres();
});

describe('recordBackfillOutcomes', () => {
  it('writes each subject its own verdict, in one statement', async () => {
    const keys = [uuidv7(), uuidv7(), uuidv7()].map((id) => `canonical_product:${id}`);
    subjectKeys.push(...keys);
    await recordBackfillOutcomes([
      verdict(keys[0] ?? '', 'projection_current', 'variant_count 1'),
      verdict(keys[1] ?? '', 'projection_refreshed', 'variant_count 1 → 2'),
      verdict(keys[2] ?? '', 'projection_current', 'variant_count 3'),
    ]);

    const rows = await rowsFor(keys);
    expect(rows.size).toBe(3);
    expect(rows.get(keys[0] ?? '')).toMatchObject({
      reasonCode: 'projection_current',
      outcome: 'unchanged',
      detail: 'variant_count 1',
      attempts: 1,
    });
    expect(rows.get(keys[1] ?? '')).toMatchObject({
      reasonCode: 'projection_refreshed',
      outcome: 'created',
      detail: 'variant_count 1 → 2',
      attempts: 1,
    });
    expect(rows.get(keys[2] ?? '')).toMatchObject({ detail: 'variant_count 3', attempts: 1 });
  });

  it('on a re-run, overwrites each verdict with its own new one and counts one more examination', async () => {
    const keys = [uuidv7(), uuidv7()].map((id) => `canonical_product:${id}`);
    await recordBackfillOutcomes([
      verdict(keys[0] ?? '', 'projection_current', 'a1'),
      verdict(keys[1] ?? '', 'projection_current', 'b1'),
    ]);
    await recordBackfillOutcomes([
      verdict(keys[0] ?? '', 'projection_refreshed', 'a2'),
      verdict(keys[1] ?? '', 'projection_current', 'b2'),
    ]);

    const rows = await rowsFor(keys);
    expect(rows.get(keys[0] ?? '')).toMatchObject({
      reasonCode: 'projection_refreshed',
      outcome: 'created',
      detail: 'a2',
      attempts: 2,
    });
    expect(rows.get(keys[1] ?? '')).toMatchObject({
      reasonCode: 'projection_current',
      detail: 'b2',
      attempts: 2,
    });
  });

  it('collapses a subject named twice in one batch to its LAST verdict, counting both examinations', async () => {
    const key = `canonical_product:${uuidv7()}`;
    await recordBackfillOutcome(verdict(key, 'projection_current', 'first page'));
    await recordBackfillOutcomes([
      verdict(key, 'projection_current', 'earlier in the page'),
      verdict(key, 'projection_refreshed', 'later in the page'),
    ]);

    const row = (await rowsFor([key])).get(key);
    expect(row).toMatchObject({
      reasonCode: 'projection_refreshed',
      detail: 'later in the page',
      attempts: 3,
      runId,
    });
  });

  it('writes nothing for an empty page', async () => {
    await expect(recordBackfillOutcomes([])).resolves.toBeUndefined();
  });
});
