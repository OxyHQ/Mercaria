/**
 * The FLEET-WIDE bound on how hard Mercaria may knock on Awin (#66).
 *
 * #68's `refreshLeaseRepository`, pointed at a publisher ACCOUNT instead of a
 * catalogue source. It is a second table rather than a reuse for one reason,
 * and the reason is the key: #68's lease is keyed on `source_id`, and #66 gives
 * every advertiser its own source — so #68's budget bounds each advertiser
 * separately and the network not at all. Fifty advertisers with an allowance of
 * twenty each is a thousand calls a minute at one host under one key, which is
 * how a publisher account gets suspended.
 *
 * Both leases are claimed on a feed download and they answer different
 * questions: #68's is "how hard may Mercaria knock on THIS advertiser's feed",
 * this one is "how hard may Mercaria knock on AWIN". The Publisher API's own
 * published limit — 20 calls a minute per user — is a NETWORK limit, so it is
 * this table that enforces it, and #67's transaction poll joins the same budget
 * rather than opening a second one.
 *
 * CONCURRENCY is exact because a slot is a row and a claim is a row lock. RATE
 * is exact because each slot carries its own equal share and one row's counter
 * is serialized by that same lock. The trade is stated rather than hidden: an
 * uneven arrival pattern can spend one slot's share while another sits idle, so
 * the limiter can UNDER-admit — which errs toward not exceeding a published
 * limit, the direction a provider punishes.
 */

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { awinNetworkLeases } from '../schema/awin.js';

/** One account's budget, as the caller resolved it from its row. */
export interface AwinNetworkBudget {
  accountId: string;
  /** How many calls to Awin may be in flight at once. The slot count. */
  maxConcurrency: number;
  /** The account's whole per-minute allowance, divided evenly across slots. */
  maxCallsPerMinute: number;
}

/**
 * A held slot, or the reason none was available.
 *
 * A STRING discriminant, like #68's and unlike #122's, and that is a compiler
 * constraint rather than a style preference: this package compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the TRUTHINESS of a boolean-literal discriminant — `if
 * (!claim.granted)` would leave the caller holding the whole union, so reading
 * the refusal reason would not compile. The caller must act on the difference:
 * `rate_limited` means back off for the rest of the minute, `all_slots_busy`
 * means retry shortly.
 */
export type AwinNetworkLeaseClaim =
  | { outcome: 'granted'; leaseId: string; slot: number }
  | { outcome: 'refused'; reason: 'all_slots_busy' | 'rate_limited' };

/** The window every slot's counter is measured over. */
const WINDOW_MS = 60_000;

/**
 * Make sure this account's slot rows exist.
 *
 * `on conflict do nothing`, so N tasks racing to provision one account converge
 * on one set. The allowance is recomputed on every call and written only when
 * the numbers moved, because an account whose allowance Awin raised must take
 * effect without an operator touching rows.
 */
async function ensureSlots(
  budget: AwinNetworkBudget,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<void> {
  const share = Math.max(1, Math.floor(budget.maxCallsPerMinute / budget.maxConcurrency));
  const rows = Array.from({ length: budget.maxConcurrency }, (_unused, slot) => ({
    accountId: budget.accountId,
    slot,
    windowStart: now,
    callsInWindow: 0,
    windowAllowance: share,
  }));
  await db
    .insert(awinNetworkLeases)
    .values(rows)
    .onConflictDoNothing({ target: [awinNetworkLeases.accountId, awinNetworkLeases.slot] });

  // Only a slot whose counter still FITS is updated, or
  // `awin_network_leases_window_check` refuses the statement and takes the
  // whole claim down with it. The counter itself is left alone: re-basing it
  // would either forgive a burst already spent or refuse calls never made.
  await db
    .update(awinNetworkLeases)
    .set({ windowAllowance: share, updatedAt: now })
    .where(
      and(
        eq(awinNetworkLeases.accountId, budget.accountId),
        sql`${awinNetworkLeases.windowAllowance} <> ${share}`,
        sql`${awinNetworkLeases.callsInWindow} <= ${share}`,
      ),
    );
}

/**
 * Claim a slot, or be told why not.
 *
 * ONE statement does the claim, the window roll and the counter bump together,
 * so there is no interval in which a slot is held but uncounted.
 *
 * The discriminator asks whether EVERY slot is budget-exhausted and reports
 * `rate_limited` only then. That direction is load-bearing and was measured in
 * #122: this is a plain read, so MVCC shows it the pre-update version of a row
 * another task is claiming right now, and under that stale view a busy slot
 * looks un-exhausted — landing on the transient answer. The reverse phrasing
 * reports the alarming answer on exactly the transient case.
 */
export async function claimAwinNetworkLease(
  input: { budget: AwinNetworkBudget; leaseOwner: string; leaseMs: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinNetworkLeaseClaim> {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(1_000, input.leaseMs));
  const windowCutoff = new Date(now.getTime() - WINDOW_MS);

  await ensureSlots(input.budget, now, db);

  // Bound to the ISO string with an explicit cast, never the `Date`: a `Date`
  // interpolated into a `sql` template has no column to take a type from and
  // postgres.js refuses it (`CONVENTIONS.md`). The `lte(column, …)` uses below
  // are fine — there drizzle knows the type.
  const cutoffParam = sql`${windowCutoff.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;

  const free = or(
    isNull(awinNetworkLeases.leaseUntil),
    lte(awinNetworkLeases.leaseUntil, now),
  );
  const hasBudget = or(
    lte(awinNetworkLeases.windowStart, windowCutoff),
    sql`${awinNetworkLeases.callsInWindow} < ${awinNetworkLeases.windowAllowance}`,
  );

  const candidate = db
    .select({ id: awinNetworkLeases.id })
    .from(awinNetworkLeases)
    .where(and(eq(awinNetworkLeases.accountId, input.budget.accountId), free, hasBudget))
    .orderBy(awinNetworkLeases.slot)
    .limit(1)
    .for('update', { skipLocked: true });

  const [claimed] = await db
    .update(awinNetworkLeases)
    .set({
      leaseOwner: input.leaseOwner,
      leaseUntil,
      windowStart: sql`case when ${awinNetworkLeases.windowStart} <= ${cutoffParam}
                            then ${nowParam} else ${awinNetworkLeases.windowStart} end`,
      callsInWindow: sql`case when ${awinNetworkLeases.windowStart} <= ${cutoffParam}
                              then 1 else ${awinNetworkLeases.callsInWindow} + 1 end`,
      updatedAt: now,
    })
    .where(eq(awinNetworkLeases.id, sql`(${candidate})`))
    .returning({ id: awinNetworkLeases.id, slot: awinNetworkLeases.slot });

  if (claimed) return { outcome: 'granted', leaseId: claimed.id, slot: claimed.slot };

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      exhausted: sql<number>`count(*) filter (
        where ${awinNetworkLeases.windowStart} > ${cutoffParam}
          and ${awinNetworkLeases.callsInWindow} >= ${awinNetworkLeases.windowAllowance}
      )::int`,
    })
    .from(awinNetworkLeases)
    .where(eq(awinNetworkLeases.accountId, input.budget.accountId));

  const exhausted = counts !== undefined && counts.total > 0 && counts.exhausted === counts.total;
  return { outcome: 'refused', reason: exhausted ? 'rate_limited' : 'all_slots_busy' };
}

/**
 * Release only the lease this caller currently owns.
 *
 * The counter is NOT decremented: it measures calls STARTED inside the window,
 * which is what a provider's own limiter counts. Decrementing on release would
 * turn a per-minute budget into a concurrency bound wearing a rate limit's
 * name, and Mercaria would sail past Awin's published twenty under load.
 *
 * @returns `true` when this call released it; `false` when it had already been
 *   reclaimed, which is information rather than a failure.
 */
export async function releaseAwinNetworkLease(
  input: { leaseId: string; leaseOwner: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const released = await db
    .update(awinNetworkLeases)
    .set({ leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(
      and(
        eq(awinNetworkLeases.id, input.leaseId),
        eq(awinNetworkLeases.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: awinNetworkLeases.id });
  return released.length === 1;
}

/** What an operator sees about one account's network budget. */
export interface AwinNetworkQuotaView {
  accountId: string;
  slots: number;
  busySlots: number;
  callsInWindow: number;
  windowAllowance: number;
}

export async function readAwinNetworkQuota(
  input: { accountId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinNetworkQuotaView> {
  const now = input.now ?? new Date();
  const windowCutoff = new Date(now.getTime() - WINDOW_MS);
  const [row] = await db
    .select({
      slots: sql<number>`count(*)::int`,
      busySlots: sql<number>`count(*) filter (
        where ${awinNetworkLeases.leaseUntil} is not null
          and ${awinNetworkLeases.leaseUntil} > ${sql`${now.toISOString()}::timestamptz`}
      )::int`,
      // Only slots inside the CURRENT window contribute: a stale counter from a
      // minute nobody has rolled yet is not spend.
      callsInWindow: sql<number>`coalesce(sum(${awinNetworkLeases.callsInWindow}) filter (
        where ${awinNetworkLeases.windowStart} > ${sql`${windowCutoff.toISOString()}::timestamptz`}
      ), 0)::int`,
      windowAllowance: sql<number>`coalesce(sum(${awinNetworkLeases.windowAllowance}), 0)::int`,
    })
    .from(awinNetworkLeases)
    .where(eq(awinNetworkLeases.accountId, input.accountId));

  return {
    accountId: input.accountId,
    slots: row?.slots ?? 0,
    busySlots: row?.busySlots ?? 0,
    callsInWindow: row?.callsInWindow ?? 0,
    windowAllowance: row?.windowAllowance ?? 0,
  };
}
