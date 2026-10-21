/**
 * Reads and writes for `feed_validation_jobs` — the whole-feed validation
 * outbox (`services/feed-import/validation-dispatcher.ts`).
 *
 * The lease shape every dispatcher in this codebase shares: a claim is
 * `FOR UPDATE SKIP LOCKED` over the due rows, takes a lease with an owner, and
 * every later write on a claimed job carries the owner check — so a worker whose
 * lease expired and was reclaimed cannot complete, fail or release a job it no
 * longer holds.
 */

import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import type { FeedRefusalReason, FeedValidationJobStatus } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import { FEED_IMPORT_MAX_TEXT_LENGTH, feedValidationJobs } from '../schema/feedImport.js';

export type FeedValidationJobRow = typeof feedValidationJobs.$inferSelect;

/**
 * Enqueue a validation of one version, or answer the one already open.
 *
 * `ON CONFLICT DO NOTHING RETURNING` against `feed_validation_jobs_open_version_key`
 * with its predicate repeated; the empty result set is "already queued", and the
 * open job is read back. A second request while the first is running therefore
 * polls the same job instead of reading the whole feed twice.
 */
export async function enqueueFeedValidationJob(
  db: DatabaseOrTransaction,
  input: {
    configurationId: string;
    versionId: string;
    requestedByOxyUserId: string;
    now: Date;
  },
): Promise<FeedValidationJobRow> {
  const [inserted] = await db
    .insert(feedValidationJobs)
    .values({
      configurationId: input.configurationId,
      versionId: input.versionId,
      status: 'pending',
      availableAt: input.now,
      requestedByOxyUserId: input.requestedByOxyUserId,
      expiresAt: new Date(input.now.getTime() + RETENTION_SECONDS.feedValidationJob * 1_000),
    })
    .onConflictDoNothing({
      target: feedValidationJobs.versionId,
      where: sql`${feedValidationJobs.status} in ('pending', 'processing')`,
    })
    .returning();
  if (inserted) return inserted;
  const [open] = await db
    .select()
    .from(feedValidationJobs)
    .where(
      and(
        eq(feedValidationJobs.versionId, input.versionId),
        sql`${feedValidationJobs.status} in ('pending', 'processing')`,
      ),
    )
    .limit(1);
  // The open job finished between the insert and this read: enqueue afresh.
  if (!open) return enqueueFeedValidationJob(db, input);
  return open;
}

export async function findFeedValidationJob(
  db: DatabaseOrTransaction,
  jobId: string,
): Promise<FeedValidationJobRow | undefined> {
  const [row] = await db
    .select()
    .from(feedValidationJobs)
    .where(eq(feedValidationJobs.id, jobId))
    .limit(1);
  return row;
}

/** Claim due jobs: pending and available, or processing with an expired lease. */
export async function claimFeedValidationJobs(
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly FeedValidationJobRow[]> {
  const now = options.now ?? new Date();
  const due = or(
    and(eq(feedValidationJobs.status, 'pending'), lte(feedValidationJobs.availableAt, now)),
    and(eq(feedValidationJobs.status, 'processing'), lte(feedValidationJobs.leaseUntil, now)),
  );
  return db
    .update(feedValidationJobs)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + options.leaseMs),
      attempts: sql`${feedValidationJobs.attempts} + 1`,
    })
    .where(
      sql`${feedValidationJobs.id} in (
        select ${feedValidationJobs.id} from ${feedValidationJobs}
        where ${due}
        order by ${asc(feedValidationJobs.availableAt)}
        limit ${Math.max(1, options.batchSize)}
        for update skip locked
      )`,
    )
    .returning();
}

/** The owner check every write on a claimed job shares. */
function ownedLease(jobId: string, leaseOwner: string, now: Date) {
  return and(
    eq(feedValidationJobs.id, jobId),
    eq(feedValidationJobs.status, 'processing' satisfies FeedValidationJobStatus),
    eq(feedValidationJobs.leaseOwner, leaseOwner),
    gt(feedValidationJobs.leaseUntil, now),
  );
}

/** Extend a held lease. `false` means it is no longer held: stop working on it. */
export async function renewFeedValidationLease(
  options: { jobId: string; leaseOwner: string; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(feedValidationJobs)
    .set({ leaseUntil: new Date(now.getTime() + options.leaseMs) })
    .where(ownedLease(options.jobId, options.leaseOwner, now))
    .returning({ id: feedValidationJobs.id });
  return rows.length === 1;
}

export async function completeFeedValidationJob(
  options: { jobId: string; leaseOwner: string; reportId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(feedValidationJobs)
    .set({
      status: 'completed',
      reportId: options.reportId,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(options.jobId, options.leaseOwner, now))
    .returning({ id: feedValidationJobs.id });
  return rows.length === 1;
}

/** A refusal that will answer the same way again: terminal, with its reason. */
export async function failFeedValidationJob(
  options: {
    jobId: string;
    leaseOwner: string;
    reason: FeedRefusalReason;
    message: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(feedValidationJobs)
    .set({
      status: 'failed',
      failureReason: options.reason,
      lastError: options.message.slice(0, FEED_IMPORT_MAX_TEXT_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.jobId, options.leaseOwner, now))
    .returning({ id: feedValidationJobs.id });
  return rows.length === 1;
}

/** A retryable failure: back to `pending` after a backoff, or `dead_letter`. */
export async function releaseFeedValidationJob(
  options: {
    jobId: string;
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(feedValidationJobs)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, FEED_IMPORT_MAX_TEXT_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.jobId, options.leaseOwner, now))
    .returning({ id: feedValidationJobs.id });
  return rows.length === 1;
}
