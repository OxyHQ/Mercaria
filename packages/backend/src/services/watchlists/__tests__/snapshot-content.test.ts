/**
 * Deduplication and the material-change vocabulary (#81 snapshot rules 4 and 6).
 *
 * The case that shapes the whole file: two items moving by equal and opposite
 * amounts leave the TOTAL exactly where it was. A digest over the total alone
 * would call that "unchanged" and record nothing, and a `material_changes` set
 * derived only from totals would come back EMPTY — which
 * `watchlist_snapshots_material_changes_check` refuses, correctly, because a
 * stored snapshot differs from its predecessor by construction and has to be
 * able to say how.
 */

import { describe, expect, it } from 'vitest';
import type { WatchlistBasket, WatchlistItem } from '@mercaria/shared-types';
import {
  deriveMaterialChanges,
  watchlistContentDigest,
  type PriorSnapshotSummary,
} from '../snapshot-content.js';

const NOW = '2026-08-10T12:00:00.000Z';

function item(id: string, quantity = 1): WatchlistItem {
  return {
    id,
    canonicalProductId: `cp_${id}`,
    quantity,
    position: 0,
    resolution: { state: 'resolved' },
    priceAlert: { supported: false, reason: 'price_alerts_not_implemented', ownedBy: '#79' },
    addedAt: NOW,
    updatedAt: NOW,
  };
}

function basket(
  lines: readonly { id: string; offerId?: string; unit?: number; quantity?: number }[],
  overrides: Partial<WatchlistBasket> = {},
): WatchlistBasket {
  const priced = lines.filter((line) => line.unit !== undefined);
  const total = priced.reduce((sum, line) => sum + (line.unit ?? 0) * (line.quantity ?? 1), 0);
  return {
    watchlistId: 'wl_1',
    listVersion: 1,
    displayCurrency: 'EUR',
    rankingPolicyVersions: ['builtin@1'],
    total:
      priced.length === 0
        ? { known: false, completeness: 'unknown' }
        : {
            known: true,
            completeness: priced.length === lines.length ? 'complete' : 'partial',
            basis: 'item_price',
            amount: { amount: total, currency: 'EUR' },
            includedItems: priced.length,
            excludedItems: lines.length - priced.length,
          },
    optimization: { performed: false, basis: 'independent_per_item_minima', ownedBy: '#42' },
    lines: lines.map((line) => ({
      item: item(line.id, line.quantity),
      evaluation:
        line.unit === undefined
          ? { state: 'unresolved', reason: 'no_offers_recorded' }
          : {
              state: 'priced',
              selection: {
                offerId: line.offerId ?? `of_${line.id}`,
                canonicalVariantId: 'cv_1',
                availability: 'in_stock',
                nativeCheckoutEligible: false,
                rankingPolicyVersion: 'builtin@1',
                unitItemPrice: { amount: line.unit, currency: 'EUR' },
                unitItemPriceFx: {
                  from: 'EUR',
                  to: 'EUR',
                  rate: 1,
                  provider: 'identity',
                  asOf: NOW,
                },
                lineItemPrice: {
                  amount: line.unit * (line.quantity ?? 1),
                  currency: 'EUR',
                },
                delivery: { known: false, reason: 'not_published' },
                taxInclusion: 'unknown',
              },
            },
      priceChange: { known: false, reason: 'no_prior_snapshot' },
      target: { state: 'no_target' },
    })),
    unresolved: lines
      .filter((line) => line.unit === undefined)
      .map((line) => ({
        itemId: line.id,
        canonicalProductId: `cp_${line.id}`,
        reason: 'no_offers_recorded' as const,
      })),
    rates: [],
    evaluatedAt: NOW,
    ...overrides,
  };
}

/** The prior snapshot corresponding to a basket, so the two agree by construction. */
function prior(
  lines: readonly { id: string; offerId?: string; unit?: number; quantity?: number }[],
  overrides: Partial<PriorSnapshotSummary> = {},
): PriorSnapshotSummary {
  const priced = lines.filter((line) => line.unit !== undefined);
  const total = priced.reduce((sum, line) => sum + (line.unit ?? 0) * (line.quantity ?? 1), 0);
  return {
    displayCurrency: 'EUR',
    market: null,
    basis: priced.length === 0 ? null : 'item_price',
    completeness:
      priced.length === 0 ? 'unknown' : priced.length === lines.length ? 'complete' : 'partial',
    totalAmount: priced.length === 0 ? null : total,
    rankingPolicyVersions: ['builtin@1'],
    lines: lines.map((line) => ({
      watchlistItemId: line.id,
      state: line.unit === undefined ? 'unresolved' : 'priced',
      quantity: line.quantity ?? 1,
      selectedOfferId: line.unit === undefined ? null : (line.offerId ?? `of_${line.id}`),
      unitItemPriceAmount: line.unit ?? null,
    })),
    ...overrides,
  };
}

describe('watchlistContentDigest', () => {
  it('is stable for two identical evaluations', () => {
    const one = basket([{ id: 'a', unit: 1000 }, { id: 'b', unit: 2000 }]);
    const two = basket([{ id: 'a', unit: 1000 }, { id: 'b', unit: 2000 }]);
    expect(watchlistContentDigest(one)).toBe(watchlistContentDigest(two));
  });

  it('changes when a PER-ITEM price moves even though the total does not', () => {
    // The case the digest exists for. A digest over the total alone would
    // deduplicate this and the buyer's history would show one flat line through
    // the week both their prices moved.
    const before = basket([{ id: 'a', unit: 1000 }, { id: 'b', unit: 2000 }]);
    const after = basket([{ id: 'a', unit: 1100 }, { id: 'b', unit: 1900 }]);
    expect(before.total).toMatchObject({ amount: { amount: 3000 } });
    expect(after.total).toMatchObject({ amount: { amount: 3000 } });
    expect(watchlistContentDigest(before)).not.toBe(watchlistContentDigest(after));
  });

  it('changes when the SELECTED OFFER changes at the same price', () => {
    const before = basket([{ id: 'a', unit: 1000, offerId: 'of_x' }]);
    const after = basket([{ id: 'a', unit: 1000, offerId: 'of_y' }]);
    expect(watchlistContentDigest(before)).not.toBe(watchlistContentDigest(after));
  });

  it('changes when an item becomes unresolved', () => {
    const before = basket([{ id: 'a', unit: 1000 }]);
    const after = basket([{ id: 'a' }]);
    expect(watchlistContentDigest(before)).not.toBe(watchlistContentDigest(after));
  });
});

describe('deriveMaterialChanges', () => {
  it('answers `first_snapshot` when there is no predecessor', () => {
    expect(deriveMaterialChanges(basket([{ id: 'a', unit: 1000 }]), undefined)).toEqual([
      'first_snapshot',
    ]);
  });

  it('NEVER returns an empty set for a changed evaluation', () => {
    // The offsetting-move case again, from the other side: without
    // `item_price_moved` this would be empty and the CHECK would refuse the row.
    const changes = deriveMaterialChanges(
      basket([{ id: 'a', unit: 1100 }, { id: 'b', unit: 1900 }]),
      prior([{ id: 'a', unit: 1000 }, { id: 'b', unit: 2000 }]),
    );
    expect(changes).toContain('item_price_moved');
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it('names a total movement by DIRECTION', () => {
    expect(
      deriveMaterialChanges(basket([{ id: 'a', unit: 900 }]), prior([{ id: 'a', unit: 1000 }])),
    ).toContain('total_decreased');
    expect(
      deriveMaterialChanges(basket([{ id: 'a', unit: 1100 }]), prior([{ id: 'a', unit: 1000 }])),
    ).toContain('total_increased');
  });

  it('reports a quantity change as MEMBERSHIP, not as a price move', () => {
    const changes = deriveMaterialChanges(
      basket([{ id: 'a', unit: 1000, quantity: 2 }]),
      prior([{ id: 'a', unit: 1000, quantity: 1 }]),
    );
    expect(changes).toContain('membership_changed');
    expect(changes).not.toContain('item_price_moved');
  });

  it('reports an added and a removed item as membership', () => {
    expect(
      deriveMaterialChanges(
        basket([{ id: 'a', unit: 1000 }, { id: 'b', unit: 500 }]),
        prior([{ id: 'a', unit: 1000 }]),
      ),
    ).toContain('membership_changed');
    expect(
      deriveMaterialChanges(basket([{ id: 'a', unit: 1000 }]), prior([{ id: 'a', unit: 1000 }, { id: 'b', unit: 500 }])),
    ).toContain('membership_changed');
  });

  it('reports a policy change SEPARATELY from the total it may have moved', () => {
    // The one that must not be read as a price move: a different #74 policy can
    // select a different offer at unchanged prices.
    const changes = deriveMaterialChanges(
      basket([{ id: 'a', unit: 1000, offerId: 'of_y' }], {
        rankingPolicyVersions: ['tuned@2'],
      }),
      prior([{ id: 'a', unit: 1000, offerId: 'of_x' }]),
    );
    expect(changes).toContain('policy_version_changed');
    expect(changes).toContain('selection_changed');
  });

  it('reports an availability change when a line crosses priced ↔ unresolved', () => {
    expect(
      deriveMaterialChanges(basket([{ id: 'a' }]), prior([{ id: 'a', unit: 1000 }])),
    ).toContain('availability_changed');
  });

  it('reports a currency change and a basis change independently', () => {
    const changes = deriveMaterialChanges(
      basket([{ id: 'a', unit: 1000 }]),
      prior([{ id: 'a', unit: 1000 }], { displayCurrency: 'USD', basis: 'delivered_total' }),
    );
    expect(changes).toContain('currency_changed');
    expect(changes).toContain('basis_changed');
  });
});
