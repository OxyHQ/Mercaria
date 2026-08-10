/**
 * `offer_price_series` and `offer_price_points` — the derived answer, and the
 * job that keeps it derived (#78).
 *
 * The enqueue is `offer_outboxes`' `DO UPDATE` shape and not the moderation
 * outbox's `DO NOTHING`, for #57's reason: a series is a request for a FIXED
 * POINT rather than a delivery, so five observations in a second owe one
 * rebuild and a `DO NOTHING` would drop the four that arrived while one was
 * pending — including the one that moved the price.
 *
 * The `set` also refuses to write a flat `'pending'` over a `processing` row.
 * That was measured in #57: it releases a live lease from outside the worker,
 * the owner check then fails, the worker's own outcome is silently discarded,
 * and a second task can claim the row mid-rebuild.
 */

import { and, asc, count, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type {
  ConditionGroup,
  CurrencyCode,
  PriceSeriesGranularity,
  PriceSeriesMeasure,
  PriceSeriesScopeKind,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  offerPricePoints,
  offerPriceSeries,
  PRICE_SERIES_MAX_LAST_ERROR_LENGTH,
} from '../schema/priceHistory.js';

export type OfferPriceSeriesRow = typeof offerPriceSeries.$inferSelect;
export type OfferPricePointRow = typeof offerPricePoints.$inferSelect;
export type InsertOfferPricePoint = typeof offerPricePoints.$inferInsert;

/** The five columns that identify one series. */
export interface PriceSeriesKey {
  readonly scopeKind: PriceSeriesScopeKind;
  readonly canonicalProductId?: string | null;
  readonly canonicalVariantId?: string | null;
  readonly market?: string | null;
  readonly displayCurrency: CurrencyCode;
  readonly granularity: PriceSeriesGranularity;
}

/** The generated key the unique index is taken on, rendered the same way SQL does. */
function seriesKeyOf(key: PriceSeriesKey): string {
  return [
    key.canonicalProductId ?? '',
    key.canonicalVariantId ?? '',
    key.market ?? '',
    key.displayCurrency,
    key.granularity,
  ].join('|');
}

/**
 * Ensure a series exists and ask for it to be rebuilt.
 *
 * Idempotent by construction: the unique is on the GENERATED `series_key`, so
 * two concurrent callers converge on one row and the loser's insert becomes the
 * revision bump. Takes an optional transaction handle for
 * `enqueueOfferConvergence`'s reason — a rolled-back observation must not leave
 * a job asking for a rebuild of a change that never happened.
 */
export async function requestPriceSeriesRebuild(
  key: PriceSeriesKey,
  policyVersion: number,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(offerPriceSeries)
    .values({
      scopeKind: key.scopeKind,
      canonicalProductId: key.canonicalProductId ?? null,
      canonicalVariantId: key.canonicalVariantId ?? null,
      market: key.market ?? null,
      displayCurrency: key.displayCurrency,
      granularity: key.granularity,
      policyVersion,
      requestedRevision: 1,
      status: 'pending',
      attempts: 0,
      availableAt: now,
    })
    .onConflictDoUpdate({
      target: offerPriceSeries.seriesKey,
      set: {
        requestedRevision: sql`${offerPriceSeries.requestedRevision} + 1`,
        // A processing row keeps its status: the revision bump IS the message,
        // and the worker's completion CASE reads it. See the module docblock.
        status: sql`case when ${offerPriceSeries.status} = 'processing' then 'processing' else 'pending' end`,
        attempts: 0,
        availableAt: now,
        lastError: null,
        // A policy bump makes every series stale. Writing the CALLER's version
        // here is what schedules the re-derivation acceptance 5 needs, and it
        // is safe on a processing row because the completion compares
        // revisions, not versions.
        policyVersion,
      },
    });
}

/** One series by its key, whatever its state. */
export async function findPriceSeries(
  key: PriceSeriesKey,
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferPriceSeriesRow | undefined> {
  const rows = await db
    .select()
    .from(offerPriceSeries)
    .where(eq(offerPriceSeries.seriesKey, seriesKeyOf(key)))
    .limit(1);
  return rows[0];
}

/**
 * Atomically claim due rebuilds — `offer_outboxes`' claim, verbatim.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` inside the `UPDATE`, so N tasks drain the
 * queue without handing each other the same row, and an expired `processing`
 * lease is reclaimable so a task that died mid-rebuild cannot strand a chart.
 */
export async function claimPriceSeriesRebuilds(
  options: { leaseOwner: string; batchSize: number; leaseMs?: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferPriceSeriesRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 120_000);
  const batchSize = Math.max(1, options.batchSize);

  const due = or(
    and(eq(offerPriceSeries.status, 'pending'), lte(offerPriceSeries.availableAt, now)),
    and(eq(offerPriceSeries.status, 'processing'), lte(offerPriceSeries.leaseUntil, now)),
  );

  return db
    .update(offerPriceSeries)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      claimedRevision: sql`${offerPriceSeries.requestedRevision}`,
      attempts: sql`${offerPriceSeries.attempts} + 1`,
      lastError: null,
    })
    .where(
      sql`${offerPriceSeries.id} in (
        select ${offerPriceSeries.id} from ${offerPriceSeries}
        where ${due}
        order by ${asc(offerPriceSeries.availableAt)}
        limit ${batchSize}
        for update skip locked
      )`,
    )
    .returning();
}

/** Only the lease this dispatcher currently owns matches. */
function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(offerPriceSeries.id, id),
    eq(offerPriceSeries.status, 'processing'),
    eq(offerPriceSeries.leaseOwner, leaseOwner),
    gt(offerPriceSeries.leaseUntil, now),
  );
}

/**
 * Replace a series' points with the derivation's output, and record what window
 * was examined — in ONE transaction.
 *
 * DELETE-then-INSERT rather than an upsert, and that is what makes the rebuild
 * idempotent in the sense acceptance 5 means: an upsert leaves behind every
 * point the new derivation did NOT produce, so a bucket that stopped having an
 * eligible observation would keep its old answer forever and two rebuilds of
 * the same data would not agree.
 *
 * @returns `true` when this dispatcher still owned the lease.
 */
export async function replacePriceSeriesPoints(
  options: {
    seriesId: string;
    leaseOwner: string;
    points: readonly Omit<InsertOfferPricePoint, 'seriesId'>[];
    coveredFrom: Date;
    coveredThrough: Date;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();

  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: offerPriceSeries.id })
      .from(offerPriceSeries)
      .where(ownedLease(options.seriesId, options.leaseOwner, now))
      .limit(1);
    if (owned.length !== 1) return false;

    await tx.delete(offerPricePoints).where(eq(offerPricePoints.seriesId, options.seriesId));
    if (options.points.length > 0) {
      await tx
        .insert(offerPricePoints)
        .values(options.points.map((point) => ({ ...point, seriesId: options.seriesId })));
    }

    await tx
      .update(offerPriceSeries)
      .set({
        // The revision CASE, evaluated in the same statement that releases the
        // lease: an observation that landed mid-rebuild leaves the row pending
        // rather than being swallowed by the completion that follows it.
        status: sql`case when ${offerPriceSeries.requestedRevision} > coalesce(${offerPriceSeries.claimedRevision}, 0)
                         then 'pending' else 'done' end`,
        coveredFrom: options.coveredFrom,
        coveredThrough: options.coveredThrough,
        rebuiltAt: now,
        pointCount: options.points.length,
        availableAt: now,
        leaseOwner: null,
        leaseUntil: null,
        lastError: null,
      })
      .where(eq(offerPriceSeries.id, options.seriesId));

    return true;
  });
}

/** Release a failed rebuild with backoff — or stop. The caller decides which. */
export async function releasePriceSeriesRebuild(
  options: {
    id: string;
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(offerPriceSeries)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, PRICE_SERIES_MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.id, options.leaseOwner, now))
    .returning({ id: offerPriceSeries.id });
  return rows.length === 1;
}

/** One question's points, along the x axis. */
export async function listPricePoints(
  options: {
    seriesId: string;
    measure: PriceSeriesMeasure;
    segment: ConditionGroup;
    from: Date;
    to: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferPricePointRow[]> {
  return db
    .select()
    .from(offerPricePoints)
    .where(
      and(
        eq(offerPricePoints.seriesId, options.seriesId),
        eq(offerPricePoints.measure, options.measure),
        eq(offerPricePoints.segment, options.segment),
        sql`${offerPricePoints.bucketStart} >= ${options.from.toISOString()}::timestamptz`,
        sql`${offerPricePoints.bucketStart} <= ${options.to.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(offerPricePoints.bucketStart));
}

/** Every series naming one of these canonical entities — what a merge re-arms. */
export async function listPriceSeriesForScopeIds(
  options: { canonicalProductIds?: readonly string[]; canonicalVariantIds?: readonly string[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferPriceSeriesRow[]> {
  const filters = [];
  if (options.canonicalProductIds?.length) {
    filters.push(inArray(offerPriceSeries.canonicalProductId, [...options.canonicalProductIds]));
  }
  if (options.canonicalVariantIds?.length) {
    filters.push(inArray(offerPriceSeries.canonicalVariantId, [...options.canonicalVariantIds]));
  }
  if (filters.length === 0) return [];
  const predicate = filters.length === 1 ? filters[0] : or(...filters);
  if (!predicate) return [];
  return db.select().from(offerPriceSeries).where(predicate);
}

/** Re-arm named series without needing to know their scope columns. */
export async function requestPriceSeriesRebuildByIds(
  seriesIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<number> {
  if (seriesIds.length === 0) return 0;
  const rows = await db
    .update(offerPriceSeries)
    .set({
      requestedRevision: sql`${offerPriceSeries.requestedRevision} + 1`,
      status: sql`case when ${offerPriceSeries.status} = 'processing' then 'processing' else 'pending' end`,
      attempts: 0,
      availableAt: now,
      lastError: null,
    })
    .where(inArray(offerPriceSeries.id, [...seriesIds]))
    .returning({ id: offerPriceSeries.id });
  return rows.length;
}

/** The rebuild queue's health — the operator metric. */
export async function summarizePriceSeries(
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<{
  total: number;
  pending: number;
  deadLetter: number;
  oldestPendingRebuildAgeSeconds?: number;
}> {
  const rows = await db
    .select({
      total: count(),
      pending: sql<number>`count(*) filter (where ${offerPriceSeries.status} in ('pending','processing'))::int`,
      deadLetter: sql<number>`count(*) filter (where ${offerPriceSeries.status} = 'dead_letter')::int`,
      oldestPending: sql<Date | null>`min(${offerPriceSeries.availableAt})
        filter (where ${offerPriceSeries.status} in ('pending','processing'))`,
    })
    .from(offerPriceSeries);

  const row = rows[0];
  const oldest = row?.oldestPending ? new Date(row.oldestPending) : undefined;
  return {
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    deadLetter: row?.deadLetter ?? 0,
    // Absent rather than zero when nothing is outstanding: reporting zero would
    // make a stalled dispatcher indistinguishable from an idle one.
    ...(oldest
      ? {
          oldestPendingRebuildAgeSeconds: Math.max(
            0,
            Math.round((now.getTime() - oldest.getTime()) / 1_000),
          ),
        }
      : {}),
  };
}
