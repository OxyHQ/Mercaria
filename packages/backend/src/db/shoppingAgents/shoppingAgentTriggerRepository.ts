/**
 * `shopping_agent_triggers` — the durable TRIGGER queue, ONE row per canonical
 * product (#97 evaluation 1, cost 2).
 *
 * `offer_outboxes`' shape by way of #79's evaluation queue, and every difference
 * from it is stated where it happens. Three properties are worth reading before
 * touching this file.
 *
 * ## The enqueue writes NOTHING when nobody is watching
 *
 * {@link requestShoppingAgentTrigger} runs on EVERY offer write in the system —
 * the hottest path there is — so its first statement is a GATE: one indexed
 * `exists` over `shopping_agent_lines` joined to its agents, which resolves the
 * offer's canonical PRODUCT in the same statement. A catalogue nobody has an
 * agent on therefore costs exactly that one predicate and writes no row at all;
 * only a watched product reaches the upsert. `shopping_agent_lines_subject_idx`
 * is what serves it.
 *
 * ## It CONVERGES, so a popular product owes one fan-out
 *
 * `ON CONFLICT DO UPDATE` bumping `requested_revision`, not `DO NOTHING`: a
 * trigger delivers a FIXED POINT ("whatever the offers look like when you run,
 * fan out against that"), so forty offer writes in one second owe ONE fan-out.
 * `DO NOTHING` would silently drop the thirty-nine that arrived while one was
 * pending, including the one that crossed somebody's target.
 *
 * The `set` references the EXISTING row and never `excluded`, and it must NOT
 * write a flat `'pending'` over a `processing` row — that releases a live lease
 * from outside the worker holding it, which #57's realdb case fails on.
 *
 * ## The counter is what makes a VACUOUS fan-out visible
 *
 * `last_fanned_out_agents` at zero on a product several agents watch is a broken
 * read, and a table of evaluations can only ever show the fan-outs that produced
 * one — #60's `scannedFromRecords` device at a smaller grain.
 */

import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';
import { shoppingAgentLines, shoppingAgentTriggers, shoppingAgents } from '../schema/shoppingAgents.js';

export type ShoppingAgentTriggerRow = typeof shoppingAgentTriggers.$inferSelect;

/** How long a coded failure may be. Bounded so a message cannot become a payload. */
const MAX_FAILURE_LENGTH = 200;

/**
 * Ask for one canonical PRODUCT's agents to be fanned out, because an offer on it
 * changed.
 *
 * Takes the offer's canonical VARIANT, which is what the offer write chokepoints
 * hold, and resolves the product in the same statement — an extra round trip on
 * every offer write to fetch a column a join already reaches would be the cost of
 * a nicer signature.
 *
 * Takes an optional transaction handle rather than requiring one: a caller inside
 * a transaction should pass it so a rolled-back offer write leaves no job, and
 * the enqueue reads live state when it runs either way.
 *
 * @returns whether a row was written or bumped — `false` means nobody is watching
 * this product, which is the ordinary case and not a failure.
 */
export async function requestShoppingAgentTrigger(
  canonicalVariantId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  /**
   * The GATE and the product resolution in ONE statement, and the enqueue only
   * when it answers.
   *
   * `exists` rather than a join to the agents themselves: the question is whether
   * ANY enabled agent watches this product, and a join would read every one of
   * them on a popular product to answer a boolean.
   */
  const gate = await db
    .select({ canonicalProductId: canonicalVariants.productId })
    .from(canonicalVariants)
    .where(
      and(
        eq(canonicalVariants.id, canonicalVariantId),
        sql`exists (
          select 1 from ${shoppingAgentLines}
          join ${shoppingAgents} on ${shoppingAgents.id} = ${shoppingAgentLines.agentId}
          where ${shoppingAgentLines.canonicalProductId} = ${canonicalVariants.productId}
            and ${shoppingAgents.state} = 'enabled'
        )`,
      ),
    )
    .limit(1);

  const canonicalProductId = gate[0]?.canonicalProductId;
  if (!canonicalProductId) return false;

  await requestShoppingAgentTriggerForProduct(canonicalProductId, db, now);
  return true;
}

/**
 * Ask for one product directly — the operator's "run this now", and the path a
 * newly saved agent takes.
 *
 * Unconditional, unlike the offer-write enqueue: the caller already knows there
 * is something to fan out, and a fresh agent has to be answered against today's
 * offers rather than waiting for the next time a seller happens to change one.
 */
export async function requestShoppingAgentTriggerForProduct(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(shoppingAgentTriggers)
    .values({
      canonicalProductId,
      state: 'pending',
      requestedRevision: 1,
      attempts: 0,
      availableAt: now,
    })
    .onConflictDoUpdate({
      target: shoppingAgentTriggers.canonicalProductId,
      set: {
        requestedRevision: sql`${shoppingAgentTriggers.requestedRevision} + 1`,
        state: sql`case when ${shoppingAgentTriggers.state} = 'processing' then 'processing' else 'pending' end`,
        attempts: 0,
        availableAt: now,
        lastFailure: null,
      },
    });
}

/**
 * Atomically claim due triggers.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` inside the `UPDATE`, so N tasks drain the
 * queue without handing each other the same row, and an expired `processing`
 * lease is reclaimable so a task that died mid-fan-out strands nothing.
 */
export async function claimShoppingAgentTriggers(
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentTriggerRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs);
  const batchSize = Math.max(1, options.batchSize);

  const due = or(
    and(eq(shoppingAgentTriggers.state, 'pending'), lte(shoppingAgentTriggers.availableAt, now)),
    and(eq(shoppingAgentTriggers.state, 'processing'), lte(shoppingAgentTriggers.leaseUntil, now)),
  );

  return db
    .update(shoppingAgentTriggers)
    .set({
      state: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      claimedRevision: sql`${shoppingAgentTriggers.requestedRevision}`,
      attempts: sql`${shoppingAgentTriggers.attempts} + 1`,
      lastFailure: null,
    })
    .where(
      sql`${shoppingAgentTriggers.id} in (
        select ${shoppingAgentTriggers.id} from ${shoppingAgentTriggers}
        where ${due}
        order by ${asc(shoppingAgentTriggers.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/** Only the lease this worker currently owns matches. */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(shoppingAgentTriggers.id, id),
    eq(shoppingAgentTriggers.state, 'processing'),
    eq(shoppingAgentTriggers.leaseOwner, leaseOwner),
    gt(shoppingAgentTriggers.leaseUntil, now),
  );
}

/**
 * Finish a claim, recording how many agents the fan-out actually reached.
 *
 * The counter is the VACUITY floor: a product several agents watch reporting zero
 * fanned out is a broken read, and the evaluation queue can only ever show the
 * fan-outs that produced a row.
 *
 * The state is a CASE on the two revisions, so an offer write that arrived DURING
 * the run leaves the row pending rather than being swallowed by the completion
 * that follows it.
 *
 * @returns `true` when this worker still owned the lease.
 */
export async function completeShoppingAgentTrigger(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly fannedOutAgents: number;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(shoppingAgentTriggers)
    .set({
      state: sql`case when ${shoppingAgentTriggers.requestedRevision} > coalesce(${shoppingAgentTriggers.claimedRevision}, 0)
                      then 'pending' else 'done' end`,
      lastFannedOutAt: now,
      lastFannedOutAgents: input.fannedOutAgents,
      availableAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastFailure: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: shoppingAgentTriggers.id });
  return rows.length === 1;
}

/**
 * Release a failed claim with backoff — or stop, VISIBLY.
 *
 * `deadLettered` is the CALLER's decision, the moderation outbox's rule: only the
 * service knows whether the failure was retryable. A dead letter here means the
 * agents watching that product stop being fanned out until an operator drives
 * one, which is why the metrics below report the dead-letter count.
 *
 * `failure` is sliced to a bounded length. It is a coded reason and never an
 * exception message: a message carries whatever the failure happened to be
 * holding, and this column is read by an operator surface.
 */
export async function releaseShoppingAgentTrigger(
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
    .update(shoppingAgentTriggers)
    .set({
      state: input.deadLettered ? 'dead_letter' : 'pending',
      availableAt: input.availableAt,
      lastFailure: input.failure.slice(0, MAX_FAILURE_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: shoppingAgentTriggers.id });
  return rows.length === 1;
}

/** One subject's queue row — the operator trace's read. */
export async function findShoppingAgentTriggerForProduct(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentTriggerRow | undefined> {
  const rows = await db
    .select()
    .from(shoppingAgentTriggers)
    .where(eq(shoppingAgentTriggers.canonicalProductId, canonicalProductId))
    .limit(1);
  return rows[0];
}

/**
 * The queue's health — how much is outstanding, and WHEN the oldest outstanding
 * row became due.
 *
 * `oldestPendingAvailableAt` is ABSENT rather than a zero age when nothing is
 * outstanding, so an idle dispatcher and a stalled one are distinguishable —
 * reporting a zero would make the one number an operator watches read healthiest
 * exactly when the loop has stopped. It is the INSTANT rather than an age
 * because this file has no clock to measure against: the metrics surface has
 * one, and a repository inventing a second would be a second answer to what
 * "now" is.
 */
export async function readShoppingAgentTriggerSummary(
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  pending: number;
  processing: number;
  done: number;
  deadLetter: number;
  oldestPendingAvailableAt?: Date;
}> {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${shoppingAgentTriggers.state} = 'pending')::int`,
      processing: sql<number>`count(*) filter (where ${shoppingAgentTriggers.state} = 'processing')::int`,
      done: sql<number>`count(*) filter (where ${shoppingAgentTriggers.state} = 'done')::int`,
      deadLetter: sql<number>`count(*) filter (where ${shoppingAgentTriggers.state} = 'dead_letter')::int`,
      oldestPending: sql<
        Date | null
      >`min(${shoppingAgentTriggers.availableAt}) filter (where ${shoppingAgentTriggers.state} = 'pending')`,
    })
    .from(shoppingAgentTriggers);
  const row = rows[0];
  const oldest = row?.oldestPending;
  return {
    pending: row?.pending ?? 0,
    processing: row?.processing ?? 0,
    done: row?.done ?? 0,
    deadLetter: row?.deadLetter ?? 0,
    ...(oldest ? { oldestPendingAvailableAt: new Date(oldest) } : {}),
  };
}
