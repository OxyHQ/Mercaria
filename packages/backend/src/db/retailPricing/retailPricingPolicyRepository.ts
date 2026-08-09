/**
 * Retail pricing policy versions (#120 quote field 15, ADR 0004 D3.7).
 *
 * The `feeScheduleRepository` shape, and deliberately so: a versioned
 * commercial policy where `draft` is the only editable state, activation
 * supersedes the key's current active version in ONE transaction, and the
 * database — not this module — refuses an edit to a published version.
 *
 * ## Nothing here can widen the policy beyond the eight allowed components
 *
 * `insertRetailPricingPolicy` takes `allowedComponentKinds` typed as
 * `RetailCostComponentKind[]`, the column's CHECK re-verifies containment
 * against the same tuple, and there is no other lever: no markup, no margin, no
 * profit floor and no padding parameter exists on any function in this file.
 */

import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { CurrencyCode, RetailCostComponentKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { retailPricingPolicies } from '../schema/retailPricing.js';

/** One policy row, whole — the table has no protected columns. */
export type RetailPricingPolicyRecord = typeof retailPricingPolicies.$inferSelect;

/** What a new DRAFT policy version is created from. */
export interface NewRetailPricingPolicy {
  policyKey: string;
  version: number;
  name: string;
  summary: string;
  effectiveStart: Date;
  effectiveEnd?: Date;
  allowedComponentKinds: RetailCostComponentKind[];
  paymentCostPassthroughEnabled?: boolean;
  paymentCostPassthroughBasis?: string;
  absorptionCapBps?: number;
  absorptionCapFloor?: { amount: number; currency: CurrencyCode };
  roundingToleranceMinor?: number;
  quoteTtlSeconds?: number;
  createdByOxyUserId: string;
}

/**
 * ADR 0004 D3's default absorption cap: the greater of 10% of the order total
 * and 25 EUR. Carried here as the DRAFT default only — a policy version states
 * its own, and the one an order is priced under is whatever its version said.
 */
const DEFAULT_ABSORPTION_CAP_FLOOR = { amount: 2_500, currency: 'EUR' as CurrencyCode };

/** Draft a new policy version. Publishing it is a separate, audited step. */
export async function insertRetailPricingPolicy(
  db: DatabaseOrTransaction,
  input: NewRetailPricingPolicy,
): Promise<RetailPricingPolicyRecord> {
  const floor = input.absorptionCapFloor ?? DEFAULT_ABSORPTION_CAP_FLOOR;
  const [row] = await db
    .insert(retailPricingPolicies)
    .values({
      policyKey: input.policyKey,
      version: input.version,
      name: input.name,
      summary: input.summary,
      effectiveStart: input.effectiveStart,
      effectiveEnd: input.effectiveEnd ?? null,
      allowedComponentKinds: input.allowedComponentKinds,
      paymentCostPassthroughEnabled: input.paymentCostPassthroughEnabled ?? false,
      paymentCostPassthroughBasis: input.paymentCostPassthroughBasis ?? null,
      ...(input.absorptionCapBps !== undefined ? { absorptionCapBps: input.absorptionCapBps } : {}),
      absorptionCapFloorAmount: floor.amount,
      absorptionCapFloorCurrency: floor.currency,
      ...(input.roundingToleranceMinor !== undefined
        ? { roundingToleranceMinor: input.roundingToleranceMinor }
        : {}),
      ...(input.quoteTtlSeconds !== undefined ? { quoteTtlSeconds: input.quoteTtlSeconds } : {}),
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) throw new Error('insertRetailPricingPolicy returned no row');
  return row;
}

/** Every version of every policy (or of one key), newest first. */
export async function listRetailPricingPolicies(
  db: DatabaseOrTransaction,
  filter?: { policyKey: string },
): Promise<RetailPricingPolicyRecord[]> {
  const query = db.select().from(retailPricingPolicies);
  const rows = filter
    ? await query
        .where(eq(retailPricingPolicies.policyKey, filter.policyKey))
        .orderBy(desc(retailPricingPolicies.createdAt))
    : await query.orderBy(desc(retailPricingPolicies.createdAt));
  return rows;
}

/**
 * The version in force at `at`, or none.
 *
 * The partial unique index holds at most ONE active row per key, so this reads
 * a single row rather than resolving a conflict — and if several KEYS are ever
 * active at once, the caller names the key. Selection by window is re-checked
 * here because `active` and "inside its effective window" are different facts:
 * a version activated ahead of its start date is active and not yet in force.
 */
export async function findActiveRetailPricingPolicy(
  db: DatabaseOrTransaction,
  input: { policyKey: string; at?: Date },
): Promise<RetailPricingPolicyRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .select()
    .from(retailPricingPolicies)
    .where(
      and(
        eq(retailPricingPolicies.policyKey, input.policyKey),
        eq(retailPricingPolicies.status, 'active'),
        lte(retailPricingPolicies.effectiveStart, at),
        // `gt`, never a raw `sql` template: a JS `Date` handed to an expression
        // is passed as an unmapped parameter and postgres.js refuses it at
        // runtime (`CONVENTIONS.md` §"A Date is not a safe parameter against an
        // EXPRESSION"). The operator carries the column's own type mapping.
        or(isNull(retailPricingPolicies.effectiveEnd), gt(retailPricingPolicies.effectiveEnd, at)),
      ),
    )
    .limit(1);
  return row;
}

/** One version by row id — the operator surface's addressing. */
export async function findRetailPricingPolicyById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<RetailPricingPolicyRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailPricingPolicies)
    .where(eq(retailPricingPolicies.id, id))
    .limit(1);
  return row;
}

/**
 * Publish a draft, superseding the key's current active version in the SAME
 * transaction.
 *
 * Both statements are CAS: the supersede matches `status = 'active'` and the
 * activation matches `status = 'draft'`, so two concurrent activations produce
 * exactly one winner and the loser sees `undefined` rather than transiently
 * leaving a key with two active versions (which the partial unique index would
 * refuse anyway — the CAS is what makes the refusal a clean answer instead of a
 * constraint error).
 */
export async function activateRetailPricingPolicy(
  db: DatabaseOrTransaction,
  input: { id: string; approvedByOxyUserId: string; at?: Date },
): Promise<RetailPricingPolicyRecord | undefined> {
  const at = input.at ?? new Date();
  return await db.transaction(async (tx) => {
    const draft = await findRetailPricingPolicyById(tx, input.id);
    if (!draft || draft.status !== 'draft') return undefined;

    await tx
      .update(retailPricingPolicies)
      .set({ status: 'superseded', updatedAt: at })
      .where(
        and(
          eq(retailPricingPolicies.policyKey, draft.policyKey),
          eq(retailPricingPolicies.status, 'active'),
        ),
      );

    const [row] = await tx
      .update(retailPricingPolicies)
      .set({
        status: 'active',
        approvedByOxyUserId: input.approvedByOxyUserId,
        activatedAt: at,
        updatedAt: at,
      })
      .where(and(eq(retailPricingPolicies.id, input.id), eq(retailPricingPolicies.status, 'draft')))
      .returning();
    return row;
  });
}

/** Withdraw an active version, or abandon a draft, without a replacement. */
export async function retireRetailPricingPolicy(
  db: DatabaseOrTransaction,
  id: string,
  at: Date = new Date(),
): Promise<RetailPricingPolicyRecord | undefined> {
  const [row] = await db
    .update(retailPricingPolicies)
    .set({ status: 'retired', updatedAt: at })
    .where(
      and(
        eq(retailPricingPolicies.id, id),
        or(eq(retailPricingPolicies.status, 'draft'), eq(retailPricingPolicies.status, 'active')),
      ),
    )
    .returning();
  return row;
}
