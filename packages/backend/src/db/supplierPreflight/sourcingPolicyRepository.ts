/**
 * Publishing and reading versions of the deterministic sourcing policy (#122
 * selection 1).
 *
 * The `retail_pricing_policies` / `fee_schedules` repository, third instance:
 * a draft is editable, activation freezes it (a trigger), and the incumbent is
 * superseded in the SAME transaction as the new version becomes active — so
 * the one-active-per-key partial unique never sees two, and a reader between
 * the two statements cannot observe a key with no active version.
 */

import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { SupplierAdapterCapability, SupplierSourcingCriterion } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { supplierSourcingPolicies } from '../schema/supplierPreflight.js';

/** One sourcing policy version. */
export type SupplierSourcingPolicyRow = typeof supplierSourcingPolicies.$inferSelect;

/** What an operator may set when drafting a version. */
export interface NewSupplierSourcingPolicy {
  policyKey: string;
  version: number;
  name: string;
  summary: string;
  effectiveStart: Date;
  effectiveEnd: Date | null;
  rankingCriteria: readonly SupplierSourcingCriterion[];
  requiredCapabilities: readonly SupplierAdapterCapability[];
  maxSourcingAttempts: number;
  maxSupplierShareBps: number;
  quoteTtlSeconds: number;
  providerTimeoutMs: number;
  maxProviderConcurrency: number;
  maxProviderCallsPerMinute: number;
  healthWindowMinutes: number;
  healthMinimumSamples: number;
  healthMaxFailureBps: number;
  healthSuppressionMinutes: number;
  createdByOxyUserId: string;
}

/** Draft a version. It is inert until activated. */
export async function insertSupplierSourcingPolicy(
  input: NewSupplierSourcingPolicy,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingPolicyRow> {
  const [row] = await db
    .insert(supplierSourcingPolicies)
    .values({
      policyKey: input.policyKey,
      version: input.version,
      name: input.name,
      summary: input.summary,
      effectiveStart: input.effectiveStart,
      effectiveEnd: input.effectiveEnd,
      rankingCriteria: [...input.rankingCriteria],
      requiredCapabilities: [...input.requiredCapabilities],
      maxSourcingAttempts: input.maxSourcingAttempts,
      maxSupplierShareBps: input.maxSupplierShareBps,
      quoteTtlSeconds: input.quoteTtlSeconds,
      providerTimeoutMs: input.providerTimeoutMs,
      maxProviderConcurrency: input.maxProviderConcurrency,
      maxProviderCallsPerMinute: input.maxProviderCallsPerMinute,
      healthWindowMinutes: input.healthWindowMinutes,
      healthMinimumSamples: input.healthMinimumSamples,
      healthMaxFailureBps: input.healthMaxFailureBps,
      healthSuppressionMinutes: input.healthSuppressionMinutes,
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) throw new Error('Supplier sourcing policy insert returned no row.');
  return row;
}

/**
 * The version in force for one key at one instant.
 *
 * The effective window is applied HERE and not left to the caller, so a version
 * activated for a future start cannot be selected under, and one whose end has
 * passed stops being selected under with no sweep having run — the
 * `supplier_agreements` window rule.
 */
export async function findActiveSupplierSourcingPolicy(
  input: { policyKey: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingPolicyRow | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .select()
    .from(supplierSourcingPolicies)
    .where(
      and(
        eq(supplierSourcingPolicies.policyKey, input.policyKey),
        eq(supplierSourcingPolicies.status, 'active'),
        lte(supplierSourcingPolicies.effectiveStart, at),
        or(
          isNull(supplierSourcingPolicies.effectiveEnd),
          gt(supplierSourcingPolicies.effectiveEnd, at),
        ),
      ),
    )
    .limit(1);
  return row;
}

/** One version by id. */
export async function findSupplierSourcingPolicyById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingPolicyRow | undefined> {
  const [row] = await db
    .select()
    .from(supplierSourcingPolicies)
    .where(eq(supplierSourcingPolicies.id, id))
    .limit(1);
  return row;
}

/** Every version of every key, newest first — the operator list. */
export async function listSupplierSourcingPolicies(
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingPolicyRow[]> {
  return db
    .select()
    .from(supplierSourcingPolicies)
    .orderBy(asc(supplierSourcingPolicies.policyKey), desc(supplierSourcingPolicies.version));
}

/**
 * Publish a draft, superseding the incumbent in ONE transaction.
 *
 * The order matters and is the reason this is a transaction rather than two
 * calls: the incumbent is stood down FIRST, because the partial unique index
 * permits exactly one active row per key and activating first would be refused
 * by Postgres. A reader in between sees the pre-transaction state, never a key
 * with no active version.
 */
export async function activateSupplierSourcingPolicy(
  input: { policyId: string; approvedByOxyUserId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingPolicyRow> {
  const now = input.now ?? new Date();

  const run = async (tx: DatabaseOrTransaction): Promise<SupplierSourcingPolicyRow> => {
    const draft = await findSupplierSourcingPolicyById(input.policyId, tx);
    if (!draft) throw new Error(`Supplier sourcing policy ${input.policyId} does not exist.`);
    if (draft.status !== 'draft') {
      throw new Error(
        `Supplier sourcing policy ${input.policyId} is \`${draft.status}\`; only a draft can be ` +
          'activated. A published version is immutable — publish a NEW version instead.',
      );
    }

    await tx
      .update(supplierSourcingPolicies)
      .set({ status: 'superseded', updatedAt: now })
      .where(
        and(
          eq(supplierSourcingPolicies.policyKey, draft.policyKey),
          eq(supplierSourcingPolicies.status, 'active'),
        ),
      );

    const [activated] = await tx
      .update(supplierSourcingPolicies)
      .set({
        status: 'active',
        approvedByOxyUserId: input.approvedByOxyUserId,
        activatedAt: now,
        updatedAt: now,
      })
      .where(eq(supplierSourcingPolicies.id, input.policyId))
      .returning();
    if (!activated) throw new Error('Supplier sourcing policy activation returned no row.');
    return activated;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Withdraw a version without replacing it. */
export async function retireSupplierSourcingPolicy(
  input: { policyId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierSourcingPolicyRow | undefined> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(supplierSourcingPolicies)
    .set({ status: 'retired', updatedAt: now })
    .where(
      and(
        eq(supplierSourcingPolicies.id, input.policyId),
        sql`${supplierSourcingPolicies.status} in ('draft', 'active')`,
      ),
    )
    .returning();
  return row;
}
