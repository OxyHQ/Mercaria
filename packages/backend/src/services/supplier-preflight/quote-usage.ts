/**
 * A quote's usage state, DERIVED (#122 quote field 9).
 *
 * #122 lists "usage state" among the fields a durable quote carries, and this
 * domain answers it with a derivation rather than a column, for the reason
 * every other Oxy domain does: `consumed_at`, `released_at`,
 * `superseded_by_quote_id` and `expires_at` already state it completely, so a
 * stored verdict beside them would be two representations of one fact — and the
 * place they must not disagree is a checkout gate deciding whether money may
 * move. `retail_cost_quotes` keeps expiry off the row for the same reason, and
 * `procurement_offers` keeps freshness off it.
 *
 * The severity order is `consumed` > `released` > `superseded` > `expired` >
 * `open`, and it is not arbitrary: the first three are FACTS about what
 * happened to the quote, while `expired` is a fact about the clock. A consumed
 * quote that has since passed its deadline is still consumed — reporting it as
 * expired would say an order was never funded.
 */

import type { SupplierQuoteUsage } from '@mercaria/shared-types';

/** The four timestamps and the pointer that state a quote's usage completely. */
export interface SupplierQuoteUsageFacts {
  consumedAt: Date | null;
  releasedAt: Date | null;
  supersededByQuoteId: string | null;
  expiresAt: Date;
}

/** Derive the usage. Pure — same answer for a row and for a fixture. */
export function deriveSupplierQuoteUsage(
  facts: SupplierQuoteUsageFacts,
  now: Date = new Date(),
): SupplierQuoteUsage {
  if (facts.consumedAt) return 'consumed';
  if (facts.releasedAt) return 'released';
  if (facts.supersededByQuoteId) return 'superseded';
  if (facts.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'open';
}

/**
 * Whether a quote may still be used to fund an order.
 *
 * Exactly one usage qualifies. Written as an equality against `open` rather
 * than as a list of disqualifications, so a usage added later fails closed —
 * a new terminal state would otherwise silently become usable.
 */
export function isSupplierQuoteUsable(
  facts: SupplierQuoteUsageFacts,
  now: Date = new Date(),
): boolean {
  return deriveSupplierQuoteUsage(facts, now) === 'open';
}
