/**
 * The only writer of `digital_retail_pricing_policies` (#1016 Workstream 5,
 * ADR 0011).
 *
 * ONE active policy per market × product class, held by a partial unique index —
 * so "which policy priced this" has exactly one answer at any moment, and the
 * question never resolves by ordering or by `limit 1` over a tie.
 */

import { and, eq, ne } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  DigitalRetailProductClass,
  DigitalRetailRoundingMode,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { digitalRetailPricingPolicies } from '../schema/digitalRetail.js';

export type DigitalRetailPricingPolicyRow = InferSelectModel<typeof digitalRetailPricingPolicies>;

/**
 * The active policy for one market and product class, or null.
 *
 * Null is a REFUSAL, not a default: `priceDigitalRetailOffer` answers `no_policy`
 * and nothing is published. A fallback policy would mean a market launching with
 * a margin nobody approved, which is the one thing the versioning exists to stop.
 */
export async function findActivePricingPolicy(
  market: string,
  productClass: DigitalRetailProductClass,
  tx?: DatabaseOrTransaction,
): Promise<DigitalRetailPricingPolicyRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalRetailPricingPolicies)
    .where(
      and(
        eq(digitalRetailPricingPolicies.market, market.toUpperCase()),
        eq(digitalRetailPricingPolicies.productClass, productClass),
        eq(digitalRetailPricingPolicies.status, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One policy version by id — what a price snapshot names. */
export async function findPricingPolicy(
  id: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalRetailPricingPolicyRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalRetailPricingPolicies)
    .where(eq(digitalRetailPricingPolicies.id, id))
    .limit(1);
  return row ?? null;
}

/** What an operator drafts when a market's pricing is approved. */
export interface NewDigitalRetailPricingPolicy {
  readonly policyKey: string;
  readonly version: number;
  readonly name: string;
  readonly summary: string;
  /** ISO-3166-1 alpha-2. Upper-cased here. */
  readonly market: string;
  readonly productClass: DigitalRetailProductClass;
  readonly currency: string;
  readonly marginFloorBps: number;
  readonly marginCeilingBps: number;
  readonly paymentCostBps?: number;
  readonly paymentCostFixedMinor?: number;
  readonly roundingMode?: DigitalRetailRoundingMode;
  readonly priceCeilingMinor?: number | null;
  readonly effectiveStart: Date;
  readonly effectiveEnd?: Date | null;
  readonly createdByOxyUserId: string;
}

/**
 * Draft a policy version. It prices NOTHING until it is activated.
 *
 * The draft/activate split is the `retail_pricing_policies` shape and exists for
 * its reason: a margin band is a commercial decision, and the row that records it
 * should be reviewable before it is the answer a storefront gives.
 */
export async function createPricingPolicyDraft(
  input: NewDigitalRetailPricingPolicy,
  tx?: DatabaseOrTransaction,
): Promise<DigitalRetailPricingPolicyRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(digitalRetailPricingPolicies)
    .values({
      policyKey: input.policyKey,
      version: input.version,
      name: input.name,
      summary: input.summary,
      market: input.market.toUpperCase(),
      productClass: input.productClass,
      currency: input.currency as DigitalRetailPricingPolicyRow['currency'],
      marginFloorBps: input.marginFloorBps,
      marginCeilingBps: input.marginCeilingBps,
      paymentCostBps: input.paymentCostBps ?? 0,
      paymentCostFixedMinor: input.paymentCostFixedMinor ?? 0,
      roundingMode: input.roundingMode ?? 'minor_unit',
      priceCeilingMinor: input.priceCeilingMinor ?? null,
      effectiveStart: input.effectiveStart,
      effectiveEnd: input.effectiveEnd ?? null,
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) throw new Error(`pricing policy ${input.policyKey} v${input.version} was not written`);
  return row;
}

/**
 * Activate a draft, superseding whatever was active for that market and class.
 *
 * ONE transaction, and the supersede happens FIRST: the partial unique index
 * admits one active row per (market, product class), so activating without
 * standing the old one down would fail the write — which is the right failure,
 * and this is the path that does it in the right order rather than asking every
 * caller to remember.
 */
export async function activatePricingPolicy(
  policyId: string,
  approvedByOxyUserId: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<DigitalRetailPricingPolicyRow | null> {
  const run = async (
    db: DatabaseOrTransaction,
  ): Promise<DigitalRetailPricingPolicyRow | null> => {
    const [draft] = await db
      .select()
      .from(digitalRetailPricingPolicies)
      .where(eq(digitalRetailPricingPolicies.id, policyId))
      .limit(1);
    if (!draft || draft.status !== 'draft') return null;

    await db
      .update(digitalRetailPricingPolicies)
      .set({ status: 'superseded', updatedAt: now })
      .where(
        and(
          eq(digitalRetailPricingPolicies.market, draft.market),
          eq(digitalRetailPricingPolicies.productClass, draft.productClass),
          eq(digitalRetailPricingPolicies.status, 'active'),
          ne(digitalRetailPricingPolicies.id, policyId),
        ),
      );

    const [row] = await db
      .update(digitalRetailPricingPolicies)
      .set({ status: 'active', activatedAt: now, approvedByOxyUserId, updatedAt: now })
      .where(
        and(
          eq(digitalRetailPricingPolicies.id, policyId),
          eq(digitalRetailPricingPolicies.status, 'draft'),
        ),
      )
      .returning();
    return row ?? null;
  };
  const db = tx ?? getDb();
  return 'transaction' in db ? db.transaction(run) : run(db);
}
