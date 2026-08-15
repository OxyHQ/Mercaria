/**
 * `shopping_agent_evaluations` — the durable EVALUATION queue, ONE row per agent
 * (#97 evaluation 1, 2).
 *
 * The second of the two durable jobs. `shopping_agent_triggers` asks "which
 * agents care about this product"; this one asks "what does THIS agent's whole
 * objective look like now", which is why the two are keyed differently and why
 * neither is derivable from the other: forty offer writes on one popular product
 * owe one fan-out, and that fan-out owes one evaluation to each agent watching
 * it.
 *
 * ## It CONVERGES, for the same reason the trigger queue does
 *
 * `ON CONFLICT DO UPDATE` bumping `requested_revision`, not `DO NOTHING`: an
 * evaluation reads the WHOLE objective and its answer is a fixed point, so three
 * products of a five-line agent moving in one minute owe ONE run. `DO NOTHING`
 * would drop the two that arrived while one was pending, including the one that
 * crossed the shopper's target.
 *
 * The `set` references the EXISTING row and never `excluded`, and it must NOT
 * write a flat `'pending'` over a `processing` row — that releases a live lease
 * from outside the worker holding it.
 *
 * ## `trigger_source` is the MOST RECENT request's, and it is carried forward
 *
 * A scheduled sweep and an offer change can both ask for one agent before either
 * runs. The row keeps the latest, which is what "why did this run" answers on the
 * finding it produces — and the alternative, keeping the first, would answer with
 * a reason that stopped being the reason.
 */

import { and, asc, eq, gt, isNotNull, lte, or, sql } from 'drizzle-orm';
import type {
  ShoppingAgentFindingOutcome,
  ShoppingAgentTriggerSource,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { shoppingAgentEvaluations, shoppingAgents } from '../schema/shoppingAgents.js';

export type ShoppingAgentEvaluationRow = typeof shoppingAgentEvaluations.$inferSelect;

/** How long a coded failure may be. Bounded so a message cannot become a payload. */
const MAX_FAILURE_LENGTH = 200;

/** What the scheduled sweep needs, and nothing else. See {@link listDueScheduledAgents}. */
export interface DueScheduledAgentRow {
  readonly id: string;
  readonly scheduleIntervalSeconds: number | null;
  readonly nextScheduledAt: Date | null;
}

/**
 * Ask for one agent to be re-evaluated.
 *
 * Unconditional: every caller — the fan-out, the scheduled sweep, a fresh save,
 * an operator's "run this now" — already knows there is an agent to answer, so
 * there is no gate to apply. The gate that matters lives one queue up, where an
 * offer write on a catalogue nobody watches writes nothing at all.
 *
 * Takes an optional transaction handle: a caller inside one should pass it, so an
 * enqueue rolled back with its own write leaves no job behind.
 */
export async function requestShoppingAgentEvaluation(
  input: {
    readonly agentId: string;
    readonly triggerSource: ShoppingAgentTriggerSource;
  },
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(shoppingAgentEvaluations)
    .values({
      agentId: input.agentId,
      triggerSource: input.triggerSource,
      state: 'pending',
      requestedRevision: 1,
      attempts: 0,
      availableAt: now,
    })
    .onConflictDoUpdate({
      target: shoppingAgentEvaluations.agentId,
      set: {
        triggerSource: input.triggerSource,
        requestedRevision: sql`${shoppingAgentEvaluations.requestedRevision} + 1`,
        state: sql`case when ${shoppingAgentEvaluations.state} = 'processing' then 'processing' else 'pending' end`,
        attempts: 0,
        availableAt: now,
        lastFailure: null,
      },
    });
}

/**
 * Atomically claim due evaluations.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` inside the `UPDATE`, so N tasks drain the
 * queue without handing each other the same row, and an expired `processing`
 * lease is reclaimable so a task that died mid-evaluation strands nothing.
 */
export async function claimShoppingAgentEvaluations(
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentEvaluationRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs);
  const batchSize = Math.max(1, options.batchSize);

  const due = or(
    and(
      eq(shoppingAgentEvaluations.state, 'pending'),
      lte(shoppingAgentEvaluations.availableAt, now),
    ),
    and(
      eq(shoppingAgentEvaluations.state, 'processing'),
      lte(shoppingAgentEvaluations.leaseUntil, now),
    ),
  );

  return db
    .update(shoppingAgentEvaluations)
    .set({
      state: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      claimedRevision: sql`${shoppingAgentEvaluations.requestedRevision}`,
      attempts: sql`${shoppingAgentEvaluations.attempts} + 1`,
      lastFailure: null,
    })
    .where(
      sql`${shoppingAgentEvaluations.id} in (
        select ${shoppingAgentEvaluations.id} from ${shoppingAgentEvaluations}
        where ${due}
        order by ${asc(shoppingAgentEvaluations.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/** Only the lease this worker currently owns matches. */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(shoppingAgentEvaluations.id, id),
    eq(shoppingAgentEvaluations.state, 'processing'),
    eq(shoppingAgentEvaluations.leaseOwner, leaseOwner),
    gt(shoppingAgentEvaluations.leaseUntil, now),
  );
}

/**
 * Finish a claim, recording what the run concluded.
 *
 * `outcome` is the run's own verdict and is stored so the queue can answer "what
 * happened last time" without reading a finding — which matters because an
 * `incomplete` run and a run that never happened look identical from a table of
 * findings that only records what qualified.
 *
 * It is OPTIONAL because a claim can legitimately finish without reaching one: an
 * agent deleted or paused between the enqueue and the claim is a job that
 * completed and evaluated nothing. Absent leaves `last_outcome` ALONE rather than
 * writing NULL — nulling it would erase the previous run's real verdict and make
 * an agent that has been answered indistinguishable from one that never has,
 * which is the one distinction this column exists for.
 *
 * The state is a CASE on the two revisions, so a request that arrived DURING the
 * run leaves the row pending rather than being swallowed by the completion that
 * follows it.
 *
 * @returns `true` when this worker still owned the lease.
 */
export async function completeShoppingAgentEvaluation(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly outcome?: ShoppingAgentFindingOutcome;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(shoppingAgentEvaluations)
    .set({
      state: sql`case when ${shoppingAgentEvaluations.requestedRevision} > coalesce(${shoppingAgentEvaluations.claimedRevision}, 0)
                      then 'pending' else 'done' end`,
      lastEvaluatedAt: now,
      ...(input.outcome === undefined ? {} : { lastOutcome: input.outcome }),
      availableAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastFailure: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: shoppingAgentEvaluations.id });
  return rows.length === 1;
}

/**
 * Release a failed claim with backoff — or stop, VISIBLY.
 *
 * `deadLettered` is the CALLER's decision, the moderation outbox's rule: only the
 * service knows whether the failure was retryable. A dead letter here means one
 * shopper's agent stops being evaluated until somebody drives a run, which is why
 * it is a visible state and a counted one rather than a silent stall.
 *
 * `failure` is a bounded coded reason and never an exception message: a message
 * carries whatever the failure happened to be holding, and this column is read by
 * an operator surface.
 */
export async function releaseShoppingAgentEvaluation(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly deadLettered: boolean;
    readonly availableAt: Date;
    readonly failure: string;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(shoppingAgentEvaluations)
    .set({
      state: input.deadLettered ? 'dead_letter' : 'pending',
      availableAt: input.availableAt,
      lastFailure: input.failure.slice(0, MAX_FAILURE_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: shoppingAgentEvaluations.id });
  return rows.length === 1;
}

/** One agent's queue row — the operator trace's read. */
export async function findShoppingAgentEvaluationForAgent(
  agentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentEvaluationRow | undefined> {
  const rows = await db
    .select()
    .from(shoppingAgentEvaluations)
    .where(eq(shoppingAgentEvaluations.agentId, agentId))
    .limit(1);
  return rows[0];
}

/**
 * The agents whose own schedule has come due — the scheduled sweep's read.
 *
 * The predicate is written to MATCH `shopping_agents_schedule_idx`'s own partial
 * `WHERE state = 'enabled' and next_scheduled_at is not null`, so the sweep reads
 * an index the size of the live scheduled set rather than of the table. Widening
 * either half here silently costs a sequential scan on the largest table in the
 * domain, and nothing would report it.
 *
 * `ambiguity_state` is not checked because it cannot need to be: an ambiguous
 * agent is `blocked` by CHECK and therefore not `enabled`.
 *
 * Three named columns rather than a whole row: a sweep enqueues an evaluation and
 * computes the next instant from the interval, and it has no business holding a
 * shopper's constraints or their private description while it does so.
 */
export async function listDueScheduledAgents(
  limit: number,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<DueScheduledAgentRow[]> {
  return db
    .select({
      id: shoppingAgents.id,
      scheduleIntervalSeconds: shoppingAgents.scheduleIntervalSeconds,
      nextScheduledAt: shoppingAgents.nextScheduledAt,
    })
    .from(shoppingAgents)
    .where(
      and(
        eq(shoppingAgents.state, 'enabled'),
        isNotNull(shoppingAgents.nextScheduledAt),
        lte(shoppingAgents.nextScheduledAt, now),
      ),
    )
    .orderBy(asc(shoppingAgents.nextScheduledAt), asc(shoppingAgents.id))
    .limit(limit);
}

/**
 * The queue's health — how much is outstanding, WHEN the oldest outstanding row
 * became due, and what the last completed runs concluded.
 *
 * `oldestPendingAvailableAt` is ABSENT rather than a zero age when nothing is
 * outstanding, so an idle dispatcher and a stalled one are distinguishable, and
 * it is the INSTANT rather than an age because this file has no clock to measure
 * against — the metrics surface has one.
 *
 * The outcome counters are the answer to "is this domain telling anybody
 * anything": a fleet of runs that all conclude `incomplete` is a working queue
 * and a broken feature, and a queue summary without them reads as perfect health.
 */
export async function readShoppingAgentEvaluationSummary(
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  pending: number;
  processing: number;
  done: number;
  deadLetter: number;
  qualified: number;
  notQualified: number;
  incomplete: number;
  oldestPendingAvailableAt?: Date;
}> {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${shoppingAgentEvaluations.state} = 'pending')::int`,
      processing: sql<number>`count(*) filter (where ${shoppingAgentEvaluations.state} = 'processing')::int`,
      done: sql<number>`count(*) filter (where ${shoppingAgentEvaluations.state} = 'done')::int`,
      deadLetter: sql<number>`count(*) filter (where ${shoppingAgentEvaluations.state} = 'dead_letter')::int`,
      qualified: sql<number>`count(*) filter (where ${shoppingAgentEvaluations.lastOutcome} = 'qualified')::int`,
      notQualified: sql<number>`count(*) filter (where ${shoppingAgentEvaluations.lastOutcome} = 'not_qualified')::int`,
      incomplete: sql<number>`count(*) filter (where ${shoppingAgentEvaluations.lastOutcome} = 'incomplete')::int`,
      oldestPending: sql<
        Date | null
      >`min(${shoppingAgentEvaluations.availableAt}) filter (where ${shoppingAgentEvaluations.state} = 'pending')`,
    })
    .from(shoppingAgentEvaluations);
  const row = rows[0];
  const oldest = row?.oldestPending;
  return {
    pending: row?.pending ?? 0,
    processing: row?.processing ?? 0,
    done: row?.done ?? 0,
    deadLetter: row?.deadLetter ?? 0,
    qualified: row?.qualified ?? 0,
    notQualified: row?.notQualified ?? 0,
    incomplete: row?.incomplete ?? 0,
    ...(oldest ? { oldestPendingAvailableAt: new Date(oldest) } : {}),
  };
}
