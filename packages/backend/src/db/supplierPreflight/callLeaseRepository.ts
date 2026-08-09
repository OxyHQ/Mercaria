/**
 * The shared, cross-task bound on how hard Mercaria may call one supplier
 * (#122 concurrency 6).
 *
 * ## Why this is in Postgres
 *
 * "How many calls per minute may this supplier account receive across every ECS
 * task" is not a question an in-process token bucket can answer — every task
 * answers it separately and their sum is whatever the task count happens to be.
 * `merchant_claim_rate_limits` (#83) makes the same argument for an inbound
 * axis; this is the outbound one, where getting it wrong means a supplier's own
 * limiter starts refusing Mercaria at checkout time.
 *
 * ## The claim is exact in both dimensions, and the trade is stated
 *
 * CONCURRENCY is exact because a slot is a row and a claim is a row lock:
 * `FOR UPDATE SKIP LOCKED` cannot hand one slot to two tasks. RATE is exact
 * because each slot carries its own equal share of the account's per-minute
 * allowance and a single row's counter is serialized by that same lock, so the
 * admitted total can never exceed `slots x share`.
 *
 * What it gives up: an uneven arrival pattern can exhaust one slot's share
 * while another sits idle, so the limiter can under-admit. That errs toward NOT
 * exceeding the provider's published limit, which is the direction a supplier
 * punishes — and the alternative (one shared counter plus separate lease rows)
 * needs two tables to be exact in either dimension.
 *
 * ## A lease is reclaimable, and release is owner-checked
 *
 * `lease_until` in the past means the holder died and the next claimant takes
 * the slot. Release matches on the owner, so a task that lost its lease cannot
 * free the slot the new holder is using — the `payment_outboxes` lease
 * contract, verbatim.
 */

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { supplierCallLeases } from '../schema/supplierPreflight.js';

/** One slot row. */
export type SupplierCallLeaseRow = typeof supplierCallLeases.$inferSelect;

/** The shape of one account's budget, as the caller resolved it. */
export interface SupplierCallBudget {
  supplierAccountId: string;
  /** How many calls may be in flight at once. The slot count. */
  maxConcurrency: number;
  /** The account's whole per-minute allowance, divided evenly across slots. */
  maxCallsPerMinute: number;
}

/** A held slot, or the reason none was available. */
export type SupplierCallLeaseClaim =
  | { granted: true; leaseId: string; slot: number }
  | { granted: false; reason: 'all_slots_busy' | 'rate_limited' };

/** How long a claim is held before another task may reclaim it. */
const DEFAULT_LEASE_MS = 30_000;

/** The window every slot's counter is measured over. */
const WINDOW_MS = 60_000;

/**
 * Make sure this account's slot rows exist.
 *
 * `on conflict do nothing`, so N tasks racing to provision the same account
 * converge on one set. The allowance is recomputed on every call and written
 * only when the policy's numbers changed, because a policy version that widened
 * the budget must take effect without an operator touching rows.
 */
async function ensureSlots(
  budget: SupplierCallBudget,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<void> {
  const share = Math.max(1, Math.floor(budget.maxCallsPerMinute / budget.maxConcurrency));
  const rows = Array.from({ length: budget.maxConcurrency }, (_unused, slot) => ({
    supplierAccountId: budget.supplierAccountId,
    slot,
    windowStart: now,
    callsInWindow: 0,
    windowAllowance: share,
  }));
  await db
    .insert(supplierCallLeases)
    .values(rows)
    .onConflictDoNothing({
      target: [supplierCallLeases.supplierAccountId, supplierCallLeases.slot],
    });

  // A widened or narrowed allowance applies to slots that already exist. The
  // counter is left alone: re-basing it would either forgive a burst already
  // spent or refuse calls that were never made.
  await db
    .update(supplierCallLeases)
    .set({ windowAllowance: share, updatedAt: now })
    .where(
      and(
        eq(supplierCallLeases.supplierAccountId, budget.supplierAccountId),
        sql`${supplierCallLeases.windowAllowance} <> ${share}`,
        // Only widen a slot whose counter still fits, or the column CHECK
        // (`calls_in_window <= window_allowance`) refuses the update and takes
        // the whole claim with it. A slot over a narrowed allowance simply
        // keeps the old one until its window rolls.
        sql`${supplierCallLeases.callsInWindow} <= ${share}`,
      ),
    );
}

/**
 * Claim a slot, or be told why not.
 *
 * ONE statement does the claim, the window roll and the counter bump together,
 * so there is no interval in which a slot is held but uncounted. The `case`
 * over `window_start` is the roll: a slot whose minute has passed starts a
 * fresh window at 1 rather than being reset by a separate sweep nobody would
 * run often enough.
 *
 * The two refusals are kept apart deliberately. `all_slots_busy` is transient
 * and worth a short retry; `rate_limited` means the account's budget is spent
 * for this minute and retrying inside it makes things worse — the caller backs
 * off, and the quote records `provider_rate_limited`, which BLOCKS rather than
 * guessing at stock.
 */
export async function claimSupplierCallLease(
  input: { budget: SupplierCallBudget; leaseOwner: string; leaseMs?: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierCallLeaseClaim> {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? DEFAULT_LEASE_MS));
  const windowCutoff = new Date(now.getTime() - WINDOW_MS);

  await ensureSlots(input.budget, now, db);

  // Bound to the ISO string with an explicit cast, never the `Date`: a `Date`
  // interpolated into a `sql` template has no column to take a type from and
  // postgres.js refuses it with `ERR_INVALID_ARG_TYPE` — `CONVENTIONS.md`, "A
  // `Date` is not a safe parameter against an EXPRESSION". The `lte(column, …)`
  // uses below are fine, because there drizzle knows the column's type.
  const cutoffParam = sql`${windowCutoff.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;

  const free = or(
    isNull(supplierCallLeases.leaseUntil),
    lte(supplierCallLeases.leaseUntil, now),
  );
  const hasBudget = or(
    lte(supplierCallLeases.windowStart, windowCutoff),
    sql`${supplierCallLeases.callsInWindow} < ${supplierCallLeases.windowAllowance}`,
  );

  const candidate = db
    .select({ id: supplierCallLeases.id })
    .from(supplierCallLeases)
    .where(
      and(eq(supplierCallLeases.supplierAccountId, input.budget.supplierAccountId), free, hasBudget),
    )
    .orderBy(supplierCallLeases.slot)
    .limit(1)
    .for('update', { skipLocked: true });

  const [claimed] = await db
    .update(supplierCallLeases)
    .set({
      leaseOwner: input.leaseOwner,
      leaseUntil,
      windowStart: sql`case when ${supplierCallLeases.windowStart} <= ${cutoffParam}
                            then ${nowParam} else ${supplierCallLeases.windowStart} end`,
      callsInWindow: sql`case when ${supplierCallLeases.windowStart} <= ${cutoffParam}
                              then 1 else ${supplierCallLeases.callsInWindow} + 1 end`,
      updatedAt: now,
    })
    .where(eq(supplierCallLeases.id, sql`(${candidate})`))
    .returning({ id: supplierCallLeases.id, slot: supplierCallLeases.slot });

  if (claimed) return { granted: true, leaseId: claimed.id, slot: claimed.slot };

  // Nothing was claimable. The two cases are told apart because they need
  // DIFFERENT fixes: `rate_limited` means raise the account's allowance and
  // back off now, `all_slots_busy` means raise its concurrency and retry
  // shortly. One message for both would send an operator to the wrong dial.
  //
  // The discriminator asks whether EVERY slot is budget-exhausted, and reports
  // `rate_limited` only then. The direction matters: this is a plain read, so
  // MVCC shows it the pre-update version of a row another task is claiming
  // right now — and under that stale view a busy slot looks un-exhausted,
  // which lands on `all_slots_busy`. That is the safe way round. The reverse
  // (asking "is any slot free" and inferring rate-limiting from a no) reports
  // the alarming answer on exactly the transient case, because a slot being
  // claimed concurrently still reads as free — measured, and it is why this is
  // an aggregate over exhaustion rather than a lookup for a free row.
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      exhausted: sql<number>`count(*) filter (
        where ${supplierCallLeases.windowStart} > ${cutoffParam}
          and ${supplierCallLeases.callsInWindow} >= ${supplierCallLeases.windowAllowance}
      )::int`,
    })
    .from(supplierCallLeases)
    .where(eq(supplierCallLeases.supplierAccountId, input.budget.supplierAccountId));

  const exhausted = counts !== undefined && counts.total > 0 && counts.exhausted === counts.total;
  return { granted: false, reason: exhausted ? 'rate_limited' : 'all_slots_busy' };
}

/**
 * Release only the lease this caller currently owns.
 *
 * The counter is NOT decremented: it measures calls STARTED inside the window,
 * which is what a provider's own limiter counts. Decrementing on release would
 * turn a per-minute budget into a concurrency bound wearing a rate limit's
 * name, and the account would sail past its published limit under load.
 *
 * @returns `true` when this call released it; `false` when the lease had already
 *   been reclaimed, which is information rather than a failure.
 */
export async function releaseSupplierCallLease(
  input: { leaseId: string; leaseOwner: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const released = await db
    .update(supplierCallLeases)
    .set({ leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(
      and(
        eq(supplierCallLeases.id, input.leaseId),
        eq(supplierCallLeases.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: supplierCallLeases.id });
  return released.length === 1;
}

/** What an operator sees about one account's provider budget (#122 operations 2). */
export interface SupplierCallQuotaView {
  supplierAccountId: string;
  slots: number;
  busySlots: number;
  callsInWindow: number;
  windowAllowance: number;
  windowStart: Date | null;
}

/** One account's live quota picture. */
export async function readSupplierCallQuota(
  input: { supplierAccountId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierCallQuotaView> {
  const now = input.now ?? new Date();
  const windowCutoff = new Date(now.getTime() - WINDOW_MS);
  const [row] = await db
    .select({
      slots: sql<number>`count(*)::int`,
      busySlots: sql<number>`count(*) filter (
        where ${supplierCallLeases.leaseUntil} is not null
          and ${supplierCallLeases.leaseUntil} > ${sql`${now.toISOString()}::timestamptz`}
      )::int`,
      // Only slots inside the current window contribute: a stale counter from a
      // minute nobody has rolled yet is not spend.
      callsInWindow: sql<number>`coalesce(sum(${supplierCallLeases.callsInWindow}) filter (
        where ${supplierCallLeases.windowStart} > ${sql`${windowCutoff.toISOString()}::timestamptz`}
      ), 0)::int`,
      windowAllowance: sql<number>`coalesce(sum(${supplierCallLeases.windowAllowance}), 0)::int`,
      windowStart: sql<Date | null>`max(${supplierCallLeases.windowStart})`,
    })
    .from(supplierCallLeases)
    .where(eq(supplierCallLeases.supplierAccountId, input.supplierAccountId));

  return {
    supplierAccountId: input.supplierAccountId,
    slots: row?.slots ?? 0,
    busySlots: row?.busySlots ?? 0,
    callsInWindow: row?.callsInWindow ?? 0,
    windowAllowance: row?.windowAllowance ?? 0,
    windowStart: row?.windowStart ?? null,
  };
}
