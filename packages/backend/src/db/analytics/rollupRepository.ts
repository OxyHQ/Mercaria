/**
 * `analytics_rollups` and `analytics_rollup_cursors` (#77 metrics and
 * dashboards).
 *
 * The cursor is the `reconciliation_cursors` shape one domain over — a lease
 * with an owner check, so the rollup runs on every ECS task, one wins each day's
 * claim and the rest cost microseconds. What differs is what a lease PROTECTS
 * here: nothing in this domain moves money or state, so a lost lease costs a
 * duplicate computation and not a duplicate effect. That is why the bucket write
 * is an overwrite rather than an increment — resumability and idempotency are
 * the same property, approached from two sides.
 */

import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnalyticsMetricSource } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { analyticsRollupCursors, analyticsRollups } from '../schema/analytics.js';

/** How long a claimed rollup run is leased for. */
export const ANALYTICS_ROLLUP_LEASE_MS = 5 * 60_000;

/** One metric bucket, ready to write. */
export interface AnalyticsRollupUpsert {
  readonly metricKey: string;
  readonly bucketDate: string;
  readonly market: string;
  readonly clientSurface: string;
  readonly actorKind: string;
  readonly buyerOrigin: string;
  readonly storeId: string;
  readonly merchantId: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly source: AnalyticsMetricSource;
  readonly computedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Write metric buckets, overwriting any that already exist.
 *
 * `DO UPDATE` with the recomputed figures. A replayed day must converge on the
 * same numbers, and an increment would double whatever the replay re-read —
 * which for a metric is worse than an outage, because the chart stays up and
 * lies.
 */
export async function upsertRollups(buckets: readonly AnalyticsRollupUpsert[]): Promise<number> {
  if (buckets.length === 0) return 0;
  const rows = await getDb()
    .insert(analyticsRollups)
    .values(buckets.map((bucket) => ({ ...bucket })))
    .onConflictDoUpdate({
      target: [
        analyticsRollups.metricKey,
        analyticsRollups.bucketDate,
        analyticsRollups.market,
        analyticsRollups.clientSurface,
        analyticsRollups.actorKind,
        analyticsRollups.buyerOrigin,
        analyticsRollups.storeId,
        analyticsRollups.merchantId,
      ],
      set: {
        numerator: sql`excluded.numerator`,
        denominator: sql`excluded.denominator`,
        source: sql`excluded.source`,
        computedAt: sql`excluded.computed_at`,
        expiresAt: sql`excluded.expires_at`,
      },
    })
    .returning({ id: analyticsRollups.id });
  return rows.length;
}

/** A stored bucket, as the read surfaces project it. */
export interface AnalyticsRollupReadRow {
  readonly metricKey: string;
  readonly bucketDate: string;
  readonly market: string;
  readonly clientSurface: string;
  readonly actorKind: string;
  readonly buyerOrigin: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly computedAt: Date;
}

/**
 * Read a metric's buckets over a date range, optionally scoped to one store.
 *
 * `storeId` is a REQUIRED discriminator rather than an optional filter: a
 * merchant read passes their own store, an operator read passes `''` (the
 * platform-wide bucket). Making it a parameter with no default is what stops a
 * merchant-facing caller accidentally reading the unscoped total, which is the
 * one mistake that would expose another merchant's numbers.
 */
export async function readRollups(input: {
  metricKeys: readonly string[];
  from: string;
  to: string;
  storeId: string;
  market?: string;
}): Promise<readonly AnalyticsRollupReadRow[]> {
  if (input.metricKeys.length === 0) return [];
  const conditions = [
    inArray(analyticsRollups.metricKey, [...input.metricKeys]),
    gte(analyticsRollups.bucketDate, input.from),
    lte(analyticsRollups.bucketDate, input.to),
    eq(analyticsRollups.storeId, input.storeId),
  ];
  if (input.market !== undefined) {
    conditions.push(eq(analyticsRollups.market, input.market));
  }

  return getDb()
    .select({
      metricKey: analyticsRollups.metricKey,
      bucketDate: analyticsRollups.bucketDate,
      market: analyticsRollups.market,
      clientSurface: analyticsRollups.clientSurface,
      actorKind: analyticsRollups.actorKind,
      buyerOrigin: analyticsRollups.buyerOrigin,
      numerator: analyticsRollups.numerator,
      denominator: analyticsRollups.denominator,
      computedAt: analyticsRollups.computedAt,
    })
    .from(analyticsRollups)
    .where(and(...conditions))
    .orderBy(analyticsRollups.bucketDate);
}

/** The rollup cursor row. */
export interface AnalyticsRollupCursorRow {
  readonly id: string;
  readonly lastCompletedDate: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
}

/**
 * Claim the rollup run, creating the cursor row on first use.
 *
 * The claim is ONE statement: an insert whose conflict branch takes the lease
 * only when it is free or expired, and whose `RETURNING` set is the answer. The
 * empty vs one-row result IS "another task holds it" — the moderation-event
 * claim shape — so a real failure still propagates instead of being read as a
 * lost race.
 *
 * @returns The claimed cursor, or `undefined` when another task holds the lease.
 */
export async function claimRollupRun(input: {
  job: string;
  leaseOwner: string;
  leaseMs: number;
  now: Date;
}): Promise<AnalyticsRollupCursorRow | undefined> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const rows = await getDb()
    .insert(analyticsRollupCursors)
    .values({
      id: input.job,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      lastRunAt: input.now,
    })
    .onConflictDoUpdate({
      target: analyticsRollupCursors.id,
      set: { leaseOwner: input.leaseOwner, leaseExpiresAt, lastRunAt: input.now },
      // Only when the lease is free or a dead task's has expired. Without this
      // predicate the upsert would steal a live lease every tick.
      setWhere: or(
        isNull(analyticsRollupCursors.leaseExpiresAt),
        lte(analyticsRollupCursors.leaseExpiresAt, input.now),
      ),
    })
    .returning({
      id: analyticsRollupCursors.id,
      lastCompletedDate: analyticsRollupCursors.lastCompletedDate,
      leaseOwner: analyticsRollupCursors.leaseOwner,
      leaseExpiresAt: analyticsRollupCursors.leaseExpiresAt,
    });
  return rows[0];
}

/**
 * Record that a day is fully rolled up and release the lease.
 *
 * The owner check is what makes the lease a lease: a task whose lease expired
 * mid-run and was reclaimed writes nothing, so its stale idea of where the
 * cursor is cannot rewind the task that took over.
 */
export async function completeRollupRun(input: {
  job: string;
  leaseOwner: string;
  completedDate: string | null;
  error?: string;
  now: Date;
}): Promise<boolean> {
  const rows = await getDb()
    .update(analyticsRollupCursors)
    .set({
      ...(input.completedDate === null ? {} : { lastCompletedDate: input.completedDate }),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastRunAt: input.now,
      lastError: input.error ?? null,
    })
    .where(
      and(
        eq(analyticsRollupCursors.id, input.job),
        eq(analyticsRollupCursors.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: analyticsRollupCursors.id });
  return rows.length === 1;
}
