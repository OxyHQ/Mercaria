/**
 * The merge and split JOB tables — creation, leasing, phase progress and
 * conflict/assignment children (#59 merge invariant 7, split invariant 5).
 *
 * The lease shape is the moderation and payment outbox's, unchanged: claim with
 * `FOR UPDATE SKIP LOCKED` inside a subquery so N dispatchers on N ECS tasks
 * drain one queue without handing each other the same row, an OWNER check on
 * every terminal transition so a worker whose lease expired discards its own
 * outcome instead of writing over somebody else's run, and capped exponential
 * backoff with a visible `dead_letter`.
 *
 * What is NOT the outbox's shape, and deliberately: a curation job is one row
 * per ACT rather than a convergence row per subject. Two merges of one entity
 * are two different decisions, not one fixed point to re-derive — which is why
 * the uniqueness here is a partial index over the OPEN statuses rather than a
 * plain `UNIQUE(subject)`, and why the enqueue is a plain insert that FAILS on
 * conflict rather than an `ON CONFLICT DO UPDATE`.
 */

import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  CatalogJobStatus,
  CatalogMergeConflictKind,
  CatalogMergeConflictResolution,
  CatalogMergePhase,
  CatalogSplitItemType,
  CatalogSplitPhase,
  CatalogSplitTargetMode,
  MergeableEntityType,
  SplittableEntityType,
} from '@mercaria/shared-types';
import {
  catalogMergeConflicts,
  catalogMergeJobPhases,
  catalogMergeJobs,
  catalogSplitAssignments,
  catalogSplitJobs,
  CURATION_MAX_TEXT_LENGTH,
  type CatalogMergeConflictRow,
  type CatalogMergeJobPhaseRow,
  type CatalogMergeJobRow,
  type CatalogSplitAssignmentRow,
  type CatalogSplitJobRow,
} from '../schema/curation.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** The statuses a job occupies while it still owes work. */
const OPEN_STATUSES: readonly CatalogJobStatus[] = ['pending', 'processing', 'blocked'];

/** The impact columns, as a plain record the two job tables share. */
export interface JobImpactColumns {
  readonly impactSourceLinks: number;
  readonly impactIdentifiers: number;
  readonly impactAliases: number;
  readonly impactOffers: number;
  readonly impactNativeListingLinks: number;
  readonly impactRelationships: number;
  readonly impactReviews: number;
  readonly impactChildEntities: number;
  readonly impactAttributeValues: number;
  readonly impactImages: number;
  readonly impactUntouchedOrderItems: number;
  readonly impactTotalMoving: number;
}

// ── Merge jobs ─────────────────────────────────────────────────────────────

export interface CreateMergeJobInput {
  readonly entityType: MergeableEntityType;
  readonly loserId: string;
  readonly winnerId: string;
  readonly reason: string;
  readonly requestedByOxyUserId: string;
  readonly requiresSecondApproval: boolean;
  readonly parentJobId?: string | null;
  readonly reviewItemId?: string | null;
  readonly impact: JobImpactColumns;
}

export async function insertMergeJob(
  input: CreateMergeJobInput,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogMergeJobRow> {
  const rows = await db
    .insert(catalogMergeJobs)
    .values({
      entityType: input.entityType,
      loserId: input.loserId,
      winnerId: input.winnerId,
      reason: input.reason,
      requestedByOxyUserId: input.requestedByOxyUserId,
      requiresSecondApproval: input.requiresSecondApproval,
      parentJobId: input.parentJobId ?? null,
      reviewItemId: input.reviewItemId ?? null,
      availableAt: now,
      ...input.impact,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('catalog_merge_jobs insert returned no row');
  return row;
}

export async function findMergeJobById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogMergeJobRow | undefined> {
  const rows = await db.select().from(catalogMergeJobs).where(eq(catalogMergeJobs.id, id)).limit(1);
  return rows[0];
}

/** Every open job of one entity — what the "already merging" refusal reads. */
export async function findOpenMergeJobFor(
  entityType: MergeableEntityType,
  loserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogMergeJobRow | undefined> {
  const rows = await db
    .select()
    .from(catalogMergeJobs)
    .where(
      and(
        eq(catalogMergeJobs.entityType, entityType),
        eq(catalogMergeJobs.loserId, loserId),
        inArray(catalogMergeJobs.status, [...OPEN_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function listMergeJobs(
  filter: { readonly status?: CatalogJobStatus; readonly limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogMergeJobRow[]> {
  const predicate = filter.status
    ? eq(catalogMergeJobs.status, filter.status)
    : inArray(catalogMergeJobs.status, [...OPEN_STATUSES]);
  return db
    .select()
    .from(catalogMergeJobs)
    .where(predicate)
    .orderBy(asc(catalogMergeJobs.createdAt))
    .limit(filter.limit);
}

/**
 * Record the SECOND operator's approval (#59 security 4).
 *
 * The CAS refuses an approval on a job that already has one, and the schema's
 * `approved_by <> requested_by` CHECK refuses the requester's own — so four eyes
 * is two independent mechanisms rather than one comparison in a handler.
 */
export async function approveMergeJob(
  id: string,
  approverOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogMergeJobRow | undefined> {
  const rows = await db
    .update(catalogMergeJobs)
    .set({ approvedByOxyUserId: approverOxyUserId, approvedAt: now })
    .where(and(eq(catalogMergeJobs.id, id), isNull(catalogMergeJobs.approvedByOxyUserId)))
    .returning();
  return rows[0];
}

export interface ClaimJobOptions {
  readonly leaseOwner: string;
  readonly batchSize: number;
  readonly leaseMs?: number;
  readonly now?: Date;
}

/**
 * Claim a bounded batch of merge jobs.
 *
 * `blocked` is NOT claimable, which is the whole reason it is a separate status
 * from `failed`: a job waiting on an operator's conflict decision must not be
 * retried, or the dispatcher spins against a judgement only a person can make.
 */
export async function claimMergeJobs(
  options: ClaimJobOptions,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogMergeJobRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
  const batchSize = Math.max(1, options.batchSize);
  const due = or(
    and(eq(catalogMergeJobs.status, 'pending'), lte(catalogMergeJobs.availableAt, now)),
    and(eq(catalogMergeJobs.status, 'processing'), lte(catalogMergeJobs.leaseUntil, now)),
  );
  return db
    .update(catalogMergeJobs)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${catalogMergeJobs.attempts} + 1`,
      /**
       * The ISO STRING with an explicit cast, never the `Date`.
       *
       * CONVENTIONS.md §"A `Date` is not a safe parameter against an EXPRESSION":
       * postgres.js infers a parameter's wire type from ordinary positional
       * binding, and a `Date` sitting inside a `coalesce(...)` is outside that
       * inference — it throws in the DRIVER, before the server sees the
       * statement, with an `ERR_INVALID_ARG_TYPE` whose text points nowhere
       * near the cause. Caught by the realdb suite; a mocked repository accepts
       * it happily.
       */
      startedAt: sql`coalesce(${catalogMergeJobs.startedAt}, ${now.toISOString()}::timestamptz)`,
      lastError: null,
    })
    .where(
      sql`${catalogMergeJobs.id} in (
        select ${catalogMergeJobs.id} from ${catalogMergeJobs}
        where ${due}
        order by ${asc(catalogMergeJobs.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/** The owner check every terminal merge transition shares. */
function ownedMergeLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(catalogMergeJobs.id, id),
    eq(catalogMergeJobs.status, 'processing'),
    eq(catalogMergeJobs.leaseOwner, leaseOwner),
    gt(catalogMergeJobs.leaseUntil, now),
  );
}

/** Move a claimed job to its next phase, keeping the lease. */
export async function advanceMergePhase(
  id: string,
  leaseOwner: string,
  phase: CatalogMergePhase,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogMergeJobs)
    .set({ phase })
    .where(ownedMergeLease(id, leaseOwner, now))
    .returning({ id: catalogMergeJobs.id });
  return rows.length === 1;
}

/** Finish a job. The phase and the status agree, by CHECK. */
export async function completeMergeJob(
  id: string,
  leaseOwner: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogMergeJobs)
    .set({
      status: 'completed',
      phase: 'done',
      completedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedMergeLease(id, leaseOwner, now))
    .returning({ id: catalogMergeJobs.id });
  return rows.length === 1;
}

/** Park a job on an operator decision. Not an error, and not retried. */
export async function blockMergeJob(
  id: string,
  leaseOwner: string,
  note: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogMergeJobs)
    .set({
      status: 'blocked',
      leaseOwner: null,
      leaseUntil: null,
      lastError: note.slice(0, CURATION_MAX_TEXT_LENGTH),
    })
    .where(ownedMergeLease(id, leaseOwner, now))
    .returning({ id: catalogMergeJobs.id });
  return rows.length === 1;
}

/** Give a lease back after a failure. `deadLettered` is the CALLER's decision. */
export async function releaseMergeJob(
  options: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly deadLettered: boolean;
    readonly availableAt: Date;
    readonly error: string;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(catalogMergeJobs)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, CURATION_MAX_TEXT_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedMergeLease(options.id, options.leaseOwner, now))
    .returning({ id: catalogMergeJobs.id });
  return rows.length === 1;
}

/**
 * Un-block a job whose blocking condition has cleared.
 *
 * The CAS on `status = 'blocked'` is what makes this safe to call from N tasks
 * at once: the second caller matches no row and reports `false`, which is the
 * "somebody already did it" answer rather than an error. It is deliberately NOT
 * an owner-checked transition like the terminal ones — a blocked job holds no
 * lease, so there is no owner to check.
 *
 * Callers must decide with {@link mergeJobBlockingState} and nothing else. This
 * function asks no questions, so a caller inventing its own answer is how a job
 * whose precondition is unmet gets resumed.
 */
export async function unblockMergeJob(
  id: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogMergeJobs)
    .set({ status: 'pending', availableAt: now, lastError: null })
    .where(and(eq(catalogMergeJobs.id, id), eq(catalogMergeJobs.status, 'blocked')))
    .returning({ id: catalogMergeJobs.id });
  return rows.length === 1;
}

/**
 * A bounded page of jobs parked on a condition, oldest first.
 *
 * The read the resume sweep evaluates, and the operator inbox's own order —
 * `catalog_merge_jobs_blocked_idx` is `(created_at) WHERE status = 'blocked'`,
 * so this is an index-only walk of the parked set rather than a scan of the
 * table. It reads and never writes: what a job is waiting on is a question for
 * the service that owns the phase, not for this repository.
 */
export async function listBlockedMergeJobs(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogMergeJobRow[]> {
  return db
    .select()
    .from(catalogMergeJobs)
    .where(eq(catalogMergeJobs.status, 'blocked'))
    .orderBy(asc(catalogMergeJobs.createdAt))
    .limit(Math.max(1, limit));
}

// ── Phase records ──────────────────────────────────────────────────────────

/**
 * Claim a phase, or report that it already ran.
 *
 * `ON CONFLICT DO NOTHING` on `(job_id, phase)` plus a read: the empty
 * `RETURNING` set IS the "already claimed" answer, the moderation-event device.
 * A phase whose row exists AND is complete is skipped; one that exists and is
 * incomplete is re-run, because a crash between claiming and completing left
 * work half done.
 */
export async function claimMergePhase(
  jobId: string,
  phase: CatalogMergePhase,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<{ readonly alreadyComplete: boolean; readonly row: CatalogMergeJobPhaseRow }> {
  await db
    .insert(catalogMergeJobPhases)
    .values({ jobId, phase, startedAt: now })
    .onConflictDoNothing();
  const rows = await db
    .select()
    .from(catalogMergeJobPhases)
    .where(and(eq(catalogMergeJobPhases.jobId, jobId), eq(catalogMergeJobPhases.phase, phase)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`phase ${phase} of job ${jobId} could neither be claimed nor read`);
  return { alreadyComplete: row.completedAt !== null, row };
}

/** Stamp a phase complete. The trigger refuses a second stamp. */
export async function completeMergePhase(
  jobId: string,
  phase: CatalogMergePhase,
  rowsAffected: number,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(catalogMergeJobPhases)
    .set({ completedAt: now, rowsAffected })
    .where(
      and(
        eq(catalogMergeJobPhases.jobId, jobId),
        eq(catalogMergeJobPhases.phase, phase),
        isNull(catalogMergeJobPhases.completedAt),
      ),
    );
}

export async function listMergePhases(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogMergeJobPhaseRow[]> {
  return db
    .select()
    .from(catalogMergeJobPhases)
    .where(eq(catalogMergeJobPhases.jobId, jobId))
    .orderBy(asc(catalogMergeJobPhases.startedAt));
}

// ── Conflicts ──────────────────────────────────────────────────────────────

export interface InsertConflictInput {
  readonly jobId: string;
  readonly kind: CatalogMergeConflictKind;
  readonly detail: string;
  readonly loserIdentifierId?: string | null;
  readonly winnerIdentifierId?: string | null;
  readonly loserVariantId?: string | null;
  readonly winnerVariantId?: string | null;
  readonly loserRelationshipId?: string | null;
  readonly winnerRelationshipId?: string | null;
  readonly loserOfferId?: string | null;
  readonly winnerOfferId?: string | null;
  readonly loserClaimId?: string | null;
  readonly winnerClaimId?: string | null;
  /** The ONE row a collapse names; there is no winner twin (#405). */
  readonly collapsingRelationId?: string | null;
  readonly collapsingProductRedirectId?: string | null;
  readonly collapsingFamilyRedirectId?: string | null;
  /** A bundle collapse names its row by the pair, which outlives it (#405). */
  readonly collapsingBundleVariantId?: string | null;
  readonly collapsingComponentVariantId?: string | null;
}

/**
 * Record one detected conflict, idempotently.
 *
 * `ON CONFLICT DO NOTHING` on `(job_id, kind, conflict_key)`, so re-planning a
 * job — which happens on every resume of the `plan` phase — never duplicates a
 * conflict and, crucially, never overwrites one an operator has already decided.
 */
export async function insertConflict(
  input: InsertConflictInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(catalogMergeConflicts)
    .values({
      jobId: input.jobId,
      kind: input.kind,
      detail: input.detail.slice(0, CURATION_MAX_TEXT_LENGTH),
      loserIdentifierId: input.loserIdentifierId ?? null,
      winnerIdentifierId: input.winnerIdentifierId ?? null,
      loserVariantId: input.loserVariantId ?? null,
      winnerVariantId: input.winnerVariantId ?? null,
      loserRelationshipId: input.loserRelationshipId ?? null,
      winnerRelationshipId: input.winnerRelationshipId ?? null,
      loserOfferId: input.loserOfferId ?? null,
      winnerOfferId: input.winnerOfferId ?? null,
      loserClaimId: input.loserClaimId ?? null,
      winnerClaimId: input.winnerClaimId ?? null,
      collapsingRelationId: input.collapsingRelationId ?? null,
      collapsingProductRedirectId: input.collapsingProductRedirectId ?? null,
      collapsingFamilyRedirectId: input.collapsingFamilyRedirectId ?? null,
      collapsingBundleVariantId: input.collapsingBundleVariantId ?? null,
      collapsingComponentVariantId: input.collapsingComponentVariantId ?? null,
    })
    .onConflictDoNothing();
}

export async function listConflicts(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogMergeConflictRow[]> {
  return db
    .select()
    .from(catalogMergeConflicts)
    .where(eq(catalogMergeConflicts.jobId, jobId))
    .orderBy(asc(catalogMergeConflicts.createdAt));
}

export async function findConflictById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogMergeConflictRow | undefined> {
  const rows = await db
    .select()
    .from(catalogMergeConflicts)
    .where(eq(catalogMergeConflicts.id, id))
    .limit(1);
  return rows[0];
}

/**
 * How many of a job's conflicts are still undecided.
 *
 * THE gate of #59 merge invariant 4. It is a cross-table count, which is why it
 * is a service-side check rather than a CHECK — a CHECK may not contain a
 * subquery — and why the realdb suite pins it directly.
 */
export async function countUnresolvedConflicts(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(catalogMergeConflicts)
    .where(and(eq(catalogMergeConflicts.jobId, jobId), isNull(catalogMergeConflicts.resolution)));
  return Number(rows[0]?.pending ?? 0);
}

/** A job's conflicts that were decided but not yet applied to the graph. */
export async function listUnappliedConflicts(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogMergeConflictRow[]> {
  return db
    .select()
    .from(catalogMergeConflicts)
    .where(
      and(
        eq(catalogMergeConflicts.jobId, jobId),
        isNotNull(catalogMergeConflicts.resolution),
        isNull(catalogMergeConflicts.appliedAt),
      ),
    )
    .orderBy(asc(catalogMergeConflicts.createdAt));
}

/** Record an operator's decision. The CAS refuses a second one. */
export async function resolveConflict(
  input: {
    readonly id: string;
    readonly resolution: CatalogMergeConflictResolution;
    readonly resolvedByOxyUserId: string;
    readonly resolutionReason: string;
    readonly childJobId?: string | null;
  },
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogMergeConflictRow | undefined> {
  const rows = await db
    .update(catalogMergeConflicts)
    .set({
      resolution: input.resolution,
      resolvedByOxyUserId: input.resolvedByOxyUserId,
      resolutionReason: input.resolutionReason.slice(0, CURATION_MAX_TEXT_LENGTH),
      resolvedAt: now,
      childJobId: input.childJobId ?? null,
    })
    .where(and(eq(catalogMergeConflicts.id, input.id), isNull(catalogMergeConflicts.resolution)))
    .returning();
  return rows[0];
}

/** Stamp a decision as applied. The trigger then freezes it. */
export async function markConflictApplied(
  id: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(catalogMergeConflicts)
    .set({ appliedAt: now })
    .where(and(eq(catalogMergeConflicts.id, id), isNull(catalogMergeConflicts.appliedAt)));
}

// ── Split jobs ─────────────────────────────────────────────────────────────

export interface CreateSplitJobInput {
  readonly entityType: SplittableEntityType;
  readonly sourceEntityId: string;
  readonly targetMode: CatalogSplitTargetMode;
  readonly targetEntityId: string | null;
  readonly targetSlug: string | null;
  readonly targetName: string | null;
  readonly reason: string;
  readonly requestedByOxyUserId: string;
  readonly requiresSecondApproval: boolean;
  readonly reversesMergeJobId?: string | null;
  readonly reviewItemId?: string | null;
  readonly impact: JobImpactColumns;
}

export async function insertSplitJob(
  input: CreateSplitJobInput,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogSplitJobRow> {
  const rows = await db
    .insert(catalogSplitJobs)
    .values({
      entityType: input.entityType,
      sourceEntityId: input.sourceEntityId,
      targetMode: input.targetMode,
      targetEntityId: input.targetEntityId,
      targetSlug: input.targetSlug,
      targetName: input.targetName,
      reason: input.reason,
      requestedByOxyUserId: input.requestedByOxyUserId,
      requiresSecondApproval: input.requiresSecondApproval,
      reversesMergeJobId: input.reversesMergeJobId ?? null,
      reviewItemId: input.reviewItemId ?? null,
      availableAt: now,
      ...input.impact,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('catalog_split_jobs insert returned no row');
  return row;
}

export async function findSplitJobById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogSplitJobRow | undefined> {
  const rows = await db.select().from(catalogSplitJobs).where(eq(catalogSplitJobs.id, id)).limit(1);
  return rows[0];
}

export async function listSplitJobs(
  filter: { readonly status?: CatalogJobStatus; readonly limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogSplitJobRow[]> {
  const predicate = filter.status
    ? eq(catalogSplitJobs.status, filter.status)
    : inArray(catalogSplitJobs.status, [...OPEN_STATUSES]);
  return db
    .select()
    .from(catalogSplitJobs)
    .where(predicate)
    .orderBy(asc(catalogSplitJobs.createdAt))
    .limit(filter.limit);
}

export async function approveSplitJob(
  id: string,
  approverOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogSplitJobRow | undefined> {
  const rows = await db
    .update(catalogSplitJobs)
    .set({ approvedByOxyUserId: approverOxyUserId, approvedAt: now })
    .where(and(eq(catalogSplitJobs.id, id), isNull(catalogSplitJobs.approvedByOxyUserId)))
    .returning();
  return rows[0];
}

export async function claimSplitJobs(
  options: ClaimJobOptions,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogSplitJobRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
  const batchSize = Math.max(1, options.batchSize);
  const due = or(
    and(eq(catalogSplitJobs.status, 'pending'), lte(catalogSplitJobs.availableAt, now)),
    and(eq(catalogSplitJobs.status, 'processing'), lte(catalogSplitJobs.leaseUntil, now)),
  );
  return db
    .update(catalogSplitJobs)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${catalogSplitJobs.attempts} + 1`,
      /** The ISO string with an explicit cast — see `claimMergeJobs`. */
      startedAt: sql`coalesce(${catalogSplitJobs.startedAt}, ${now.toISOString()}::timestamptz)`,
      lastError: null,
    })
    .where(
      sql`${catalogSplitJobs.id} in (
        select ${catalogSplitJobs.id} from ${catalogSplitJobs}
        where ${due}
        order by ${asc(catalogSplitJobs.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

function ownedSplitLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(catalogSplitJobs.id, id),
    eq(catalogSplitJobs.status, 'processing'),
    eq(catalogSplitJobs.leaseOwner, leaseOwner),
    gt(catalogSplitJobs.leaseUntil, now),
  );
}

/**
 * Move a split to its next phase, optionally recording the destination the
 * `mint` phase created.
 *
 * The two are one statement because the schema forbids them being two: a job
 * past `mint` with a NULL `target_entity_id` is refused by
 * `catalog_split_jobs_destination_before_assignment_check`, which is what makes
 * "nothing is reassigned before the destination exists" structural.
 */
export async function advanceSplitPhase(
  id: string,
  leaseOwner: string,
  phase: CatalogSplitPhase,
  targetEntityId: string | null,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogSplitJobs)
    .set(targetEntityId === null ? { phase } : { phase, targetEntityId })
    .where(ownedSplitLease(id, leaseOwner, now))
    .returning({ id: catalogSplitJobs.id });
  return rows.length === 1;
}

export async function completeSplitJob(
  id: string,
  leaseOwner: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogSplitJobs)
    .set({
      status: 'completed',
      phase: 'done',
      completedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedSplitLease(id, leaseOwner, now))
    .returning({ id: catalogSplitJobs.id });
  return rows.length === 1;
}

/**
 * Park a split on a condition only a person can clear (#679).
 *
 * `blockMergeJob`'s counterpart, and it did not exist — which is the whole of
 * #679. Owner-checked like every other terminal transition of a claimed job:
 * the lease is given up here, because a parked job holds nothing and
 * `claimSplitJobs` must not reclaim it.
 *
 * Callers must decide with {@link splitJobBlockingState} and nothing else.
 */
export async function blockSplitJob(
  id: string,
  leaseOwner: string,
  note: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogSplitJobs)
    .set({
      status: 'blocked',
      leaseOwner: null,
      leaseUntil: null,
      lastError: note.slice(0, CURATION_MAX_TEXT_LENGTH),
    })
    .where(ownedSplitLease(id, leaseOwner, now))
    .returning({ id: catalogSplitJobs.id });
  return rows.length === 1;
}

/**
 * Un-block a split whose blocking condition has cleared.
 *
 * `unblockMergeJob`'s reasoning verbatim: the CAS on `status = 'blocked'` makes
 * this safe from N tasks at once — the second caller matches no row and reports
 * `false`, which is "somebody already did it" rather than an error — and it is
 * deliberately NOT owner-checked, because a blocked job holds no lease.
 *
 * It asks no questions, so a caller inventing its own answer is how a job whose
 * precondition is unmet gets resumed. Decide with {@link splitJobBlockingState}.
 */
export async function unblockSplitJob(
  id: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(catalogSplitJobs)
    .set({ status: 'pending', availableAt: now, lastError: null })
    .where(and(eq(catalogSplitJobs.id, id), eq(catalogSplitJobs.status, 'blocked')))
    .returning({ id: catalogSplitJobs.id });
  return rows.length === 1;
}

/**
 * A bounded page of parked splits, oldest first.
 *
 * `catalog_split_jobs_blocked_idx` is `(created_at) WHERE status = 'blocked'`,
 * so this is an index-only walk of the parked set — and until #679 that index
 * served no reader at all, because nothing could put a row in it.
 */
export async function listBlockedSplitJobs(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogSplitJobRow[]> {
  return db
    .select()
    .from(catalogSplitJobs)
    .where(eq(catalogSplitJobs.status, 'blocked'))
    .orderBy(asc(catalogSplitJobs.createdAt))
    .limit(Math.max(1, limit));
}

export async function releaseSplitJob(
  options: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly deadLettered: boolean;
    readonly availableAt: Date;
    readonly error: string;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(catalogSplitJobs)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, CURATION_MAX_TEXT_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedSplitLease(options.id, options.leaseOwner, now))
    .returning({ id: catalogSplitJobs.id });
  return rows.length === 1;
}

// ── Split assignments ──────────────────────────────────────────────────────

/**
 * Name one row that moves.
 *
 * `ON CONFLICT DO NOTHING` on `(job_id, item_type, item_ref)`, so re-submitting
 * a plan converges — and the trigger refuses the insert outright once the job
 * has left `plan`, which is #59 split invariant 1 made structural rather than
 * enforced by whoever remembered to check the phase.
 */
export async function insertSplitAssignment(
  jobId: string,
  itemType: CatalogSplitItemType,
  itemRef: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(catalogSplitAssignments).values({ jobId, itemType, itemRef }).onConflictDoNothing();
}

export async function listSplitAssignments(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogSplitAssignmentRow[]> {
  return db
    .select()
    .from(catalogSplitAssignments)
    .where(eq(catalogSplitAssignments.jobId, jobId))
    .orderBy(asc(catalogSplitAssignments.itemType), asc(catalogSplitAssignments.itemRef));
}

/** What the resumed `assignments` phase still owes. */
export async function listPendingSplitAssignments(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogSplitAssignmentRow[]> {
  return db
    .select()
    .from(catalogSplitAssignments)
    .where(
      and(
        eq(catalogSplitAssignments.jobId, jobId),
        isNull(catalogSplitAssignments.appliedAt),
        isNull(catalogSplitAssignments.skippedReason),
      ),
    )
    .orderBy(asc(catalogSplitAssignments.itemType), asc(catalogSplitAssignments.itemRef));
}

export async function markAssignmentApplied(
  id: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(catalogSplitAssignments)
    .set({ appliedAt: now })
    .where(and(eq(catalogSplitAssignments.id, id), isNull(catalogSplitAssignments.appliedAt)));
}

export async function markAssignmentSkipped(
  id: string,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(catalogSplitAssignments)
    .set({ skippedReason: reason.slice(0, CURATION_MAX_TEXT_LENGTH) })
    .where(and(eq(catalogSplitAssignments.id, id), isNull(catalogSplitAssignments.appliedAt)));
}

/** The `verify` phase's own reconciliation: assigned versus applied. */
export async function summarizeSplitAssignments(
  jobId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ readonly assigned: number; readonly applied: number; readonly skipped: number }> {
  const rows = await db
    .select({
      assigned: sql<number>`count(*)::int`,
      applied: sql<number>`count(*) filter (where ${catalogSplitAssignments.appliedAt} is not null)::int`,
      skipped: sql<number>`count(*) filter (where ${catalogSplitAssignments.skippedReason} is not null)::int`,
    })
    .from(catalogSplitAssignments)
    .where(eq(catalogSplitAssignments.jobId, jobId));
  const row = rows[0];
  return { assigned: Number(row?.assigned ?? 0), applied: Number(row?.applied ?? 0), skipped: Number(row?.skipped ?? 0) };
}
