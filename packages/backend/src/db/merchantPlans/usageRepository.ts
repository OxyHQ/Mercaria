/**
 * `entitlement_usage_counters` — the transactionally safe half of a limit (#89
 * entitlement rule 3).
 *
 * ## The consume is ONE statement, and its empty result IS the refusal
 *
 * {@link consumeEntitlementUsage} is a single conditional upsert: it creates the
 * counter at `amount` when none exists and increments it otherwise, with a
 * `WHERE` on the conflict branch that refuses to take the total past the limit.
 * An empty `RETURNING` set is "the limit would have been exceeded" — the same
 * device the eBay call budget and the moderation event store use, and the reason
 * it has to be one statement is that a read-then-write leaves a window two
 * concurrent consumers both fit through.
 *
 * The LIMIT is a parameter and is deliberately not a column. It lives on the
 * plan version (immutable) or on the grant; storing a copy here would create a
 * second representation of one fact, and the copy would be the stale one every
 * time a merchant changed plan.
 *
 * `excluded.<col>` is spelled OUT in the increment. Interpolating the drizzle
 * column object emits the JavaScript PROPERTY name, which Postgres folds to
 * lower case and then cannot resolve — a runtime 42703 on a statement `tsc`
 * accepts (`~/Oxy/AGENTS.md`).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { MerchantEntitlementCapability } from '@mercaria/shared-types';
import { entitlementUsageCounters } from '../schema/merchantPlans.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `entitlement_usage_counters`. */
export type EntitlementUsageRow = typeof entitlementUsageCounters.$inferSelect;

/** The `used` column's SQL name, for the `excluded.` reference below. */
const USED_COLUMN = sqlColumnName(entitlementUsageCounters.used);

/**
 * Consume `amount` of one store's allowance for one capability in one period.
 *
 * @param limit The ceiling the caller resolved from the plan or the grant, or
 *   `null` for unlimited — in which case the counter still moves, because a
 *   merchant's usage view is worth having whether or not there is a bound.
 * @returns The counter after the increment, or `undefined` when the increment
 *   would have exceeded the limit and therefore did not happen.
 */
export async function consumeEntitlementUsage(
  db: DatabaseOrTransaction,
  input: {
    storeId: string;
    capabilityKey: MerchantEntitlementCapability;
    periodKey: string;
    amount: number;
    limit: number | null;
  },
): Promise<EntitlementUsageRow | undefined> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new RangeError(
      `Consuming entitlement usage needs a positive whole amount; received ${String(input.amount)}.`,
    );
  }
  // The insert branch creates the counter at `amount`, so a first use over an
  // already-exhausted limit has to be refused here rather than by the conflict
  // branch's `WHERE`, which never runs when there is no conflict.
  if (input.limit !== null && input.amount > input.limit) return undefined;

  const [row] = await db
    .insert(entitlementUsageCounters)
    .values({
      storeId: input.storeId,
      capabilityKey: input.capabilityKey,
      periodKey: input.periodKey,
      used: input.amount,
    })
    .onConflictDoUpdate({
      target: [
        entitlementUsageCounters.storeId,
        entitlementUsageCounters.capabilityKey,
        entitlementUsageCounters.periodKey,
      ],
      set: {
        used: sql`${entitlementUsageCounters.used} + ${sql.raw(`excluded.${USED_COLUMN}`)}`,
      },
      ...(input.limit === null
        ? {}
        : {
            setWhere: sql`${entitlementUsageCounters.used} + ${sql.raw(`excluded.${USED_COLUMN}`)} <= ${input.limit}`,
          }),
    })
    .returning();
  return row;
}

/** One counter, or `undefined` when nothing has been consumed yet. */
export async function findEntitlementUsage(
  db: DatabaseOrTransaction,
  input: { storeId: string; capabilityKey: MerchantEntitlementCapability; periodKey: string },
): Promise<EntitlementUsageRow | undefined> {
  const [row] = await db
    .select()
    .from(entitlementUsageCounters)
    .where(
      and(
        eq(entitlementUsageCounters.storeId, input.storeId),
        eq(entitlementUsageCounters.capabilityKey, input.capabilityKey),
        eq(entitlementUsageCounters.periodKey, input.periodKey),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Every counter for one store across a set of periods — the usage view.
 *
 * A `total` limit and a `per_period` one live in the same table under different
 * period keys, so the caller passes both keys it cares about rather than this
 * function guessing which kind each capability is.
 */
export async function listEntitlementUsage(
  db: DatabaseOrTransaction,
  input: { storeId: string; periodKeys: readonly string[] },
): Promise<EntitlementUsageRow[]> {
  if (input.periodKeys.length === 0) return [];
  return await db
    .select()
    .from(entitlementUsageCounters)
    .where(
      and(
        eq(entitlementUsageCounters.storeId, input.storeId),
        inArray(entitlementUsageCounters.periodKey, [...input.periodKeys]),
      ),
    );
}
