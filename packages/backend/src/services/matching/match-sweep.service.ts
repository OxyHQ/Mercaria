/**
 * The bounded, resumable bulk enqueuers (#58 operations 1 and 3).
 *
 * Re-evaluating a catalogue after a policy change is the operation that makes
 * "policy versions are recorded so outcomes can be compared" useful rather than
 * merely true: without it, a new policy applies only to whatever happens to be
 * written next, and the comparison is between one policy's whole catalogue and
 * another's random sample.
 *
 * ## A sweep ENQUEUES and never matches
 *
 * The queue's dispatcher is the only thing that runs the pipeline. So a bulk
 * re-evaluation and a single catalogue write take exactly the same code path,
 * there is no second matching implementation to keep in step with the first, and
 * a sweep inherits the queue's coalescing for free — enqueueing a variant that
 * is already pending bumps a revision instead of adding work.
 *
 * ## Bounded and resumable, the `reconciliation` shape
 *
 * One page per run, keyset-paginated on the primary key, cursor made durable
 * BEFORE the lease is released. A crash mid-pass resumes where it stopped; a
 * short page ends the pass. The lease means a second ECS task finds the row
 * locked and returns "somebody else is sweeping" rather than double-enqueueing a
 * million rows.
 */

import { randomUUID } from 'node:crypto';
import { asc, gt, isNotNull, and, eq } from 'drizzle-orm';
import type { MatchSweepJob } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { productVariants } from '../../db/schema/catalog.js';
import { sourceRecords } from '../../db/schema/provenance.js';
import { enqueueMatch } from '../../db/matching/matchQueueRepository.js';
import { findActiveMatchPolicyVersion } from '../../db/matching/matchPolicyRepository.js';
import {
  advanceSweepCursor,
  claimSweepRun,
  releaseSweepRun,
  MATCH_SWEEP_LEASE_MS,
} from '../../db/matching/matchSweepRepository.js';
import { matchSubjectKey } from './subject.js';

/** What one page did. */
export interface SweepPageResult {
  readonly job: MatchSweepJob;
  readonly scanned: number;
  readonly enqueued: number;
  /** `null` when the pass is complete. */
  readonly nextCursor: string | null;
}

/**
 * Enqueue one page of native variants.
 *
 * Keyset on `product_variants.id`, which is a uuid v7 and therefore k-sortable,
 * so the page boundary is a single indexed comparison rather than an OFFSET that
 * gets slower every page.
 */
async function sweepNativeVariantsPage(input: {
  cursor: string | null;
  limit: number;
}): Promise<{ scanned: number; enqueued: number; nextCursor: string | null }> {
  const db = getDb();
  const rows = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(input.cursor === null ? undefined : gt(productVariants.id, input.cursor))
    .orderBy(asc(productVariants.id))
    .limit(input.limit);

  for (const row of rows) {
    await enqueueMatch(
      {
        subjectKind: 'native_variant',
        subjectKey: matchSubjectKey({ kind: 'native_variant', productVariantId: row.id }),
        sourceRecordId: null,
        productVariantId: row.id,
        trigger: 'bulk_sweep',
      },
      db,
    );
  }

  return {
    scanned: rows.length,
    enqueued: rows.length,
    // A SHORT page ends the pass. Comparing against the limit rather than
    // looking for an empty page saves one whole round trip per pass and, more
    // importantly, cannot loop forever on a page that is exactly empty.
    nextCursor: rows.length < input.limit ? null : (rows[rows.length - 1]?.id ?? null),
  };
}

/**
 * Enqueue one page of stored source observations.
 *
 * Only records with a STORED payload: `catalog_sources.may_store` is a right,
 * and a record Mercaria may read but not keep has a NULL payload and nothing to
 * match (ADR 0002 D19). Enqueueing it would produce a job that can only ever
 * answer `subject_gone`.
 */
async function sweepSourceRecordsPage(input: {
  cursor: string | null;
  limit: number;
}): Promise<{ scanned: number; enqueued: number; nextCursor: string | null }> {
  const db = getDb();
  const predicate =
    input.cursor === null
      ? and(eq(sourceRecords.externalType, 'product'), isNotNull(sourceRecords.payload))
      : and(
          eq(sourceRecords.externalType, 'product'),
          isNotNull(sourceRecords.payload),
          gt(sourceRecords.id, input.cursor),
        );

  const rows = await db
    .select({
      id: sourceRecords.id,
      sourceId: sourceRecords.sourceId,
      externalType: sourceRecords.externalType,
      externalId: sourceRecords.externalId,
    })
    .from(sourceRecords)
    .where(predicate)
    .orderBy(asc(sourceRecords.id))
    .limit(input.limit);

  for (const row of rows) {
    await enqueueMatch(
      {
        subjectKind: 'source_record',
        subjectKey: matchSubjectKey({
          kind: 'source_record',
          sourceId: row.sourceId,
          externalType: row.externalType,
          externalId: row.externalId,
        }),
        sourceRecordId: row.id,
        productVariantId: null,
        trigger: 'bulk_sweep',
      },
      db,
    );
  }

  return {
    scanned: rows.length,
    enqueued: rows.length,
    nextCursor: rows.length < input.limit ? null : (rows[rows.length - 1]?.id ?? null),
  };
}

/**
 * Run ONE page of one sweep.
 *
 * @returns `undefined` when another task holds the lease — not an error, and
 *   deliberately distinguishable from a completed pass, because "somebody else
 *   is sweeping" and "there was nothing left" are different operational facts.
 */
export async function runMatchSweepPage(
  job: MatchSweepJob,
  options: { limit?: number } = {},
): Promise<SweepPageResult | undefined> {
  const db = getDb();
  const policy = await findActiveMatchPolicyVersion(db);
  if (!policy) return undefined;

  const limit = options.limit ?? config.matching.sweepBatchSize;
  const leaseOwner = `match-sweep:${String(process.pid)}:${randomUUID()}`;
  const cursor = await claimSweepRun(db, {
    job,
    leaseOwner,
    leaseMs: MATCH_SWEEP_LEASE_MS,
  });
  if (!cursor) return undefined;

  try {
    const page =
      job === 'native_variants'
        ? await sweepNativeVariantsPage({ cursor: cursor.cursor, limit })
        : await sweepSourceRecordsPage({ cursor: cursor.cursor, limit });

    if (page.nextCursor === null) {
      await releaseSweepRun(db, { job, leaseOwner, completed: true });
    } else {
      // The cursor is durable BEFORE the lease goes back, so a crash between the
      // two resumes at the next page rather than repeating this one.
      await advanceSweepCursor(db, {
        job,
        leaseOwner,
        cursor: page.nextCursor,
        enqueued: cursor.enqueuedInPass + page.enqueued,
        policyVersionId: policy.id,
      });
      await releaseSweepRun(db, { job, leaseOwner, completed: false });
    }

    log.general.info({ job, ...page }, '[Matching] sweep page complete');
    return { job, ...page };
  } catch (err) {
    // The cursor is NOT moved, which is what makes the failure resumable.
    await releaseSweepRun(db, {
      job,
      leaseOwner,
      completed: false,
      error: err instanceof Error ? err.message : String(err),
    });
    log.general.error({ err, job }, '[Matching] sweep page failed');
    throw err;
  }
}
