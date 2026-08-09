/**
 * How one supplier account has actually been answering (#122 operations 1–2,
 * and the input to the automatic suppression of operations 6).
 *
 * One row per account holding a ROLLING window, not an event log: the question
 * is "may this route be quoted against right now", asked on the checkout path,
 * and a scan over per-call rows would put a growing table in front of every
 * sale. The individual outcomes are already on `supplier_quotes`, which is
 * where an investigation goes.
 *
 * ## Every write is ONE statement, and the counters reconcile by CHECK
 *
 * `attempts = successes + failures` is a table constraint, so a window that
 * dropped an outcome cannot be stored at all. That matters more here than it
 * looks: a health verdict computed from a lossy window is exactly the report
 * that says everything is fine — the `catalog_backfill_runs` vacuity floor
 * (#60), applied to a provider. Recording an outcome therefore increments
 * `attempts` and exactly one of `successes` / `failures` in the same
 * expression, never in two statements a crash could separate.
 */

import { eq, sql } from 'drizzle-orm';
import type { SupplierPreflightFailureKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { supplierPreflightHealth } from '../schema/supplierPreflight.js';

/** One account's rolling health window. */
export type SupplierPreflightHealthRow = typeof supplierPreflightHealth.$inferSelect;

/** One completed provider call, as health records it. */
export interface SupplierCallOutcome {
  supplierAccountId: string;
  succeeded: boolean;
  /** Present exactly when the call failed. */
  failureKind: SupplierPreflightFailureKind | null;
  /** NULL when the call never completed — a timeout has no latency to average. */
  latencyMs: number | null;
  /** How long a window lasts before the counters restart. */
  windowMinutes: number;
  now?: Date;
}

/**
 * Record one outcome, rolling the window when it has run out.
 *
 * `on conflict do update` on the account key, with the roll and the increment
 * in the SAME expression: a `case` on `window_start` decides whether this
 * outcome starts a fresh window at one or joins the current one. Two concurrent
 * tasks recording against one account are serialized by the row lock the
 * conflict path takes, so neither can lose the other's increment.
 */
export async function recordSupplierCallOutcome(
  outcome: SupplierCallOutcome,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = outcome.now ?? new Date();
  const cutoff = new Date(now.getTime() - outcome.windowMinutes * 60_000);
  const success = outcome.succeeded ? 1 : 0;
  const failure = outcome.succeeded ? 0 : 1;
  const timeout = outcome.failureKind === 'timeout' ? 1 : 0;
  const throttled = outcome.failureKind === 'rate_limited' ? 1 : 0;
  const latency = outcome.latencyMs ?? 0;
  const latencySample = outcome.latencyMs === null ? 0 : 1;
  // A `Date` interpolated into a `sql` template is handed to postgres.js with
  // no column to take a type from, and the driver refuses it with
  // `ERR_INVALID_ARG_TYPE` — the trap `CONVENTIONS.md` records under "A `Date`
  // is not a safe parameter against an EXPRESSION". Bind the ISO string with an
  // explicit cast. tsc cannot see this; only a real server can.
  const cutoffParam = sql`${cutoff.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  const rolled = sql`${supplierPreflightHealth.windowStart} <= ${cutoffParam}`;

  await db
    .insert(supplierPreflightHealth)
    .values({
      supplierAccountId: outcome.supplierAccountId,
      windowStart: now,
      attempts: 1,
      successes: success,
      failures: failure,
      timeouts: timeout,
      rateLimited: throttled,
      latencyMsTotal: latency,
      latencySamples: latencySample,
      consecutiveFailures: failure,
      lastSuccessAt: outcome.succeeded ? now : null,
      lastFailureAt: outcome.succeeded ? null : now,
      lastFailureKind: outcome.succeeded ? null : outcome.failureKind,
    })
    .onConflictDoUpdate({
      target: supplierPreflightHealth.supplierAccountId,
      set: {
        windowStart: sql`case when ${rolled} then ${nowParam} else ${supplierPreflightHealth.windowStart} end`,
        attempts: sql`case when ${rolled} then 1 else ${supplierPreflightHealth.attempts} + 1 end`,
        successes: sql`case when ${rolled} then ${success} else ${supplierPreflightHealth.successes} + ${success} end`,
        failures: sql`case when ${rolled} then ${failure} else ${supplierPreflightHealth.failures} + ${failure} end`,
        timeouts: sql`case when ${rolled} then ${timeout} else ${supplierPreflightHealth.timeouts} + ${timeout} end`,
        rateLimited: sql`case when ${rolled} then ${throttled} else ${supplierPreflightHealth.rateLimited} + ${throttled} end`,
        latencyMsTotal: sql`case when ${rolled} then ${latency} else ${supplierPreflightHealth.latencyMsTotal} + ${latency} end`,
        latencySamples: sql`case when ${rolled} then ${latencySample} else ${supplierPreflightHealth.latencySamples} + ${latencySample} end`,
        // Consecutive failures deliberately survive a window roll: a provider
        // failing steadily across two windows is not two healthy starts, and
        // resetting the streak with the counters would hide exactly the shape
        // an operator is watching for. A success is what clears it.
        consecutiveFailures: outcome.succeeded
          ? sql`0`
          : sql`${supplierPreflightHealth.consecutiveFailures} + 1`,
        ...(outcome.succeeded
          ? { lastSuccessAt: now }
          : { lastFailureAt: now, lastFailureKind: outcome.failureKind }),
        updatedAt: now,
      },
    });
}

/** One account's window, or nothing when it has never been called. */
export async function findSupplierPreflightHealth(
  supplierAccountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierPreflightHealthRow | undefined> {
  const [row] = await db
    .select()
    .from(supplierPreflightHealth)
    .where(eq(supplierPreflightHealth.supplierAccountId, supplierAccountId))
    .limit(1);
  return row;
}

/** Every account's window — the operator dashboard's page. */
export async function listSupplierPreflightHealth(
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierPreflightHealthRow[]> {
  return db.select().from(supplierPreflightHealth).orderBy(supplierPreflightHealth.supplierAccountId);
}

/** The derived verdict a policy version's thresholds produce. */
export interface SupplierHealthVerdict {
  /** Basis points of successful answers. NULL = not enough samples to say. */
  successBps: number | null;
  /** The mean over completed calls. NULL = nothing completed. */
  averageLatencyMs: number | null;
  /** Whether the window is degraded BEYOND the policy — the suppression trigger. */
  degraded: boolean;
  /** Whether the window is stale enough that it says nothing about now. */
  stale: boolean;
  samples: number;
}

/** What the verdict is measured against. */
export interface SupplierHealthThresholds {
  windowMinutes: number;
  minimumSamples: number;
  maxFailureBps: number;
}

/**
 * Turn one window into a verdict. Pure — the row and the thresholds decide it.
 *
 * ## An absent or thin measurement withholds nothing
 *
 * Below `minimumSamples` the verdict is `successBps: null` and `degraded:
 * false`. Suppressing a route because two calls out of three failed on a
 * brand-new supplier account would make a first integration unable to complete,
 * and suppressing on a STALE window would turn a quiet night into an outage —
 * so both answer "no opinion", which is the `SELLER_TRUST_RESTRICTED_TIERS`
 * rule (#92): restricting on absence turns a metrics gap into a delisting.
 */
export function deriveSupplierHealthVerdict(
  row: SupplierPreflightHealthRow | undefined,
  thresholds: SupplierHealthThresholds,
  now: Date = new Date(),
): SupplierHealthVerdict {
  if (!row || row.attempts === 0) {
    return { successBps: null, averageLatencyMs: null, degraded: false, stale: false, samples: 0 };
  }

  const stale = row.windowStart.getTime() + thresholds.windowMinutes * 60_000 <= now.getTime();
  const averageLatencyMs =
    row.latencySamples > 0 ? Math.round(row.latencyMsTotal / row.latencySamples) : null;

  if (stale || row.attempts < thresholds.minimumSamples) {
    return {
      successBps: null,
      averageLatencyMs,
      degraded: false,
      stale,
      samples: row.attempts,
    };
  }

  const successBps = Math.round((row.successes / row.attempts) * 10_000);
  const failureBps = 10_000 - successBps;
  return {
    successBps,
    averageLatencyMs,
    degraded: failureBps > thresholds.maxFailureBps,
    stale: false,
    samples: row.attempts,
  };
}
