/**
 * `price_alert_evaluations` — the durable evaluation queue (#79 evaluation 1).
 *
 * `offer_outboxes`' shape, and every difference from it is stated where it
 * happens. The two properties worth reading before touching this file:
 *
 * ## The enqueue writes NOTHING when nobody is watching
 *
 * {@link requestPriceAlertEvaluation} runs on EVERY offer write in the system —
 * the hottest path there is — so its first statement is a GATE: one indexed
 * `exists` against `price_alerts` for the offer's product, which resolves the
 * product id at the same time. A catalogue nobody has an alert on therefore
 * costs exactly that one predicate and writes no row at all; only a watched
 * product reaches the upsert. `price_alerts_subject_idx` is what serves it.
 *
 * ## It CONVERGES, so a popular product owes one evaluation
 *
 * `ON CONFLICT DO UPDATE` bumping `requested_revision`, not `DO NOTHING`: an
 * evaluation delivers a FIXED POINT ("whatever the offers look like when you
 * run, decide against that"), so forty writes in a second owe ONE run. That is
 * issue abuse rule 2's batch fan-out expressed as an enqueue. `DO NOTHING` would
 * silently drop the thirty-nine that arrived while one was pending, including
 * the one that crossed somebody's target.
 *
 * The `set` references the EXISTING row and never `excluded`, and it must not
 * write a flat `'pending'` over a `processing` row — both for the reasons
 * `enqueueOfferConvergence` records, both measured there.
 */

import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';
import { priceAlertEvaluations, priceAlerts } from '../schema/priceAlerts.js';

export type PriceAlertEvaluationRow = typeof priceAlertEvaluations.$inferSelect;

/** How long a coded failure may be. Bounded so a message cannot become a payload. */
const MAX_FAILURE_LENGTH = 200;

/**
 * Ask for one canonical PRODUCT's alerts to be re-evaluated, because an offer
 * on it changed.
 *
 * Takes the offer's canonical VARIANT, which is what the two write chokepoints
 * hold, and resolves the product in the same statement — an extra round trip on
 * every offer write to fetch a column a join already reaches would be the cost
 * of a nicer signature.
 *
 * Takes an optional transaction handle rather than requiring one, and for
 * `enqueueOfferConvergence`'s reason: a caller inside a transaction should pass
 * it so a rolled-back write leaves no job, and the enqueue reads live state when
 * it runs either way.
 *
 * @returns whether a row was written or bumped — `false` means nobody is
 * watching this product, which is the ordinary case and not a failure.
 */
export async function requestPriceAlertEvaluation(
  canonicalVariantId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  /**
   * The GATE and the product resolution in ONE statement, and the enqueue only
   * when it answers.
   *
   * `exists` rather than a join to the alerts themselves: the question is
   * whether ANY alert watches this product, and a join would read every one of
   * them on a popular product to answer a boolean. The whole statement is served
   * by `canonical_variants_pkey` and `price_alerts_subject_idx`.
   */
  const gate = await db
    .select({ canonicalProductId: canonicalVariants.productId })
    .from(canonicalVariants)
    .where(
      and(
        eq(canonicalVariants.id, canonicalVariantId),
        sql`exists (
          select 1 from ${priceAlerts}
          where ${priceAlerts.canonicalProductId} = ${canonicalVariants.productId}
            and ${priceAlerts.state} = 'enabled'
        )`,
      ),
    )
    .limit(1);

  const canonicalProductId = gate[0]?.canonicalProductId;
  if (!canonicalProductId) return false;

  await requestPriceAlertEvaluationForProduct(canonicalProductId, db, now);
  return true;
}

/**
 * Ask for one product directly — the operator's "evaluate this now", and the
 * path a newly created alert takes.
 *
 * Unconditional, unlike the offer-write enqueue: the caller already knows there
 * is something to evaluate, and a fresh alert has to be answered against
 * today's prices rather than waiting for the next time a seller happens to
 * change one.
 */
export async function requestPriceAlertEvaluationForProduct(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(priceAlertEvaluations)
    .values({
      canonicalProductId,
      state: 'pending',
      requestedRevision: 1,
      attempts: 0,
      availableAt: now,
    })
    .onConflictDoUpdate({
      target: priceAlertEvaluations.canonicalProductId,
      set: {
        requestedRevision: sql`${priceAlertEvaluations.requestedRevision} + 1`,
        state: sql`case when ${priceAlertEvaluations.state} = 'processing' then 'processing' else 'pending' end`,
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
export async function claimPriceAlertEvaluations(
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertEvaluationRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs);
  const batchSize = Math.max(1, options.batchSize);

  const due = or(
    and(eq(priceAlertEvaluations.state, 'pending'), lte(priceAlertEvaluations.availableAt, now)),
    and(eq(priceAlertEvaluations.state, 'processing'), lte(priceAlertEvaluations.leaseUntil, now)),
  );

  return db
    .update(priceAlertEvaluations)
    .set({
      state: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      claimedRevision: sql`${priceAlertEvaluations.requestedRevision}`,
      attempts: sql`${priceAlertEvaluations.attempts} + 1`,
      lastFailure: null,
    })
    .where(
      sql`${priceAlertEvaluations.id} in (
        select ${priceAlertEvaluations.id} from ${priceAlertEvaluations}
        where ${due}
        order by ${asc(priceAlertEvaluations.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/** Only the lease this worker currently owns matches. */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(priceAlertEvaluations.id, id),
    eq(priceAlertEvaluations.state, 'processing'),
    eq(priceAlertEvaluations.leaseOwner, leaseOwner),
    gt(priceAlertEvaluations.leaseUntil, now),
  );
}

/**
 * Finish a claim, recording what the run actually looked at.
 *
 * The counters are the VACUITY floor: a subject with forty alerts reporting
 * zero evaluated is a broken read, and a table of triggers can only ever show
 * the runs that produced one. The state is a CASE on the two revisions, so a
 * request that arrived DURING the run leaves the row pending rather than being
 * swallowed by the completion that follows it.
 *
 * @returns `true` when this worker still owned the lease.
 */
export async function completePriceAlertEvaluation(
  input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly evaluatedAlerts: number;
    readonly qualifiedAlerts: number;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(priceAlertEvaluations)
    .set({
      state: sql`case when ${priceAlertEvaluations.requestedRevision} > coalesce(${priceAlertEvaluations.claimedRevision}, 0)
                      then 'pending' else 'done' end`,
      lastEvaluatedAt: now,
      lastEvaluatedAlerts: input.evaluatedAlerts,
      lastQualifiedAlerts: input.qualifiedAlerts,
      availableAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastFailure: null,
    })
    .where(ownedLease(input.id, input.leaseOwner, now))
    .returning({ id: priceAlertEvaluations.id });
  return rows.length === 1;
}

/**
 * Release a failed claim with backoff — or stop, VISIBLY.
 *
 * `deadLettered` is the CALLER's decision, the moderation outbox's rule: only
 * the service knows whether the failure was retryable. A dead letter here means
 * the alerts on that product stop being re-evaluated until an operator drives
 * one — which is why the operator surface has a "evaluate this now" trigger and
 * the metrics report the dead-letter count.
 */
export async function releasePriceAlertEvaluation(
  options: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly deadLettered: boolean;
    readonly availableAt: Date;
    readonly failure: string;
    readonly now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(priceAlertEvaluations)
    .set({
      state: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastFailure: options.failure.slice(0, MAX_FAILURE_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.id, options.leaseOwner, now))
    .returning({ id: priceAlertEvaluations.id });
  return rows.length === 1;
}

/** One subject's queue row — the operator trace's read. */
export async function findPriceAlertEvaluationForProduct(
  canonicalProductId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertEvaluationRow | undefined> {
  const rows = await db
    .select()
    .from(priceAlertEvaluations)
    .where(eq(priceAlertEvaluations.canonicalProductId, canonicalProductId))
    .limit(1);
  return rows[0];
}

/**
 * The queue's health — issue operations 3's evaluation lag, from the QUEUE side.
 *
 * `oldestPendingAgeSeconds` is ABSENT rather than zero when nothing is
 * outstanding, so an idle evaluator and a stalled one are distinguishable.
 */
export async function summarizePriceAlertEvaluations(
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  pending: number;
  processing: number;
  done: number;
  deadLetter: number;
  oldestPendingAgeSeconds?: number;
}> {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${priceAlertEvaluations.state} = 'pending')::int`,
      processing: sql<number>`count(*) filter (where ${priceAlertEvaluations.state} = 'processing')::int`,
      done: sql<number>`count(*) filter (where ${priceAlertEvaluations.state} = 'done')::int`,
      deadLetter: sql<number>`count(*) filter (where ${priceAlertEvaluations.state} = 'dead_letter')::int`,
      oldestPending: sql<Date | null>`min(${priceAlertEvaluations.availableAt}) filter (where ${priceAlertEvaluations.state} = 'pending')`,
    })
    .from(priceAlertEvaluations);
  const row = rows[0];
  const oldest = row?.oldestPending;
  return {
    pending: row?.pending ?? 0,
    processing: row?.processing ?? 0,
    done: row?.done ?? 0,
    deadLetter: row?.deadLetter ?? 0,
    ...(oldest
      ? {
          oldestPendingAgeSeconds: Math.max(
            0,
            Math.floor((now.getTime() - new Date(oldest).getTime()) / 1_000),
          ),
        }
      : {}),
  };
}
