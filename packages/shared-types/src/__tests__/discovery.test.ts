import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_COUNTED_ORDER_STATUSES,
  DISCOVERY_SIGNALS,
  DISCOVERY_SIGNALS_FROM_LISTINGS,
  DISCOVERY_SIGNALS_FROM_COUNTS,
  DISCOVERY_WINDOWS,
} from '../discovery';
import { ORDER_STATUSES } from '../order';

describe('discovery vocabularies', () => {
  it('splits the signals into exactly the two storage sources, with no overlap and no orphan', () => {
    // The split is the whole design: three signals read `listings`, two read
    // `discovery_signals`. A signal in neither has no query behind it; a signal
    // in both has two that can disagree.
    const union = [...DISCOVERY_SIGNALS_FROM_LISTINGS, ...DISCOVERY_SIGNALS_FROM_COUNTS];
    expect([...union].sort()).toEqual([...DISCOVERY_SIGNALS].sort());
    expect(new Set(union).size).toBe(union.length);
  });

  it('counts exactly the five order statuses that are sales', () => {
    expect([...DISCOVERY_COUNTED_ORDER_STATUSES].sort()).toEqual([
      'delivered',
      'paid',
      'partially_refunded',
      'processing',
      'shipped',
    ]);
  });

  it('excludes the three statuses that are not sales, naming each', () => {
    // Asserted as an EXCLUSION rather than by the count above, because a set
    // that silently gained `cancelled` would still have five members if one of
    // the real five were dropped in the same edit.
    for (const status of ['pending_payment', 'cancelled', 'refunded'] as const) {
      expect(DISCOVERY_COUNTED_ORDER_STATUSES).not.toContain(status);
    }
  });

  it('names only real order statuses', () => {
    for (const status of DISCOVERY_COUNTED_ORDER_STATUSES) {
      expect(ORDER_STATUSES).toContain(status);
    }
  });

  it('has exactly one window, so a row cannot claim one nothing reads', () => {
    expect(DISCOVERY_WINDOWS).toEqual(['30d']);
  });
});
