import { describe, expect, it } from 'vitest';
import { BUYER_ORDER_VIEW_BY_STATUS, ORDER_STATUSES } from '@mercaria/shared-types';
import { buyerOrderListQuerySchema } from '../schemas.js';

describe('buyer order history query', () => {
  it.each(['active', 'past'] as const)('accepts the %s view with pagination', (view) => {
    expect(buyerOrderListQuerySchema.parse({ view, page: '2', limit: '10' })).toEqual({
      view,
      page: 2,
      limit: 10,
    });
  });

  it('keeps an omitted view unfiltered for existing clients', () => {
    expect(buyerOrderListQuerySchema.parse({})).not.toHaveProperty('view');
  });

  it.each(['', 'all', 'archived', ['active', 'past'], { value: 'active' }])(
    'rejects malformed or unsupported view %j',
    (view) => {
      expect(buyerOrderListQuerySchema.safeParse({ view }).success).toBe(false);
    },
  );

  it('assigns every lifecycle state exactly one history view', () => {
    expect(Object.keys(BUYER_ORDER_VIEW_BY_STATUS).sort()).toEqual([...ORDER_STATUSES].sort());
    expect(new Set(Object.values(BUYER_ORDER_VIEW_BY_STATUS))).toEqual(new Set(['active', 'past']));
  });
});
