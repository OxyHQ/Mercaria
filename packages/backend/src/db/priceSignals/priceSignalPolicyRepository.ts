/**
 * `price_signal_policy_versions` — the register (#82 statistical policy 7).
 *
 * The `fee_schedules` / `ranking_policy_versions` shape: publish a draft,
 * activate it (which SUPERSEDES the incumbent in the same transaction, because
 * the partial unique refuses two active rows), archive a draft or a superseded
 * version. There is deliberately no update: a threshold change is a NEW version,
 * which is what makes "reproducible from immutable observations and a policy
 * version" (acceptance 4) true of a pair rather than of a moment.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { PRICE_SIGNAL_POLICY_KEY, type PriceSignalPolicy } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { priceSignalPolicyVersions } from '../schema/priceSignals.js';

export type PriceSignalPolicyVersionRow = typeof priceSignalPolicyVersions.$inferSelect;
export type InsertPriceSignalPolicyVersion = typeof priceSignalPolicyVersions.$inferInsert;

/**
 * The row a derivation reads, as the value it reads it AS.
 *
 * One projection, so the pure core never sees a drizzle row and a column rename
 * cannot silently change what a signal means.
 */
export function toPriceSignalPolicy(row: PriceSignalPolicyVersionRow): PriceSignalPolicy {
  return {
    policyKey: row.policyKey,
    version: row.version,
    minObservations: row.minObservations,
    minDistinctSellers: row.minDistinctSellers,
    minDistinctOffers: row.minDistinctOffers,
    minCoverageDays: row.minCoverageDays,
    recentWindowDays: row.recentWindowDays,
    outlierModifiedZThreshold: row.outlierModifiedZThreshold,
    outlierMinDeviationBps: row.outlierMinDeviationBps,
    materialDropBps: row.materialDropBps,
    typicalBandBps: row.typicalBandBps,
    goodPriceBelowMedianBps: row.goodPriceBelowMedianBps,
    strongSampleMultiplier: row.strongSampleMultiplier,
    objectiveMetricKeys: row.objectiveMetricKeys,
    guardrailMetricKeys: row.guardrailMetricKeys,
  };
}

/** The version serving today, or `undefined` — which makes every signal unmeasured. */
export async function findActivePriceSignalPolicy(
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalPolicyVersionRow | undefined> {
  const rows = await db
    .select()
    .from(priceSignalPolicyVersions)
    .where(
      and(
        eq(priceSignalPolicyVersions.policyKey, PRICE_SIGNAL_POLICY_KEY),
        eq(priceSignalPolicyVersions.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
}

/** One named version, whatever its status — the operator's comparison handle. */
export async function findPriceSignalPolicyByVersion(
  version: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalPolicyVersionRow | undefined> {
  const rows = await db
    .select()
    .from(priceSignalPolicyVersions)
    .where(
      and(
        eq(priceSignalPolicyVersions.policyKey, PRICE_SIGNAL_POLICY_KEY),
        eq(priceSignalPolicyVersions.version, version),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function findPriceSignalPolicyById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalPolicyVersionRow | undefined> {
  const rows = await db
    .select()
    .from(priceSignalPolicyVersions)
    .where(eq(priceSignalPolicyVersions.id, id))
    .limit(1);
  return rows[0];
}

/** Every version of the key, newest first. */
export async function listPriceSignalPolicyVersions(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalPolicyVersionRow[]> {
  return db
    .select()
    .from(priceSignalPolicyVersions)
    .where(eq(priceSignalPolicyVersions.policyKey, PRICE_SIGNAL_POLICY_KEY))
    .orderBy(desc(priceSignalPolicyVersions.createdAt))
    .limit(limit);
}

/** Publish a DRAFT. It defines nothing until it is activated. */
export async function insertPriceSignalPolicyVersion(
  values: InsertPriceSignalPolicyVersion,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalPolicyVersionRow> {
  const rows = await db.insert(priceSignalPolicyVersions).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertPriceSignalPolicyVersion returned no row.');
  return row;
}

/**
 * Activate a version, superseding the incumbent in ONE transaction.
 *
 * Two things are load-bearing and only one of them is obvious.
 *
 * The supersede runs FIRST, which is not a style preference: the partial unique
 * `price_signal_policy_versions_one_active_per_key` refuses two active rows, so
 * the reverse order makes every activation fail against the index.
 *
 * And it supersedes the incumbent of the TARGET ROW's OWN key, read inside the
 * transaction, rather than of whatever `PRICE_SIGNAL_POLICY_KEY` names. The
 * partial unique is per key, so a supersede scoped to the constant leaves the
 * real incumbent standing and the activation fails on the index — which is
 * exactly what happened the first time this ran against a real server. Today
 * there is one key and the two spellings agree; the column exists because a
 * second comparison surface with its own policy is a foreseeable thing, and this
 * is the function that would have been silently wrong on the day it arrived.
 */
export async function activatePriceSignalPolicyVersion(
  id: string,
  approvedByOxyUserId: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalPolicyVersionRow | undefined> {
  return db.transaction(async (tx) => {
    const target = await tx
      .select({ policyKey: priceSignalPolicyVersions.policyKey })
      .from(priceSignalPolicyVersions)
      .where(eq(priceSignalPolicyVersions.id, id))
      .limit(1);
    const policyKey = target[0]?.policyKey;
    if (policyKey === undefined) return undefined;

    await tx
      .update(priceSignalPolicyVersions)
      .set({ status: 'superseded', supersededAt: now })
      .where(
        and(
          eq(priceSignalPolicyVersions.policyKey, policyKey),
          eq(priceSignalPolicyVersions.status, 'active'),
        ),
      );

    const rows = await tx
      .update(priceSignalPolicyVersions)
      .set({ status: 'active', activatedAt: now, approvedByOxyUserId })
      .where(and(eq(priceSignalPolicyVersions.id, id), sql`${priceSignalPolicyVersions.status} in ('draft', 'superseded')`))
      .returning();
    return rows[0];
  });
}

/** Retire a draft or a superseded version. Never a delete. */
export async function archivePriceSignalPolicyVersion(
  id: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceSignalPolicyVersionRow | undefined> {
  const rows = await db
    .update(priceSignalPolicyVersions)
    .set({ status: 'archived', archivedAt: now })
    .where(
      and(
        eq(priceSignalPolicyVersions.id, id),
        sql`${priceSignalPolicyVersions.status} in ('draft', 'superseded')`,
      ),
    )
    .returning();
  return rows[0];
}
