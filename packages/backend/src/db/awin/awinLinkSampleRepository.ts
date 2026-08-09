/**
 * `awin_link_samples` — the destination and tracking check taken before an
 * advertiser may be activated (#66 quality control 4).
 *
 * APPEND-ONLY (a trigger refuses UPDATE and DELETE), so there is no update
 * function and no delete: a sample that can be edited after the activation it
 * authorised is not evidence, and the edit would be invisible beside an
 * advertiser that has been live for a month. A re-sample is a NEW row.
 */

import { desc, eq } from 'drizzle-orm';
import type { AwinSampleFinding, AwinSampleVerdict } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { AWIN_MAX_TEXT_LENGTH, awinLinkSamples } from '../schema/awin.js';

export type AwinLinkSampleRow = typeof awinLinkSamples.$inferSelect;

export interface RecordAwinLinkSampleInput {
  advertiserRowId: string;
  feedRowId: string;
  verdict: AwinSampleVerdict;
  sampled: number;
  passedRows: number;
  findings: readonly AwinSampleFinding[];
  takenByOxyUserId: string;
  note?: string;
  takenAt?: Date;
}

/** Append one sample. */
export async function recordAwinLinkSample(
  input: RecordAwinLinkSampleInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinLinkSampleRow> {
  const [row] = await db
    .insert(awinLinkSamples)
    .values({
      advertiserRowId: input.advertiserRowId,
      feedRowId: input.feedRowId,
      verdict: input.verdict,
      sampled: input.sampled,
      passedRows: input.passedRows,
      // De-duplicated: the findings are a SET of what went wrong, and six
      // hundred rows failing the same way is one finding, not six hundred.
      findings: [...new Set(input.findings)],
      takenByOxyUserId: input.takenByOxyUserId,
      takenAt: input.takenAt ?? new Date(),
      note: input.note === undefined ? null : input.note.slice(0, AWIN_MAX_TEXT_LENGTH),
    })
    .returning();
  if (row === undefined) throw new Error('awin_link_samples insert returned no row');
  return row;
}

export async function findAwinLinkSample(
  sampleId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinLinkSampleRow | null> {
  const [row] = await db
    .select()
    .from(awinLinkSamples)
    .where(eq(awinLinkSamples.id, sampleId))
    .limit(1);
  return row ?? null;
}

/** One advertiser's samples, newest first. */
export async function listAwinLinkSamples(
  input: { advertiserRowId: string; limit?: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinLinkSampleRow[]> {
  return db
    .select()
    .from(awinLinkSamples)
    .where(eq(awinLinkSamples.advertiserRowId, input.advertiserRowId))
    .orderBy(desc(awinLinkSamples.takenAt))
    .limit(Math.min(Math.max(input.limit ?? 20, 1), 100));
}
