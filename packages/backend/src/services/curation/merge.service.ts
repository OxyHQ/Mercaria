/**
 * The merge JOB — request, approve, and the phase runner (#59 merge invariants
 * 1–7, acceptance 3).
 *
 * ## The phases are the resumability, and the phase RECORDS are the proof
 *
 * A merge crashes mid-way for the ordinary reasons: an ECS task is replaced, a
 * lease expires, a statement times out. What must not happen is that a resumed
 * job re-runs a phase whose effects were not idempotent, or skips one whose
 * effects were lost. So each phase CLAIMS its `catalog_merge_job_phases` row
 * before doing anything and stamps it complete after — and the claim's
 * `ON CONFLICT DO NOTHING` means a phase already stamped is skipped, while one
 * claimed but never stamped is RE-RUN. Every rehoming statement is idempotent
 * (its WHERE matches only rows still pointing at the loser), so the re-run is
 * safe and reports zero.
 *
 * ## Why the tombstone is stamped LAST of the mutating phases
 *
 * Until `redirects` runs, the loser is a live entity whose children are being
 * moved; a crash leaves a resumable job. Stamping the tombstone first would
 * leave a dead identity with live children pointing at it and nothing to say
 * which phase was owed — the state that is genuinely hard to recover from.
 *
 * ## What this service does NOT do
 *
 * It never deletes a row, never writes an order or a listing (#59 merge
 * invariant 3 is structural: no plan entry names one), and never picks a side
 * of a conflict. `curation-isolation.test.ts` fails the build on all three.
 */

import {
  CATALOG_MERGE_PHASES,
  isMergeableEntityType,
  nextMergePhase,
  requiresSecondApproval,
  type CatalogMergeConflictResolution,
  type CatalogMergePhase,
  type CatalogImpactEstimate,
  type MergeableEntityType,
} from '@mercaria/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  advanceMergePhase,
  cancelMergeJob,
  approveMergeJob,
  blockMergeJob,
  claimMergePhase,
  completeMergeJob,
  completeMergePhase,
  countUnresolvedConflicts,
  findConflictById,
  findMergeJobById,
  findOpenMergeJobFor,
  insertMergeJob,
  listBlockedMergeJobs,
  listUnappliedConflicts,
  markConflictApplied,
  resolveConflict,
  unblockMergeJob,
} from '../../db/curation/jobRepository.js';
import {
  bundleComponentStillExists,
  suppressionStillOpen,
} from '../../db/curation/conflictRepository.js';
import { applyBareArrayRehome, applyRehomeTarget } from '../../db/curation/rehomeRepository.js';
import { stampPriceAlertRehoming } from '../../db/priceAlerts/priceAlertRepository.js';
import { requestPriceAlertEvaluationForProduct } from '../../db/priceAlerts/priceAlertEvaluationRepository.js';
import { stampShoppingAgentRehoming } from '../../db/shoppingAgents/shoppingAgentRepository.js';
import { requestShoppingAgentTriggerForProduct } from '../../db/shoppingAgents/shoppingAgentTriggerRepository.js';
import { recordReviewsRetainedByMerge } from '../../db/reviews/reviewMigrationRepository.js';
import type { CatalogMergeJobRow } from '../../db/schema/curation.js';
import { estimateMergeImpact, impactColumnValues } from './impact.js';
import { CURATED_ENTITIES } from './entity-registry.js';
import { bareArrayRehomesFor, MERGE_REHOMING_PLAN, targetsForPhase } from './merge-plan.js';
import {
  applyConflictResolution,
  detectMergeConflicts,
  mergePairSubjects,
  recordMergeConflicts,
} from './merge-conflicts.js';
import { recordRevision } from './revision.js';
import { rebuildEntityAggregates, rebuildEntityRollups } from './rollups.js';

/** The phases whose work is a set of plan targets rather than bespoke logic. */
const REHOMING_PHASES: readonly CatalogMergePhase[] = [
  'children',
  'identifiers',
  'aliases',
  'source_links',
  'offers',
  'relationships',
  // `reviews` is deliberately NOT here (#333): it moves plan targets like the
  // rest and then RECORDS what the guard left behind, which no plan entry can
  // express. See {@link runReviewsPhase}.
  //
  // #80's product saves. An ordinary rehoming phase and not bespoke logic: the
  // three columns it moves are declared in `merge-plan.ts` like every other, so
  // the census still forces a decision when a fourth appears.
  'saves',
];

export interface RequestMergeInput {
  readonly entityType: MergeableEntityType;
  readonly loserId: string;
  readonly winnerId: string;
  readonly reason: string;
  readonly actorOxyUserId: string;
  readonly reviewItemId?: string | null;
  readonly parentJobId?: string | null;
}

/** One entity's row, or a 404 that names the type as well as the id. */
async function requireEntity(
  entityType: MergeableEntityType,
  id: string,
  db: DatabaseOrTransaction,
): Promise<{ readonly status: string; readonly mergedIntoId: string | null; readonly name: string | null }> {
  const definition = CURATED_ENTITIES[entityType];
  const rows = await db
    .select({
      status: sql<string>`${definition.statusColumn}`,
      mergedIntoId: sql<string | null>`${definition.mergedIntoColumn}`,
      name: sql<string | null>`${definition.nameColumn}`,
    })
    .from(definition.table)
    .where(eq(definition.idColumn, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(`No ${entityType} with id ${id}.`);
  return row;
}

/**
 * Open a merge job.
 *
 * The refusals here are the ones that must happen BEFORE any impact is measured,
 * because each of them describes a merge that could never be correct:
 *
 * - merging a row into itself,
 * - merging INTO a tombstone (the winner would be a dead identity; resolve it to
 *   its final target first, which keeps `merged_into_id` one hop as D16 requires),
 * - merging a row that is already a tombstone (there is nothing left to move),
 * - merging a SUPPRESSED row on either side (#694 — see below),
 * - and a second live job for the same loser, which the partial unique refuses
 *   anyway — this read just turns a `23505` into a sentence.
 *
 * ## Why a suppressed row is refused rather than carried through (#694)
 *
 * `suppressEntity` does not only write a `catalog_entity_suppressions` row; it
 * stamps the ENTITY, `status = 'suppressed'`, and every catalogue read filters
 * `status = 'active'`. So the suppression is enforced one indirection away from
 * the table that records it — which is exactly why it is easy to miss, and why
 * this guard did not exist.
 *
 * A merge destroys that enforcement in BOTH directions, and neither is a
 * decision a merge may take on an operator's behalf:
 *
 * - **A suppressed LOSER** is stamped `status = 'merged'` by the tombstone
 *   write, which has no status guard. Its offers, identifiers, source links,
 *   aliases, images and attribute values are then rehomed onto a winner that is
 *   still `active` — so everything the suppression covered is served again,
 *   while the suppression row sits open (`lifted_at IS NULL`) against a
 *   tombstone, claiming to cover something nobody can reach. The merge has
 *   LIFTED a suppression and nothing recorded that it did.
 * - **A suppressed WINNER** is the mirror image: the loser's content is rehomed
 *   onto a suppressed row and vanishes from every catalogue read. The merge has
 *   EXTENDED a suppression to content nobody examined.
 *
 * Refusing is what `~/Oxy/AGENTS.md` calls making a state unrepresentable
 * rather than repairing it, and it is the treatment this function already gives
 * the analogous case: a tombstone winner is refused with a remedy in the
 * message rather than resolved for the operator. The remedy here is the same
 * shape — lift the suppression, or suppress the winner deliberately — because
 * both are acts an operator performs and neither is one a merge may infer.
 *
 * **This is a REQUEST-time guard and it does not close the whole gap.** A
 * suppression landing between a job being requested and the job running is not
 * seen here; that case belongs to the `plan` phase, which already probes for
 * collisions and records a conflict the job then blocks on. See #694.
 */
export async function requestMerge(input: RequestMergeInput): Promise<CatalogMergeJobRow> {
  if (input.loserId === input.winnerId) {
    throw validationError('A thing cannot be merged into itself.');
  }
  if (!isMergeableEntityType(input.entityType)) {
    throw validationError(`${input.entityType} is not an entity a merge can act on.`);
  }
  const db = getDb();
  const loser = await requireEntity(input.entityType, input.loserId, db);
  const winner = await requireEntity(input.entityType, input.winnerId, db);
  if (loser.status === 'merged') {
    throw conflict(
      `${input.entityType} ${input.loserId} is already merged into ${loser.mergedIntoId ?? 'another row'}.`,
    );
  }
  if (winner.status === 'merged') {
    throw conflict(
      `${input.entityType} ${input.winnerId} is a tombstone pointing at ` +
        `${winner.mergedIntoId ?? 'another row'}; merge into that row instead, so resolution stays one hop.`,
    );
  }
  if (loser.status === 'suppressed') {
    throw conflict(
      `${input.entityType} ${input.loserId} is suppressed, and merging it would lift that ` +
        'suppression: the tombstone write replaces `suppressed` with `merged` and every row the ' +
        `suppression covered is rehomed onto ${input.winnerId}, which is not suppressed. Lift the ` +
        'suppression first if it no longer applies, or suppress the winner deliberately — a merge ' +
        'must not decide either.',
    );
  }
  if (winner.status === 'suppressed') {
    throw conflict(
      `${input.entityType} ${input.winnerId} is suppressed, and merging into it would extend that ` +
        `suppression to everything ${input.loserId} owns, which nobody examined. Lift the ` +
        'suppression first, or suppress the loser deliberately before merging.',
    );
  }
  const existing = await findOpenMergeJobFor(input.entityType, input.loserId, db);
  if (existing) {
    throw conflict(
      `${input.entityType} ${input.loserId} already has an open merge job (${existing.id}); ` +
        'two merges of one identity are two irreconcilable histories.',
    );
  }

  const impact = await estimateMergeImpact(input.entityType, input.loserId, db);
  const needsApproval = requiresSecondApproval(
    'merge',
    impact.totalMoving,
    config.catalog.fourEyesRequired,
  );

  const job = await insertMergeJob(
    {
      entityType: input.entityType,
      loserId: input.loserId,
      winnerId: input.winnerId,
      reason: input.reason,
      requestedByOxyUserId: input.actorOxyUserId,
      requiresSecondApproval: needsApproval,
      parentJobId: input.parentJobId ?? null,
      reviewItemId: input.reviewItemId ?? null,
      impact: impactColumnValues(impact),
    },
    db,
  );

  await recordRevision(
    {
      entityType: input.entityType,
      entityId: input.loserId,
      action: 'merge',
      actorKind: 'operator',
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      note: `merge requested into ${input.winnerId}`,
      mergeJobId: job.id,
      reviewItemId: input.reviewItemId ?? null,
      before: { status: loser.status, name: loser.name },
      after: { plannedWinnerId: input.winnerId, impact },
    },
    db,
  );
  return job;
}

/** Record the second operator's approval (#59 security 4). */
export async function approveMerge(
  jobId: string,
  approverOxyUserId: string,
  reason: string,
): Promise<CatalogMergeJobRow> {
  const db = getDb();
  const job = await findMergeJobById(jobId, db);
  if (!job) throw notFound(`No merge job ${jobId}.`);
  if (job.requestedByOxyUserId === approverOxyUserId) {
    throw validationError(
      'A merge cannot be approved by the operator who requested it; four eyes means two people.',
    );
  }
  const approved = await approveMergeJob(jobId, approverOxyUserId, db);
  if (!approved) throw conflict(`Merge job ${jobId} already carries an approval.`);
  await recordRevision(
    {
      entityType: job.entityType,
      entityId: job.loserId,
      action: 'merge',
      actorKind: 'operator',
      actorOxyUserId: approverOxyUserId,
      reason,
      note: 'second approval recorded',
      mergeJobId: jobId,
    },
    db,
  );
  return approved;
}

export interface ResolveConflictInput {
  readonly conflictId: string;
  readonly resolution: CatalogMergeConflictResolution;
  readonly reason: string;
  readonly actorOxyUserId: string;
}

/**
 * Record an operator's decision about one conflict, and — for `merge_pair` —
 * open the child job it implies.
 *
 * The child job is created FIRST and the resolution names it, because
 * `catalog_merge_conflicts_child_job_check` makes the two inseparable: a
 * `merge_pair` with no child job is unrepresentable, so a crash between them
 * cannot leave a resolution that claims a merge nobody started.
 */
export async function resolveMergeConflict(
  input: ResolveConflictInput,
): Promise<{ readonly resolved: boolean; readonly childJobId: string | null }> {
  const db = getDb();
  const row = await findConflictById(input.conflictId, db);
  if (!row) throw notFound(`No merge conflict ${input.conflictId}.`);
  if (row.resolution) {
    throw conflict(`Merge conflict ${input.conflictId} was already resolved as ${row.resolution}.`);
  }
  const job = await findMergeJobById(row.jobId, db);
  if (!job) throw notFound(`Merge job ${row.jobId} no longer exists.`);

  /**
   * A decision whose ACT belongs to another domain is REFUSED until that act has
   * happened — never recorded and verified later (#405).
   *
   * `drop_component` says the operator removed the component from the bundle, in
   * the catalogue, where deleting a component row is the ordinary edit; curation
   * itself deletes nothing. Checking it HERE rather than when the resolution is
   * applied is what keeps a job out of a state nothing can lift: a job leaves
   * `blocked` only when a resolution is ACCEPTED, and `unblockMergeJob` has
   * exactly one caller — this function. Accept a decision that cannot yet be
   * carried out and the job unblocks, re-blocks in the resolution phase with
   * every conflict already resolved, and no code path can ever unblock it again.
   */
  if (
    input.resolution === 'drop_component' &&
    row.collapsingBundleVariantId &&
    row.collapsingComponentVariantId &&
    (await bundleComponentStillExists(
      row.collapsingBundleVariantId,
      row.collapsingComponentVariantId,
      db,
    ))
  ) {
    throw conflict(
      `Bundle ${row.collapsingBundleVariantId} still lists ${row.collapsingComponentVariantId} ` +
        'as a component. Remove it from the bundle in the catalogue first: this merge makes the ' +
        'two one variant, and a bundle cannot contain itself.',
    );
  }

  /**
   * The same refusal, one domain over (#694).
   *
   * `suppression_cleared` says an operator has ALREADY lifted the suppression,
   * or already suppressed the other side, in the suppression domain where that
   * act belongs — curation neither lifts nor suppresses. Checking it HERE
   * rather than when the resolution is applied is what keeps the job out of a
   * state nothing can lift: accept a decision whose act has not happened and
   * the job unblocks, re-blocks in the resolution phase with every conflict
   * already resolved, and only #663's sweep saves it — by refusing to resume a
   * job whose condition still holds, which leaves it parked on a decision an
   * operator believes they already made.
   */
  if (
    input.resolution === 'suppression_cleared' &&
    row.suppressionId &&
    (await suppressionStillOpen(row.suppressionId, db))
  ) {
    throw conflict(
      `Suppression ${row.suppressionId} is still open. Lift it if it no longer applies, or ` +
        'suppress the other side of this merge deliberately — either act belongs to the ' +
        'suppression surface, and this decision only records that one of them has happened.',
    );
  }

  let childJobId: string | null = null;
  if (input.resolution === 'merge_pair') {
    const pair = mergePairSubjects(row);
    const child = await requestMerge({
      entityType: 'canonical_variant',
      loserId: pair.loserId,
      winnerId: pair.winnerId,
      reason: `${input.reason} (opened by merge job ${job.id})`,
      actorOxyUserId: input.actorOxyUserId,
      parentJobId: job.id,
    });
    childJobId = child.id;
  }

  const resolved = await resolveConflict(
    {
      id: input.conflictId,
      resolution: input.resolution,
      resolvedByOxyUserId: input.actorOxyUserId,
      resolutionReason: input.reason,
      childJobId,
    },
    db,
  );
  if (!resolved) {
    throw conflict(`Merge conflict ${input.conflictId} was resolved concurrently.`);
  }

  await recordRevision(
    {
      entityType: job.entityType,
      entityId: job.loserId,
      action: 'merge',
      actorKind: 'operator',
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      note: `conflict ${row.kind} resolved as ${input.resolution}`,
      mergeJobId: job.id,
      before: { conflictId: row.id, kind: row.kind, detail: row.detail },
      after: { resolution: input.resolution, childJobId },
    },
    db,
  );

  // A blocked job becomes claimable again the moment nothing is outstanding.
  // Checking here rather than only on the sweep is what makes the operator's
  // decision the thing that restarts the job — but the QUESTION is the shared
  // predicate's, not this function's, so an eager unblock and a swept one
  // cannot disagree about what "outstanding" means.
  const state = await mergeJobBlockingState({ ...job, status: 'blocked' }, db);
  if (state.state === 'clear') {
    await unblockMergeJob(job.id, db);
  }
  return { resolved: true, childJobId };
}

/**
 * Why this job cannot be cancelled — or that it can (#680).
 *
 * A pure read over the row, and the ONE spelling of the rule, so the service
 * and its refusal message cannot describe different policies.
 *
 * ## THE PHASE IS THE DISCRIMINATOR, NOT THE STATUS
 *
 * Read this before widening the status set. `blocked` is safe at ANY phase, and
 * that is a property of the code rather than of the phase's position in the
 * list: {@link runResolutionPhase} asks {@link mergeJobBlockingState} and
 * returns BEFORE applying a single decision, so a job that reached `blocked`
 * has moved nothing whatever phase it is parked at. `pending` is safe at `plan`
 * ONLY — a job released after a mid-run failure is `pending` at whatever phase
 * it reached, so admitting it on status alone admits a half-rehomed merge.
 *
 * `awaiting_resolution` is the case that looks safe and is not. #663 made the
 * resolution phase evaluate its whole gate before applying anything, but a job
 * that failed MID-APPLICATION is released there with some decisions already
 * applied. Blocked at that phase is safe; pending at it is not.
 *
 * The refusals are not interchangeable and the wording matters, because each
 * leads an operator to a different next action. `dead_letter` is the one to
 * read: cancelling it would release nothing, because a dead-lettered job is not
 * in `OPEN_STATUSES` and therefore holds no open job for the entity — so the
 * useful answer is that they can request a fresh merge RIGHT NOW, which a status
 * change would have left them still wondering about.
 */
export type MergeJobCancellationState =
  /** The `allowed` branch carries no reason: there is none to read. */
  | { readonly state: 'allowed' }
  | { readonly state: 'refused'; readonly reason: string };

export function mergeJobCancellationState(job: CatalogMergeJobRow): MergeJobCancellationState {
  if (job.status === 'blocked') return { state: 'allowed' };
  if (job.status === 'pending' && job.phase === 'plan') return { state: 'allowed' };

  if (job.status === 'pending') {
    return {
      state: 'refused',
      reason:
        `This merge is pending at the '${job.phase}' phase, so work has already been applied. ` +
        'Cancelling is stopping, never reverting — only a job that has moved nothing may be ' +
        'cancelled. Let it run, or let it dead-letter.',
    };
  }
  if (job.status === 'processing') {
    return {
      state: 'refused',
      reason:
        'This merge is running under a live lease. Cancelling it would race the worker; wait ' +
        'for the lease to expire or for the phase to finish.',
    };
  }
  if (job.status === 'dead_letter') {
    return {
      state: 'refused',
      reason:
        'A dead-lettered merge holds no open job for this entity, so cancelling it would ' +
        'release nothing — a fresh merge can be requested now. It may also have dead-lettered ' +
        'part-way, and marking it cancelled would put that word on work that still stands.',
    };
  }
  return {
    state: 'refused',
    reason: `This merge is '${job.status}' and there is nothing left to stop.`,
  };
}

/**
 * Stop a merge that has moved nothing, and free the entity for another one.
 *
 * The attribution posture every other write on this surface has: a mandatory
 * actor and reason, and a `catalog_revisions` entry. The revision uses the
 * existing `merge` action with a note rather than a new `cancel` one —
 * `approveMerge` sets that precedent, and `catalog_revisions_action_check` is
 * rendered from `CATALOG_REVISION_ACTIONS`, so a new member would be a
 * migration for a fact the note already carries.
 */
export async function cancelMerge(
  jobId: string,
  actorOxyUserId: string,
  reason: string,
): Promise<CatalogMergeJobRow> {
  const db = getDb();
  const job = await findMergeJobById(jobId, db);
  if (!job) throw notFound(`No merge job ${jobId}.`);

  const verdict = mergeJobCancellationState(job);
  if (verdict.state === 'refused') throw conflict(verdict.reason);

  const note = `cancelled by ${actorOxyUserId}: ${reason}`;
  if (!(await cancelMergeJob(jobId, note, db))) {
    // The CAS lost, so the row moved between the read and the write — a claim,
    // a resume, or another operator. Re-read rather than reporting the state
    // this request happened to see.
    const now = await findMergeJobById(jobId, db);
    throw conflict(
      `Merge job ${jobId} changed while being cancelled (it is now '${now?.status ?? 'gone'}'); ` +
        'read it again and decide against its current state.',
    );
  }

  await recordRevision(
    {
      entityType: job.entityType,
      entityId: job.loserId,
      action: 'merge',
      actorKind: 'operator',
      actorOxyUserId,
      reason,
      note: 'merge cancelled before any row moved',
      mergeJobId: jobId,
    },
    db,
  );
  const cancelled = await findMergeJobById(jobId, db);
  if (!cancelled) throw notFound(`No merge job ${jobId}.`);
  return cancelled;
}

/**
 * Why a merge job cannot proceed right now — or that it can (#663).
 *
 * ## This is the ONE spelling of the `awaiting_resolution` gate
 *
 * `blocked` is not claimable, deliberately: a dispatcher that retried a job
 * waiting on a person would spin against a judgement only a person can make.
 * The cost of that, until #663, was a DEAD END. `unblockMergeJob` had exactly
 * one caller — `resolveMergeConflict` — so a job that reached `blocked` with
 * every conflict already resolved could never be lifted by anything, because
 * the one thing that lifts it fires on a resolution and there was nothing left
 * to resolve. TWO conditions reach that state and neither is exotic:
 *
 * - **`merge_pair`**, the case #663 was filed for. Resolving the conflict opens
 *   a CHILD job and unblocks the parent; the parent then re-blocks waiting on
 *   that child, and the child completing lifts nothing.
 * - **The second approval**, which #663 does not name and which is worse.
 *   `catalog_merge_jobs_second_approval_check` permits `awaiting_resolution`
 *   unapproved, so a four-eyes job advances there within seconds of being
 *   requested and blocks; the approval arrives hours later and lifts nothing.
 *   EVERY merge over the impact threshold was stranded.
 *
 * The repair is not a hook on each of those two clearing acts. That is a
 * hand-maintained map of "things that unblock a job", and the failure it
 * produces is silent: the third condition somebody adds has no hook and strands
 * again, with nothing red. So the gate is written ONCE, here, as a predicate
 * over stored state, and the three places that need the answer all ask it:
 * {@link runResolutionPhase} (which blocks on its verdict),
 * {@link resolveMergeConflict} (an eager evaluation, for latency) and
 * {@link resumeBlockedMergeJobs} (the sweep).
 *
 * ## Why this cannot resume a job whose precondition is unmet
 *
 * Because the thing that decides to resume is the same function that decided to
 * block. There is no second opinion available to be wrong, which is what an
 * operator "retry" button would have been. Resuming is also not RUNNING: the
 * sweep flips a status and claims nothing, so `blocked` stays non-claimable and
 * the dispatcher still cannot spin on a decision a person owes.
 *
 * ## It refuses to vouch for a phase it does not own
 *
 * Only `awaiting_resolution` blocks today. A phase added later that blocks for
 * some other reason must NOT be auto-resumed by a predicate that never heard of
 * it, so an unrecognised phase answers `blocked` naming itself — fails closed,
 * loudly, in the operator's own trace. {@link PhaseOutcome} states the same
 * thing to the compiler.
 */
export type MergeJobBlockingState =
  /** The `clear` branch carries no reason: there is none to read. */
  | { readonly state: 'clear' }
  | { readonly state: 'blocked'; readonly reason: string };

/**
 * The handle is REQUIRED, with no `= getDb()` default (#584/#599's ruling).
 *
 * A default lets a caller inside a transaction forget to pass its handle; the
 * reads then escape to the root connection, see pre-commit state, and nothing
 * says so. Two of the three callers here would survive that — they run outside
 * any transaction and act on `clear` by scheduling work the next pass would
 * schedule anyway, so the worst case is a delay. {@link runResolutionPhase} is
 * the one that would not: it holds the phase transaction, and `clear` is its
 * ACTING branch, so a stale read there applies conflict resolutions on a
 * verdict taken against data the transaction had already changed. Requiring
 * the parameter makes a forgotten handle an arity error rather than a silent
 * escape — note that under `strict: false` an explicit `undefined` still
 * satisfies it, so this is the speed bump and the callers passing it is the
 * guarantee.
 */
export async function mergeJobBlockingState(
  job: CatalogMergeJobRow,
  db: DatabaseOrTransaction,
): Promise<MergeJobBlockingState> {
  if (job.phase !== 'awaiting_resolution') {
    return {
      state: 'blocked',
      reason:
        `This job is parked at the '${job.phase}' phase, which nothing here knows how to clear. ` +
        'Only `awaiting_resolution` has a resume condition; a phase that blocks for another ' +
        'reason owes one before it can be resumed automatically.',
    };
  }

  const unresolved = await countUnresolvedConflicts(job.id, db);
  if (unresolved > 0) {
    return {
      state: 'blocked',
      reason: `${unresolved} conflict(s) await an explicit decision before this merge may commit.`,
    };
  }

  if (job.requiresSecondApproval && !job.approvedByOxyUserId) {
    return {
      state: 'blocked',
      reason: `This merge moves ${job.impactTotalMoving} rows and needs a second operator's approval.`,
    };
  }

  for (const row of await listUnappliedConflicts(job.id, db)) {
    if (row.resolution !== 'merge_pair') continue;
    const child = row.childJobId ? await findMergeJobById(row.childJobId, db) : undefined;
    if (child?.status === 'completed') continue;
    /**
     * The child's CURRENT status, not "must complete first".
     *
     * A child that is still running and a child that dead-lettered lead an
     * operator to opposite actions, and the old wording could not tell them
     * apart. Neither can be resumed from here — a parent whose child failed
     * genuinely must not proceed — so what this owes is an accurate name for
     * the thing a person has to go and look at.
     */
    return {
      state: 'blocked',
      reason:
        `Child merge job ${row.childJobId ?? '(missing)'} is ${child?.status ?? 'missing'} and ` +
        'must be completed before this merge may commit.',
    };
  }

  return { state: 'clear' };
}

/**
 * Every blocked job whose condition has since cleared, back to `pending`.
 *
 * Bounded and driven from {@link drainCurationJobs}, so a manual drain and the
 * loop resume the same jobs — the property that file already promises about
 * claiming. It needs no lease: `unblockMergeJob`'s CAS makes a second sweeper's
 * pass a no-op, and the work it schedules is claimed under the ordinary lease
 * like any other pending job.
 */
export async function resumeBlockedMergeJobs(batchSize: number): Promise<number> {
  const db = getDb();
  let resumed = 0;
  for (const job of await listBlockedMergeJobs(batchSize, db)) {
    const state = await mergeJobBlockingState(job, db);
    if (state.state === 'blocked') continue;
    if (await unblockMergeJob(job.id, db)) {
      resumed += 1;
      log.general.info(
        { jobId: job.id, phase: job.phase },
        '[Curation] merge job resumed: its blocking condition has cleared',
      );
    }
  }
  return resumed;
}

/**
 * One phase's outcome, so the runner can record rows moved and decide the next
 * step.
 *
 * It carries NO `blockedReason`, and that omission is a gate. Blocking is only
 * safe where {@link mergeJobBlockingState} can decide the job is safe to
 * RESUME, and it can decide that for `awaiting_resolution` alone. So a phase
 * runner declared to return this type cannot return a blocking outcome —
 * excess-property checking on the returned literal refuses it — and a future
 * phase that needs to block fails `tsc` until somebody has taught the predicate
 * how its condition clears. Which is the whole of #663 stated to the compiler.
 */
interface PhaseOutcome {
  readonly rowsAffected: number;
}

/** The one phase that may block, because it is the one the predicate covers. */
interface ResolutionPhaseOutcome extends PhaseOutcome {
  readonly blockedReason?: string;
}

/** `plan` — measure, probe every unique, and record what a person must decide. */
async function runPlanPhase(job: CatalogMergeJobRow, db: DatabaseOrTransaction): Promise<PhaseOutcome> {
  const detected = await detectMergeConflicts(job.entityType, job.loserId, job.winnerId, db);
  const recorded = await recordMergeConflicts(job.id, detected, db);
  return { rowsAffected: recorded };
}

/**
 * `awaiting_resolution` — the gate (#59 merge invariant 4).
 *
 * It BLOCKS while anything is undecided, and otherwise applies each decision in
 * its own domain's terms before a single child row moves. `markConflictApplied`
 * runs after the application, so a crash between them re-applies a statement
 * that is already idempotent rather than skipping one that was not.
 */
async function runResolutionPhase(
  job: CatalogMergeJobRow,
  db: DatabaseOrTransaction,
): Promise<ResolutionPhaseOutcome> {
  /**
   * The gate is asked, never re-implemented.
   *
   * It used to be spelled out here — the unresolved count, the second approval
   * and the child job, each inline. That is what made #663's dead end possible:
   * the conditions that park a job lived in the runner and the one thing that
   * un-parked it lived somewhere else, so the two could not agree and nothing
   * noticed. Asking `mergeJobBlockingState` means the phase blocks on exactly
   * the condition the sweep will later test for having cleared.
   *
   * It is evaluated in full BEFORE anything is applied, which also fixes a
   * smaller fault in the old loop: it applied resolutions one at a time and
   * blocked partway through when it reached an incomplete `merge_pair`, so
   * whether a decision had been carried out depended on the order conflicts
   * happened to be created in.
   */
  const state = await mergeJobBlockingState(job, db);
  if (state.state === 'blocked') return { rowsAffected: 0, blockedReason: state.reason };

  let applied = 0;
  for (const row of await listUnappliedConflicts(job.id, db)) {
    // A `merge_pair` is carried out by the CHILD job, which the predicate has
    // just confirmed completed; there is nothing for this phase to apply, and
    // applying anything would repoint a variant its signature twin already owns.
    if (row.resolution !== 'merge_pair') {
      await applyConflictResolution(row, row.resolvedByOxyUserId ?? job.requestedByOxyUserId, db);
    }
    await markConflictApplied(row.id, db);
    applied += 1;
  }
  return { rowsAffected: applied };
}

/** A rehoming phase — run every plan target this phase owns. */
async function runRehomingPhase(
  job: CatalogMergeJobRow,
  phase: CatalogMergePhase,
  db: DatabaseOrTransaction,
): Promise<PhaseOutcome> {
  let moved = 0;
  for (const target of targetsForPhase(job.entityType, phase)) {
    moved += await applyRehomeTarget(target, job.loserId, job.winnerId, db);
  }
  return { rowsAffected: moved };
}

/**
 * `alerts` — #79's price alerts, and the ONE thing the generic rehomer cannot do.
 *
 * The plan's targets move the columns exactly as every other phase's do; what
 * this adds is the PROVENANCE stamp, which has to run FIRST and be scoped to the
 * LOSER. `applyRehomeTarget` sets a column to the WINNER's id and knows nothing
 * about where a row came from, so a stamp applied afterwards would have to find
 * "the alerts on the winner that just moved" — which is indistinguishable from
 * the alerts that were always there.
 *
 * Only a canonical-product merge stamps: an alert's `rehomed_from` names the
 * product it was watching, and a variant, merchant or storefront merge changes a
 * SCOPE rather than the subject. The stamp is idempotent by predicate — after
 * the move there are no alerts left on the loser — so `verify` re-running the
 * plan targets is unaffected.
 */
async function runAlertsPhase(
  job: CatalogMergeJobRow,
  db: DatabaseOrTransaction,
): Promise<PhaseOutcome> {
  if (job.entityType === 'canonical_product') {
    await stampPriceAlertRehoming({ canonicalProductId: job.loserId, now: new Date() }, db);
  }
  let moved = 0;
  for (const target of targetsForPhase(job.entityType, 'alerts')) {
    moved += await applyRehomeTarget(target, job.loserId, job.winnerId, db);
  }
  if (moved > 0) {
    // The alerts that just moved have never been judged against the WINNER's
    // offers. The loser's own queue row stays with the tombstone (see the plan's
    // note), so without this the rehomed alerts would wait for the next time a
    // seller happened to change a price on the winner. The enqueue converges, so
    // a merge that moved four hundred alerts still owes one evaluation.
    await requestPriceAlertEvaluationForProduct(job.winnerId, db);
  }
  return { rowsAffected: moved };
}

/**
 * `agents` — #97's saved shopping agents, `alerts` one domain over and for the
 * same three reasons.
 *
 * The plan's targets move the columns exactly as every other phase's do; what
 * this adds is the PROVENANCE stamp, which has to run FIRST and be scoped to the
 * LOSER. `applyRehomeTarget` sets a column to the WINNER's id and knows nothing
 * about where a row came from, so a stamp applied afterwards would have to find
 * "the agents that just moved" — which is indistinguishable from the agents that
 * were always there.
 *
 * Only a canonical-product merge stamps: an agent's `rehomed_from` names the
 * product its lines were watching, and a variant or merchant merge changes a
 * NARROWING rather than the subject. The stamp is idempotent by predicate —
 * after the move no line points at the loser — so `verify` re-running the plan
 * targets is unaffected.
 */
async function runAgentsPhase(
  job: CatalogMergeJobRow,
  db: DatabaseOrTransaction,
): Promise<PhaseOutcome> {
  if (job.entityType === 'canonical_product') {
    await stampShoppingAgentRehoming({ canonicalProductId: job.loserId, now: new Date() }, db);
  }
  let moved = 0;
  for (const target of targetsForPhase(job.entityType, 'agents')) {
    moved += await applyRehomeTarget(target, job.loserId, job.winnerId, db);
  }
  // The fan-out is a CANONICAL PRODUCT question, and the guard is not cosmetic:
  // `shopping_agent_triggers.canonical_product_id` carries a real foreign key to
  // `canonical_products`, so on a MERCHANT merge — whose `agents` phase moves
  // `shopping_agent_lines.merchant_id` — `job.winnerId` is a merchant id and the
  // enqueue raises 23503, taking the whole phase with it. Measured: a merchant
  // merge moving one agent line fails with `Key (canonical_product_id)=(mrc-…)
  // is not present in table "canonical_products"`. The top of this function
  // already guards its other product-only call the same way.
  if (moved > 0 && job.entityType === 'canonical_product') {
    // The agents that just moved have never been evaluated against the WINNER's
    // offers. The loser's own trigger row stays with the tombstone (see the
    // plan's note), so without this the rehomed agents would wait for the next
    // time a seller happened to change a price on the winner — which for a
    // standing objective is a wait with no upper bound and no symptom. The
    // enqueue CONVERGES on one row per product, so a merge that moved four
    // hundred lines still owes exactly one fan-out.
    await requestShoppingAgentTriggerForProduct(job.winnerId, db);
  }
  return { rowsAffected: moved };
}

/**
 * `reviews` — #76's rows, and the ONE thing the generic rehomer cannot say.
 *
 * The plan's targets move the columns exactly as every other phase's do; what
 * this adds is the RECORD of what was left behind. `reviews.canonical_product_id`
 * and `reviews.merchant_id` are `repoint_if_absent` because
 * `reviews_author_scope_target_key` collides when one buyer reviewed both sides
 * (#333) — and a review that stays on a tombstone is invisible from then on,
 * indistinguishable from one nothing ever considered. So the disposition is
 * appended to `review_target_migrations` under `rehome_merge`, the action #76
 * published for exactly this and which nothing wrote until now.
 *
 * AFTER the move, and both halves of that matter. After, because what is still
 * pointing at the loser once `repoint_if_absent` has run IS the collided set, so
 * the record is an observation rather than a prediction — the opposite of the
 * `alerts` stamp, which must run first because it names where a row CAME from.
 * And only the two scopes whose target is a mergeable entity: the other three
 * name a listing, an Oxy account and an order line, and a merge of any of those
 * does not exist.
 *
 * Idempotent by the log's own `UNIQUE(review_id, action, coalesce(to_target_ref,
 * ''))`, so a phase re-run after a crash writes nothing new — and `verify`,
 * which re-runs the plan targets and not this, is unaffected either way.
 */
async function runReviewsPhase(
  job: CatalogMergeJobRow,
  db: DatabaseOrTransaction,
): Promise<PhaseOutcome> {
  let moved = 0;
  for (const target of targetsForPhase(job.entityType, 'reviews')) {
    moved += await applyRehomeTarget(target, job.loserId, job.winnerId, db);
  }
  if (job.entityType === 'canonical_product' || job.entityType === 'merchant') {
    const scope = job.entityType === 'canonical_product' ? 'product' : 'merchant';
    await recordReviewsRetainedByMerge(scope, job.loserId, db);
  }
  return { rowsAffected: moved };
}

/**
 * `redirects` — mint the alias, flatten the chain and stamp the tombstone.
 *
 * The ORDER inside is load-bearing: the tombstones pointing at the loser are
 * captured and retargeted BEFORE the loser itself is stamped, because
 * retargeting reads `merged_into_id = loser` and stamping the loser would put
 * the loser into its own result set.
 */
async function runRedirectPhase(
  job: CatalogMergeJobRow,
  db: DatabaseOrTransaction,
): Promise<PhaseOutcome> {
  const definition = CURATED_ENTITIES[job.entityType];
  const loser = await requireEntity(job.entityType, job.loserId, db);
  let affected = 0;

  // 1. The FORMER NAME alias, so search still finds the losing identity by the
  //    name it had (ADR 0002 D16's worked example). `ON CONFLICT DO NOTHING`:
  //    the winner may already answer that name.
  if (loser.name && loser.name.trim() !== '') {
    await db
      .insert(definition.aliasTable)
      .values({
        [definition.aliasEntityColumn.name]: job.winnerId,
        alias: loser.name,
        kind: 'former_name',
        createdByOxyUserId: job.requestedByOxyUserId,
      })
      .onConflictDoNothing();
    affected += 1;
  }

  // 2. The redirect HISTORY, where the entity has one. `merged_into_id` answers
  //    "where does this point now"; only these rows answer "where did it point
  //    before", because flattening overwrites the column.
  if (definition.redirectTable && definition.redirectFromColumn && definition.redirectToColumn) {
    const tombstones = await db
      .select({ id: sql<string>`${definition.idColumn}` })
      .from(definition.table)
      .where(eq(definition.mergedIntoColumn, job.loserId));
    await db
      .insert(definition.redirectTable)
      .values({
        [definition.redirectFromColumn.name]: job.loserId,
        [definition.redirectToColumn.name]: job.winnerId,
        reason: 'merge',
        actorOxyUserId: job.requestedByOxyUserId,
      })
      .onConflictDoNothing();
    affected += 1;
    for (const tombstone of tombstones) {
      if (tombstone.id === job.winnerId) continue;
      await db
        .insert(definition.redirectTable)
        .values({
          [definition.redirectFromColumn.name]: tombstone.id,
          [definition.redirectToColumn.name]: job.winnerId,
          reason: 'flatten',
          actorOxyUserId: job.requestedByOxyUserId,
        })
        .onConflictDoNothing();
      affected += 1;
    }
  }

  // 3. The flattening itself, then the tombstone. Both are plan targets, so
  //    they go through the same executor everything else does.
  for (const target of targetsForPhase(job.entityType, 'redirects')) {
    affected += await applyRehomeTarget(target, job.loserId, job.winnerId, db);
  }

  // 4. The tombstone. A CAS on "not already merged", so a resumed phase stamps
  //    nothing and a concurrent duplicate loses here having written nothing.
  const stamped = await db
    .update(definition.table)
    .set({ status: 'merged', mergedIntoId: job.winnerId })
    .where(and(eq(definition.idColumn, job.loserId), sql`${definition.mergedIntoColumn} is null`))
    .returning({ id: definition.idColumn });
  affected += stamped.length;

  await recordRevision(
    {
      entityType: job.entityType,
      entityId: job.loserId,
      action: 'redirect',
      actorKind: 'operator',
      actorOxyUserId: job.requestedByOxyUserId,
      reason: job.reason,
      note: `tombstoned into ${job.winnerId}`,
      mergeJobId: job.id,
      after: { mergedIntoId: job.winnerId },
    },
    db,
  );
  return { rowsAffected: affected };
}

/**
 * `verify` — the final consistency check (#59 merge invariant 7).
 *
 * It RE-RUNS every mutating plan target and asserts that nothing moved. That is
 * simultaneously the verification (no child is still pointing at the loser that
 * could have moved) and the idempotency proof (a completed merge re-executed
 * changes nothing), and it needs no second description of the plan to drift from
 * the first.
 */
async function runVerifyPhase(
  job: CatalogMergeJobRow,
  db: DatabaseOrTransaction,
): Promise<PhaseOutcome> {
  let residual = 0;
  for (const target of MERGE_REHOMING_PLAN[job.entityType]) {
    residual += await applyRehomeTarget(target, job.loserId, job.winnerId, db);
  }
  // The declared ARRAY rehomings too (#716), for the reason the plan targets are
  // re-run: an entry whose statement is not idempotent is exactly what this
  // phase exists to catch, and an array move that de-duplicates is the shape
  // most likely to move a row twice.
  for (const phase of CATALOG_MERGE_PHASES) {
    residual += await applyPhaseArrayRehomings(job, phase, db);
  }
  if (residual > 0) {
    throw new Error(
      `Merge job ${job.id} failed its consistency check: ${residual} row(s) were still pointing ` +
        'at the loser after every phase reported complete. The job stays claimable and will ' +
        'converge on the next run; a residual that persists is a plan entry whose statement is ' +
        'not idempotent.',
    );
  }
  const loser = await requireEntity(job.entityType, job.loserId, db);
  if (loser.status !== 'merged' || loser.mergedIntoId !== job.winnerId) {
    throw new Error(
      `Merge job ${job.id} failed its consistency check: the loser is ${loser.status} pointing at ` +
        `${loser.mergedIntoId ?? 'nothing'}, not merged into ${job.winnerId}.`,
    );
  }
  return { rowsAffected: 0 };
}

/**
 * Dispatch one phase to the code that owns it.
 *
 * The return type is the RESOLUTION outcome because exactly one branch can
 * block. Every other runner is declared `Promise<PhaseOutcome>`, so widening
 * this signature is not what admits a second blocking phase — teaching
 * {@link mergeJobBlockingState} how that phase's condition clears is.
 */
/**
 * The ARRAY rehomings this phase owes (#716), run for whichever runner owns it.
 *
 * Called from {@link runPhase} rather than from inside each phase runner, and
 * that placement is the point: an array target declares its own phase, so
 * putting the call in the four bespoke runners would mean a future declaration
 * naming a fifth phase silently doing nothing — the exact shape of the defect
 * this fixes, one level up. Here every phase passes through one line.
 */
async function applyPhaseArrayRehomings(
  job: CatalogMergeJobRow,
  phase: CatalogMergePhase,
  db: DatabaseOrTransaction,
): Promise<number> {
  let moved = 0;
  for (const rehome of bareArrayRehomesFor(job.entityType, phase)) {
    moved += await applyBareArrayRehome(rehome, job.loserId, job.winnerId, db);
  }
  return moved;
}

async function runPhase(
  job: CatalogMergeJobRow,
  phase: CatalogMergePhase,
  db: DatabaseOrTransaction,
): Promise<ResolutionPhaseOutcome> {
  if (phase === 'plan') return runPlanPhase(job, db);
  if (phase === 'awaiting_resolution') return runResolutionPhase(job, db);
  if (phase === 'verify') return runVerifyPhase(job, db);

  const arrays = await applyPhaseArrayRehomings(job, phase, db);
  const outcome = await runPhaseBody(job, phase, db);
  return { ...outcome, rowsAffected: outcome.rowsAffected + arrays };
}

async function runPhaseBody(
  job: CatalogMergeJobRow,
  phase: CatalogMergePhase,
  db: DatabaseOrTransaction,
): Promise<ResolutionPhaseOutcome> {
  if (REHOMING_PHASES.includes(phase)) return runRehomingPhase(job, phase, db);
  if (phase === 'reviews') return runReviewsPhase(job, db);
  if (phase === 'alerts') return runAlertsPhase(job, db);
  if (phase === 'agents') return runAgentsPhase(job, db);
  if (phase === 'redirects') return runRedirectPhase(job, db);
  if (phase === 'rollups') {
    return { rowsAffected: await rebuildEntityRollups(job.entityType, job.loserId, job.winnerId, db) };
  }
  return { rowsAffected: 0 };
}

export interface RunMergeJobResult {
  readonly jobId: string;
  readonly finalPhase: CatalogMergePhase;
  readonly completed: boolean;
  readonly blocked: boolean;
  readonly rowsAffected: number;
}

/**
 * Run a CLAIMED job from wherever it is to wherever it can get.
 *
 * Each phase runs in its OWN transaction, deliberately. One transaction over
 * the whole merge would be simpler to reason about and strictly worse in
 * practice: a merge of a large entity holds row locks on offers, reviews and
 * relationships for the duration, and a failure at `rollups` would roll back
 * eleven phases of work that were all correct. Per-phase transactions make the
 * unit of retry the unit of work, which is what the phase records already
 * assume.
 */
export async function runMergeJob(
  jobId: string,
  leaseOwner: string,
): Promise<RunMergeJobResult> {
  const db = getDb();
  let job = await findMergeJobById(jobId, db);
  if (!job) throw notFound(`No merge job ${jobId}.`);
  let totalRows = 0;

  for (;;) {
    const phase = job.phase;
    if (phase === 'done') break;

    const claim = await claimMergePhase(job.id, phase, db);
    if (!claim.alreadyComplete) {
      const outcome = await db.transaction(async (tx) => runPhase(job, phase, tx));
      if (outcome.blockedReason) {
        await blockMergeJob(job.id, leaseOwner, outcome.blockedReason, db);
        log.general.info(
          { jobId: job.id, phase, reason: outcome.blockedReason },
          '[Curation] merge job blocked on an operator decision',
        );
        return {
          jobId: job.id,
          finalPhase: phase,
          completed: false,
          blocked: true,
          rowsAffected: totalRows,
        };
      }
      totalRows += outcome.rowsAffected;
      await completeMergePhase(job.id, phase, outcome.rowsAffected, db);
      if (phase === 'rollups') {
        // AFTER the phase transaction commits. #76's aggregate rebuild opens its
        // own connection and writes the same row the transaction locked, so
        // calling it from inside deadlocks the merge against itself — see
        // `rebuildEntityAggregates`.
        await rebuildEntityAggregates(job.entityType, job.loserId, job.winnerId);
      }
    }

    const next = nextMergePhase(phase);
    if (!next) break;
    if (!(await advanceMergePhase(job.id, leaseOwner, next, db))) {
      // The lease was reclaimed mid-run. Discarding our own outcome is the
      // correct answer: another worker owns this job now, and every phase we
      // completed is already recorded for it to skip.
      return {
        jobId: job.id,
        finalPhase: phase,
        completed: false,
        blocked: false,
        rowsAffected: totalRows,
      };
    }
    const refreshed = await findMergeJobById(job.id, db);
    if (!refreshed) break;
    job = refreshed;
  }

  const completed = await completeMergeJob(job.id, leaseOwner, db);
  return {
    jobId: job.id,
    finalPhase: 'done',
    completed,
    blocked: false,
    rowsAffected: totalRows,
  };
}

/** The phase list, exported so the operator projection can show progress. */
export const MERGE_PHASE_ORDER: readonly CatalogMergePhase[] = CATALOG_MERGE_PHASES;

/** A merge's impact as the projection reports it. */
export type MergeImpact = CatalogImpactEstimate;
