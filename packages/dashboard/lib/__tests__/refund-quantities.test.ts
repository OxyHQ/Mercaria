import { describe, expect, it } from 'vitest';
import type { Refund } from '@mercaria/shared-types';
import { parseRefundQuantity, remainingRefundQuantities } from '../refund-quantities';

describe('refund quantities follow the existing server cumulative guard', () => {
  it('counts every recorded line, including provider pending/failed, with or without restock', () => {
    const refunds = [
      { status: 'refunded', providerState: 'pending', lineItems: [{ variantId: 'a', quantity: 1, restock: false }] },
      { status: 'refunded', providerState: 'failed', lineItems: [{ variantId: 'a', quantity: 2, restock: true }] },
      { status: 'approved', lineItems: [{ variantId: 'b', quantity: 2, restock: false }] },
    ] as Refund[];
    const remaining = remainingRefundQuantities([{ variantId: 'a', quantity: 5 }, { variantId: 'b', quantity: 2 }], refunds);
    expect([...remaining]).toEqual([['a', 2], ['b', 0]]);
  });
  it.each(['2.5', '2items', '-1', '1e2', '9007199254740992', '4'])('rejects %s rather than truncating or clamping to the available three', value => {
    expect(parseRefundQuantity(value, 3)).toBeNull();
  });
  it.each([['', 0], [' ', 0], ['0', 0], [' 3 ', 3], ['003', 3]] as const)('preserves valid selection %j', (value, quantity) => {
    expect(parseRefundQuantity(value, 3)).toBe(quantity);
  });
  it('does not restore quantities because prior rows exceed the order', () => {
    expect(remainingRefundQuantities([{ variantId: 'a', quantity: 1 }], [{ lineItems: [{ variantId: 'a', quantity: 2 }] }] as Refund[]).get('a')).toBe(0);
  });
});
