/**
 * Discovery feed shared-type contracts.
 *
 * These tests verify the shared-types discovery vocabularies live in the backend
 * suite rather than shared-types' own package because shared-types has no runner
 * by design (`ci.yml:306-307` states that reason). Shared-type tests execute in
 * the "Run API tests" step via the package imports that every backend module
 * already makes. This is the same reason `validate:catalog-identity-contracts`
 * gates the catalog surface from outside the package.
 */

import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_COUNTED_ORDER_STATUSES,
  DISCOVERY_SIGNALS,
  DISCOVERY_SIGNALS_FROM_LISTINGS,
  DISCOVERY_SIGNALS_FROM_COUNTS,
  DISCOVERY_WINDOWS,
  ORDER_STATUSES,
} from '@mercaria/shared-types';
import {
  CARD_GROUP_SIGNALS,
  SHELF_SIGNALS,
} from '../services/discovery/feed.service.js';

describe('discovery vocabularies', () => {
  it('splits the signals into exactly the two storage sources, with no overlap and no orphan', () => {
    // The split is the whole design: three signals read `listings`, two read
    // `discovery_signals`. A signal in neither has no query behind it; a signal
    // in both has two that can disagree.
    const union = [...DISCOVERY_SIGNALS_FROM_LISTINGS, ...DISCOVERY_SIGNALS_FROM_COUNTS];
    expect([...union].sort()).toEqual([...DISCOVERY_SIGNALS].sort());
    expect(new Set(union).size).toBe(union.length);
  });

  it('splits the signals into exactly the two RENDER groups, with no overlap and no orphan', () => {
    // The same shape one layer up, and the second partition of the same five.
    // `feed.service.ts` renders a category page from these two lists — the
    // card group's two compact cards and the three full-width shelves — so a
    // sixth signal added to NEITHER renders nowhere at all, and one added to
    // BOTH renders twice under two different headings. Both are silent: every
    // existing shelf keeps working, and there is no page anybody would think
    // to check. `DISCOVERY_SIGNALS` renders a database CHECK, so adding a
    // member is already a deliberate act; this is what makes placing it one.
    const union = [...CARD_GROUP_SIGNALS, ...SHELF_SIGNALS];
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
