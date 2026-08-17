/**
 * The versioned reconciliation policy and its per-currency tolerances (#128).
 *
 * The `retail_pricing_policies` shape one stage later: a version is immutable
 * once active (a database trigger, not a review), at most one is `active` per
 * key (a partial unique index), and a policy change is a NEW version — because
 * orders were reconciled under the old one and a mutable version would silently
 * restate what they were reconciled against.
 *
 * The tolerances are a CHILD table and are written in the SAME transaction as
 * the draft they belong to: a version with no tolerance for a currency cannot
 * reconcile an order in it, so half a policy is not a state worth allowing to
 * exist.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import {
  RETAIL_ADJUSTMENT_DEFAULT_AUTOMATION_FLOOR_MINOR,
  RETAIL_RECONCILIATION_DEFAULT_TOLERANCE_MINOR,
  type RetailAdjustmentFinalityDisposition,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  retailReconciliationPolicies,
  retailReconciliationTolerances,
} from '../schema/retailReconciliation.js';

/** One policy version, as stored. */
export type RetailReconciliationPolicyRow = typeof retailReconciliationPolicies.$inferSelect;
/** One currency's tolerance and automation floor under one version. */
export type RetailReconciliationToleranceRow = typeof retailReconciliationTolerances.$inferSelect;

/** A version and every tolerance it publishes — what a reconciliation reads. */
export interface RetailReconciliationPolicyWithTolerances {
  policy: RetailReconciliationPolicyRow;
  tolerances: readonly RetailReconciliationToleranceRow[];
}

/** One currency's numbers on a draft. */
export interface NewRetailReconciliationTolerance {
  currency: CurrencyCode;
  toleranceMinor: number;
  automationFloorMinor: number;
}

/** Everything a draft version states. */
export interface NewRetailReconciliationPolicy {
  policyKey: string;
  version: number;
  name: string;
  summary: string;
  effectiveStart: Date;
  effectiveEnd?: Date;
  absorbedVarianceAlertBps: number;
  absorbedVarianceAlertFloor: { amount: number; currency: CurrencyCode };
  recurringVarianceCount: number;
  recurringVarianceWindowHours: number;
  finalityCeilingDays: number;
  subThresholdDisposition: RetailAdjustmentFinalityDisposition;
  createdByOxyUserId: string;
  tolerances: readonly NewRetailReconciliationTolerance[];
}

/**
 * The tolerances a draft gets when the operator names none for a currency.
 *
 * One hundredth of a major unit as the tolerance and one whole major unit as the
 * automation floor, both per currency — the figures
 * `RETAIL_RECONCILIATION_DEFAULT_TOLERANCE_MINOR` and
 * `RETAIL_ADJUSTMENT_DEFAULT_AUTOMATION_FLOOR_MINOR` derive from
 * `CURRENCY_PRECISION`, so a currency added to the set gets sensible numbers
 * without anybody remembering to add a row here.
 */
export function defaultToleranceFor(currency: CurrencyCode): NewRetailReconciliationTolerance {
  return {
    currency,
    toleranceMinor: RETAIL_RECONCILIATION_DEFAULT_TOLERANCE_MINOR[currency],
    automationFloorMinor: RETAIL_ADJUSTMENT_DEFAULT_AUTOMATION_FLOOR_MINOR[currency],
  };
}

/**
 * Write one DRAFT version and its tolerances, atomically.
 *
 * A draft, always. Activation is a separate, attributed act
 * ({@link activateRetailReconciliationPolicy}) because ADR 0004's policy shape
 * is "publish a new version, with a name on it" and a create-and-activate call
 * would make the audit optional.
 */
export async function insertRetailReconciliationPolicy(
  input: NewRetailReconciliationPolicy,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationPolicyRow> {
  const id = uuidv7();
  const [row] = await db
    .insert(retailReconciliationPolicies)
    .values({
      id,
      policyKey: input.policyKey,
      version: input.version,
      name: input.name,
      summary: input.summary,
      status: 'draft',
      effectiveStart: input.effectiveStart,
      ...(input.effectiveEnd ? { effectiveEnd: input.effectiveEnd } : {}),
      absorbedVarianceAlertBps: input.absorbedVarianceAlertBps,
      absorbedVarianceAlertFloorAmount: input.absorbedVarianceAlertFloor.amount,
      absorbedVarianceAlertFloorCurrency: input.absorbedVarianceAlertFloor.currency,
      recurringVarianceCount: input.recurringVarianceCount,
      recurringVarianceWindowHours: input.recurringVarianceWindowHours,
      finalityCeilingDays: input.finalityCeilingDays,
      subThresholdDisposition: input.subThresholdDisposition,
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) throw new Error('The reconciliation policy insert returned no row.');

  if (input.tolerances.length > 0) {
    await db.insert(retailReconciliationTolerances).values(
      input.tolerances.map((tolerance) => ({
        id: uuidv7(),
        policyId: id,
        currency: tolerance.currency,
        toleranceMinor: tolerance.toleranceMinor,
        automationFloorMinor: tolerance.automationFloorMinor,
      })),
    );
  }
  return row;
}

/**
 * Activate a draft, superseding whatever was active under the same key.
 *
 * The supersede runs FIRST and in the same transaction, because
 * `retail_reconciliation_policies_one_active_per_key` would refuse the
 * activation otherwise — which is the index doing its job rather than an
 * ordering nicety, and the reason two operators racing to publish converge on
 * one active version instead of both succeeding.
 */
export async function activateRetailReconciliationPolicy(
  input: { id: string; approvedByOxyUserId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationPolicyRow | undefined> {
  const now = input.now ?? new Date();
  const [draft] = await db
    .select()
    .from(retailReconciliationPolicies)
    .where(eq(retailReconciliationPolicies.id, input.id))
    .limit(1);
  if (!draft || draft.status !== 'draft') return undefined;

  await db
    .update(retailReconciliationPolicies)
    .set({ status: 'superseded', effectiveEnd: now })
    .where(
      and(
        eq(retailReconciliationPolicies.policyKey, draft.policyKey),
        eq(retailReconciliationPolicies.status, 'active'),
      ),
    );

  const [row] = await db
    .update(retailReconciliationPolicies)
    .set({ status: 'active', approvedByOxyUserId: input.approvedByOxyUserId, activatedAt: now })
    .where(
      and(
        eq(retailReconciliationPolicies.id, input.id),
        eq(retailReconciliationPolicies.status, 'draft'),
      ),
    )
    .returning();
  return row;
}

/** The active version under one key, with its tolerances. `undefined` when none is. */
export async function findActiveRetailReconciliationPolicy(
  policyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationPolicyWithTolerances | undefined> {
  const [policy] = await db
    .select()
    .from(retailReconciliationPolicies)
    .where(
      and(
        eq(retailReconciliationPolicies.policyKey, policyKey),
        eq(retailReconciliationPolicies.status, 'active'),
      ),
    )
    .limit(1);
  if (!policy) return undefined;

  const tolerances = await db
    .select()
    .from(retailReconciliationTolerances)
    .where(eq(retailReconciliationTolerances.policyId, policy.id))
    .orderBy(asc(retailReconciliationTolerances.currency));
  return { policy, tolerances };
}

/** Every version under one key, newest first — the operator list. */
export async function listRetailReconciliationPolicies(
  policyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationPolicyWithTolerances[]> {
  const policies = await db
    .select()
    .from(retailReconciliationPolicies)
    .where(eq(retailReconciliationPolicies.policyKey, policyKey))
    .orderBy(sql`${retailReconciliationPolicies.version} desc`);
  if (policies.length === 0) return [];

  const tolerances = await db
    .select()
    .from(retailReconciliationTolerances)
    .orderBy(asc(retailReconciliationTolerances.currency));
  const byPolicy = new Map<string, RetailReconciliationToleranceRow[]>();
  for (const tolerance of tolerances) {
    const list = byPolicy.get(tolerance.policyId) ?? [];
    list.push(tolerance);
    byPolicy.set(tolerance.policyId, list);
  }
  return policies.map((policy) => ({ policy, tolerances: byPolicy.get(policy.id) ?? [] }));
}
