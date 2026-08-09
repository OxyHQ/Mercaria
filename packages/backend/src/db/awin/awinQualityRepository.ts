/**
 * `awin_advertiser_quality` — what one import MEASURED about one advertiser's
 * data (#66 quality control 1 and 2).
 *
 * APPEND-ONLY (a trigger refuses UPDATE and DELETE), so there is no update
 * function here and no delete. A quality history whose rows can be edited
 * answers "was this feed always like this" with whatever somebody most recently
 * believed, and the question is usually asked during an argument about whether a
 * regression is new.
 *
 * The counters' vacuity floor is `scanned = mapped + rejected` and it is a
 * CHECK, not a convention (#60's device) — so this repository does not
 * re-validate it. Re-validating a constraint in application code is how the two
 * spellings drift, and the loser is whichever the writer does not read.
 */

import { desc, eq } from 'drizzle-orm';
import type { AwinQualityCounts } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { awinAdvertiserQuality } from '../schema/awin.js';

export type AwinQualityRow = typeof awinAdvertiserQuality.$inferSelect;

export interface RecordAwinQualityInput {
  advertiserRowId: string;
  feedRowId: string;
  runId: string | null;
  mappingVersion: number;
  counts: AwinQualityCounts;
  measuredAt?: Date;
}

/** Append one measurement. */
export async function recordAwinQuality(
  input: RecordAwinQualityInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinQualityRow> {
  const [row] = await db
    .insert(awinAdvertiserQuality)
    .values({
      advertiserRowId: input.advertiserRowId,
      feedRowId: input.feedRowId,
      runId: input.runId,
      mappingVersion: input.mappingVersion,
      measuredAt: input.measuredAt ?? new Date(),
      ...input.counts,
    })
    .returning();
  if (row === undefined) throw new Error('awin_advertiser_quality insert returned no row');
  return row;
}

/** One advertiser's measurement history, newest first. */
export async function listAwinQuality(
  input: { advertiserRowId: string; limit?: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinQualityRow[]> {
  return db
    .select()
    .from(awinAdvertiserQuality)
    .where(eq(awinAdvertiserQuality.advertiserRowId, input.advertiserRowId))
    .orderBy(desc(awinAdvertiserQuality.measuredAt))
    .limit(Math.min(Math.max(input.limit ?? 20, 1), 100));
}
