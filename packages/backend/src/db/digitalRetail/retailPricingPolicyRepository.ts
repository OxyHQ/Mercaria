/**
 * The only writer of `digital_retail_pricing_policies` (#1016 Workstream 5,
 * ADR 0011).
 *
 * ONE active policy per market × product class, held by a partial unique index —
 * so "which policy priced this" has exactly one answer at any moment, and the
 * question never resolves by ordering or by `limit 1` over a tie.
 */

import { and, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { DigitalRetailProductClass } from '@mercaria/shared-types';
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
