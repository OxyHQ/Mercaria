/**
 * The fleet-wide bound on how hard Mercaria may knock on one catalogue source
 * (#68 scheduler 3).
 *
 * `supplier_call_leases` (#122), pointed at an inbound source instead of an
 * outbound supplier. The argument is the same and is worth restating because
 * the tempting alternative is wrong in a way that stays invisible until a
 * provider disables the integration: **"how many calls per minute may this
 * source receive across every ECS task" is not a question an in-process token
 * bucket can answer.** Every task answers it separately and their sum is
 * whatever the task count happens to be — which for eBay's 5,000-calls-a-day
 * default is the difference between a working feed and a suspended keyset.
 *
 * CONCURRENCY is exact because a slot is a row and a claim is a row lock.
 * RATE is exact because each slot carries its own equal share of the source's
 * per-minute allowance and one row's counter is serialized by that same lock.
 * The trade is stated rather than hidden: an uneven arrival pattern can spend
 * one slot's share while another sits idle, so the limiter can UNDER-admit —
 * which errs toward not exceeding the published limit, the direction a provider
 * punishes.
 *
 * This does NOT replace #62's source lease. That one says "this task is
 * responsible for feeding this source" and is about ownership; a source with a
 * concurrency of four wants four holders of this and exactly one owner of that.
 */

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { catalogSourceRefreshLeases } from '../schema/offerFreshness.js';

/** The shape of one source's budget, as the caller resolved it from its config. */
export interface SourceRefreshBudget {
  sourceId: string;
  /** How many refresh calls may be in flight at once. The slot count. */
  maxConcurrency: number;
  /** The source's whole per-minute allowance, divided evenly across slots. */
  maxCallsPerMinute: number;
}

/**
 * A held slot, or the reason none was available.
 *
 * The discriminant is a STRING and not a boolean, unlike #122's otherwise
 * identical `SupplierCallLeaseClaim`, and that is a compiler constraint rather
 * than a style preference: this package compiles with `strict: false`, and
 * without `strictNullChecks` TypeScript does not narrow a union on the
 * TRUTHINESS of a boolean-literal discriminant — `if (!claim.granted)` leaves
 * the caller holding the whole union, so reading the refusal reason does not
 * compile. #122 sidestepped it by hardcoding one reason at the call site and
 * throwing the other away, which is exactly the distinction the two refusals
 * exist to make: `rate_limited` means raise the allowance and back off,
 * `all_slots_busy` means raise the concurrency and retry shortly. A string
 * discriminant narrows under equality regardless of `strictNullChecks`, so the
 * caller can act on the difference.
 */
export type SourceRefreshLeaseClaim =
  | { outcome: 'granted'; leaseId: string; slot: number }
  | { outcome: 'refused'; reason: 'all_slots_busy' | 'rate_limited' };

/** The window every slot's counter is measured over. */
const WINDOW_MS = 60_000;

/**
 * Make sure this source's slot rows exist.
 *
 * `on conflict do nothing`, so N tasks racing to provision one source converge
 * on one set. The allowance is recomputed on every call and written only when
 * the numbers moved, because a config that widened the budget must take effect
 * without an operator touching rows.
 */
async function ensureSlots(
  budget: SourceRefreshBudget,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<void> {
  const share = Math.max(1, Math.floor(budget.maxCallsPerMinute / budget.maxConcurrency));
  const rows = Array.from({ length: budget.maxConcurrency }, (_unused, slot) => ({
    sourceId: budget.sourceId,
    slot,
    windowStart: now,
    callsInWindow: 0,
    windowAllowance: share,
  }));
  await db
    .insert(catalogSourceRefreshLeases)
    .values(rows)
    .onConflictDoNothing({
      target: [catalogSourceRefreshLeases.sourceId, catalogSourceRefreshLeases.slot],
    });

  // A widened or narrowed allowance applies to slots that already exist. The
  // counter is left alone: re-basing it would either forgive a burst already
  // spent or refuse calls that were never made. Only a slot whose counter still
  // FITS is updated, or `catalog_source_refresh_leases_window_check` refuses the
  // statement and takes the whole claim down with it.
  await db
    .update(catalogSourceRefreshLeases)
    .set({ windowAllowance: share, updatedAt: now })
    .where(
      and(
        eq(catalogSourceRefreshLeases.sourceId, budget.sourceId),
        sql`${catalogSourceRefreshLeases.windowAllowance} <> ${share}`,
        sql`${catalogSourceRefreshLeases.callsInWindow} <= ${share}`,
      ),
    );
}

/**
 * Claim a slot, or be told why not.
 *
 * ONE statement does the claim, the window roll and the counter bump together,
 * so there is no interval in which a slot is held but uncounted. The `case`
 * over `window_start` is the roll: a slot whose minute has passed starts a
 * fresh window at 1 rather than waiting for a sweep nobody would run often
 * enough.
 *
 * The two refusals are kept apart because they need DIFFERENT fixes:
 * `rate_limited` means raise the source's allowance and back off now,
 * `all_slots_busy` means raise its concurrency and retry shortly.
 *
 * The discriminator asks whether EVERY slot is budget-exhausted and reports
 * `rate_limited` only then. That direction is load-bearing and was measured in
 * #122: this is a plain read, so MVCC shows it the pre-update version of a row
 * another task is claiming right now, and under that stale view a busy slot
 * looks un-exhausted — landing on the transient answer. The reverse phrasing
 * ("is any slot free, and if not we are rate limited") reports the alarming
 * answer on exactly the transient case.
 */
export async function claimSourceRefreshLease(
  input: { budget: SourceRefreshBudget; leaseOwner: string; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SourceRefreshLeaseClaim> {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, input.leaseMs));
  const windowCutoff = new Date(now.getTime() - WINDOW_MS);

  await ensureSlots(input.budget, now, db);

  // Bound to the ISO string with an explicit cast, never the `Date`: a `Date`
  // interpolated into a `sql` template has no column to take a type from and
  // postgres.js refuses it with `ERR_INVALID_ARG_TYPE` (`CONVENTIONS.md`). The
  // `lte(column, …)` uses below are fine — there drizzle knows the type.
  const cutoffParam = sql`${windowCutoff.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;

  const free = or(
    isNull(catalogSourceRefreshLeases.leaseUntil),
    lte(catalogSourceRefreshLeases.leaseUntil, now),
  );
  const hasBudget = or(
    lte(catalogSourceRefreshLeases.windowStart, windowCutoff),
    sql`${catalogSourceRefreshLeases.callsInWindow} < ${catalogSourceRefreshLeases.windowAllowance}`,
  );

  const candidate = db
    .select({ id: catalogSourceRefreshLeases.id })
    .from(catalogSourceRefreshLeases)
    .where(and(eq(catalogSourceRefreshLeases.sourceId, input.budget.sourceId), free, hasBudget))
    .orderBy(catalogSourceRefreshLeases.slot)
    .limit(1)
    .for('update', { skipLocked: true });

  const [claimed] = await db
    .update(catalogSourceRefreshLeases)
    .set({
      leaseOwner: input.leaseOwner,
      leaseUntil,
      windowStart: sql`case when ${catalogSourceRefreshLeases.windowStart} <= ${cutoffParam}
                            then ${nowParam} else ${catalogSourceRefreshLeases.windowStart} end`,
      callsInWindow: sql`case when ${catalogSourceRefreshLeases.windowStart} <= ${cutoffParam}
                              then 1 else ${catalogSourceRefreshLeases.callsInWindow} + 1 end`,
      updatedAt: now,
    })
    .where(eq(catalogSourceRefreshLeases.id, sql`(${candidate})`))
    .returning({ id: catalogSourceRefreshLeases.id, slot: catalogSourceRefreshLeases.slot });

  if (claimed) return { outcome: 'granted', leaseId: claimed.id, slot: claimed.slot };

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      exhausted: sql<number>`count(*) filter (
        where ${catalogSourceRefreshLeases.windowStart} > ${cutoffParam}
          and ${catalogSourceRefreshLeases.callsInWindow} >= ${catalogSourceRefreshLeases.windowAllowance}
      )::int`,
    })
    .from(catalogSourceRefreshLeases)
    .where(eq(catalogSourceRefreshLeases.sourceId, input.budget.sourceId));

  const exhausted = counts !== undefined && counts.total > 0 && counts.exhausted === counts.total;
  return { outcome: 'refused', reason: exhausted ? 'rate_limited' : 'all_slots_busy' };
}

/**
 * Release only the lease this caller currently owns.
 *
 * The counter is NOT decremented: it measures calls STARTED inside the window,
 * which is what a provider's own limiter counts. Decrementing on release would
 * turn a per-minute budget into a concurrency bound wearing a rate limit's
 * name, and the source would sail past its published limit under load.
 *
 * @returns `true` when this call released it; `false` when it had already been
 *   reclaimed, which is information rather than a failure.
 */
export async function releaseSourceRefreshLease(
  input: { leaseId: string; leaseOwner: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const released = await db
    .update(catalogSourceRefreshLeases)
    .set({ leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(
      and(
        eq(catalogSourceRefreshLeases.id, input.leaseId),
        eq(catalogSourceRefreshLeases.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: catalogSourceRefreshLeases.id });
  return released.length === 1;
}

/** What an operator sees about one source's refresh budget (#68 source health 6). */
export interface SourceRefreshQuotaView {
  sourceId: string;
  slots: number;
  busySlots: number;
  callsInWindow: number;
  windowAllowance: number;
}

/** One source's live quota picture. */
export async function readSourceRefreshQuota(
  input: { sourceId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SourceRefreshQuotaView> {
  const now = input.now ?? new Date();
  const windowCutoff = new Date(now.getTime() - WINDOW_MS);
  const [row] = await db
    .select({
      slots: sql<number>`count(*)::int`,
      busySlots: sql<number>`count(*) filter (
        where ${catalogSourceRefreshLeases.leaseUntil} is not null
          and ${catalogSourceRefreshLeases.leaseUntil} > ${sql`${now.toISOString()}::timestamptz`}
      )::int`,
      // Only slots inside the CURRENT window contribute: a stale counter from a
      // minute nobody has rolled yet is not spend.
      callsInWindow: sql<number>`coalesce(sum(${catalogSourceRefreshLeases.callsInWindow}) filter (
        where ${catalogSourceRefreshLeases.windowStart} > ${sql`${windowCutoff.toISOString()}::timestamptz`}
      ), 0)::int`,
      windowAllowance: sql<number>`coalesce(sum(${catalogSourceRefreshLeases.windowAllowance}), 0)::int`,
    })
    .from(catalogSourceRefreshLeases)
    .where(eq(catalogSourceRefreshLeases.sourceId, input.sourceId));

  return {
    sourceId: input.sourceId,
    slots: row?.slots ?? 0,
    busySlots: row?.busySlots ?? 0,
    callsInWindow: row?.callsInWindow ?? 0,
    windowAllowance: row?.windowAllowance ?? 0,
  };
}
