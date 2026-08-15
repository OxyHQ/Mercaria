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
  listUnappliedConflicts,
  markConflictApplied,
  resolveConflict,
  unblockMergeJob,
} from '../../db/curation/jobRepository.js';
import { applyRehomeTarget } from '../../db/curation/rehomeRepository.js';
import { stampPriceAlertRehoming } from '../../db/priceAlerts/priceAlertRepository.js';
import { requestPriceAlertEvaluationForProduct } from '../../db/priceAlerts/priceAlertEvaluationRepository.js';
import { stampShoppingAgentRehoming } from '../../db/shoppingAgents/shoppingAgentRepository.js';
import { requestShoppingAgentTriggerForProduct } from '../../db/shoppingAgents/shoppingAgentTriggerRepository.js';
import type { CatalogMergeJobRow } from '../../db/schema/curation.js';
import { estimateMergeImpact, impactColumnValues } from './impact.js';
import { CURATED_ENTITIES } from './entity-registry.js';
import { MERGE_REHOMING_PLAN, targetsForPhase } from './merge-plan.js';
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
  'reviews',
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
 * - and a second live job for the same loser, which the partial unique refuses
 *   anyway — this read just turns a `23505` into a sentence.
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

  // A blocked job becomes claimable again once nothing is undecided. Checking
  // here rather than on a timer is what makes the operator's decision the thing
  // that restarts the job.
  if ((await countUnresolvedConflicts(job.id, db)) === 0) {
    await unblockMergeJob(job.id, db);
  }
  return { resolved: true, childJobId };
}

/** One phase's outcome, so the runner can record rows moved and decide the next step. */
interface PhaseOutcome {
  readonly rowsAffected: number;
  /** Set when the phase cannot proceed and the job must wait on a person. */
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
): Promise<PhaseOutcome> {
  const unresolved = await countUnresolvedConflicts(job.id, db);
  if (unresolved > 0) {
    return {
      rowsAffected: 0,
      blockedReason: `${unresolved} conflict(s) await an explicit decision before this merge may commit.`,
    };
  }
  if (job.requiresSecondApproval && !job.approvedByOxyUserId) {
    return {
      rowsAffected: 0,
      blockedReason:
        `This merge moves ${job.impactTotalMoving} rows and needs a second operator's approval.`,
    };
  }

  const pending = await listUnappliedConflicts(job.id, db);
  let applied = 0;
  for (const row of pending) {
    if (row.resolution === 'merge_pair') {
      // The pair is merged by a CHILD job. Waiting for it here rather than
      // applying anything is what keeps the parent from repointing a variant
      // whose signature twin has not yet become a tombstone.
      const child = row.childJobId ? await findMergeJobById(row.childJobId, db) : undefined;
      if (!child || child.status !== 'completed') {
        return {
          rowsAffected: applied,
          blockedReason: `Child merge job ${row.childJobId ?? '(missing)'} must complete first.`,
        };
      }
    } else {
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
  if (moved > 0) {
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

/** Dispatch one phase to the code that owns it. */
async function runPhase(
  job: CatalogMergeJobRow,
  phase: CatalogMergePhase,
  db: DatabaseOrTransaction,
): Promise<PhaseOutcome> {
  if (phase === 'plan') return runPlanPhase(job, db);
  if (phase === 'awaiting_resolution') return runResolutionPhase(job, db);
  if (REHOMING_PHASES.includes(phase)) return runRehomingPhase(job, phase, db);
  if (phase === 'alerts') return runAlertsPhase(job, db);
  if (phase === 'agents') return runAgentsPhase(job, db);
  if (phase === 'redirects') return runRedirectPhase(job, db);
  if (phase === 'rollups') {
    return { rowsAffected: await rebuildEntityRollups(job.entityType, job.loserId, job.winnerId, db) };
  }
  if (phase === 'verify') return runVerifyPhase(job, db);
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
