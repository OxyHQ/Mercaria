import type { OrderItem, Refund } from '@mercaria/shared-types';

/** Mirrors refundRepository.sumRefundedQuantities: every recorded line counts,
 * independently of commerce status, provider outcome and whether it was restocked.
 * The server remains authoritative and checks again at submission. */
export function remainingRefundQuantities(
  items: readonly Pick<OrderItem, 'variantId' | 'quantity'>[],
  refunds: readonly Pick<Refund, 'lineItems'>[],
): Map<string, number> {
  const remaining = new Map(items.map((item) => [item.variantId, item.quantity]));
  for (const refund of refunds)
    for (const line of refund.lineItems) {
      if (remaining.has(line.variantId))
        remaining.set(line.variantId, Math.max(0, remaining.get(line.variantId)! - line.quantity));
    }
  return remaining;
}

/** An empty selection means zero; malformed or excessive selections are errors. */
export function parseRefundQuantity(raw: string, remaining: number): number | null {
  const value = raw.trim();
  if (value === '') return 0;
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity <= remaining ? quantity : null;
}
