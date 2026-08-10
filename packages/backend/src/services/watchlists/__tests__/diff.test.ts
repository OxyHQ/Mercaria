/**
 * "Which items drove a change" (#81 basket rule 4), and — more of the file —
 * the three cases where the honest answer is that nobody can say.
 *
 * A diff across a currency change, a basis change or a #74 policy change would
 * attribute a movement to items that did not move. Refusing is cheap; being
 * wrong is not, because a buyer shown "this item went up €40" acts on it and the
 * seller of that item did nothing.
 */

import { describe, expect, it } from 'vitest';
import { diffWatchlistSnapshots, type DiffLine, type DiffSide } from '../diff.js';

function line(overrides: Partial<DiffLine> & { watchlistItemId: string }): DiffLine {
  return {
    canonicalProductId: `cp_${overrides.watchlistItemId}`,
    state: 'priced',
    quantity: 1,
    selectedOfferId: `of_${overrides.watchlistItemId}`,
    unitItemPriceAmount: 1000,
    lineItemPriceAmount: 1000,
    ...overrides,
  };
}

function side(id: string, lines: readonly DiffLine[], overrides: Partial<DiffSide> = {}): DiffSide {
  const total = lines.reduce((sum, row) => sum + (row.lineItemPriceAmount ?? 0), 0);
  return {
    snapshotId: id,
    displayCurrency: 'EUR',
    basis: 'item_price',
    totalAmount: total,
    rankingPolicyVersions: ['builtin@1'],
    lines,
    ...overrides,
  };
}

describe('the diff refuses whenever a movement would be misattributed', () => {
  it('refuses across a display-currency change', () => {
    expect(
      diffWatchlistSnapshots(
        side('s1', [line({ watchlistItemId: 'a' })], { displayCurrency: 'USD' }),
        side('s2', [line({ watchlistItemId: 'a' })]),
      ),
    ).toEqual({ comparable: false, reason: 'currency_changed' });
  });

  it('refuses across a basis change', () => {
    expect(
      diffWatchlistSnapshots(
        side('s1', [line({ watchlistItemId: 'a' })], { basis: 'delivered_total' }),
        side('s2', [line({ watchlistItemId: 'a' })]),
      ),
    ).toEqual({ comparable: false, reason: 'basis_changed' });
  });

  it('refuses when either side had NO basis, so there is no total to compare', () => {
    expect(
      diffWatchlistSnapshots(
        side('s1', [line({ watchlistItemId: 'a' })]),
        side('s2', [line({ watchlistItemId: 'a' })], { basis: null }),
      ),
    ).toEqual({ comparable: false, reason: 'basis_changed' });
  });

  it('refuses across a ranking-policy change, whatever the prices did', () => {
    expect(
      diffWatchlistSnapshots(
        side('s1', [line({ watchlistItemId: 'a' })]),
        side('s2', [line({ watchlistItemId: 'a' })], { rankingPolicyVersions: ['tuned@2'] }),
      ),
    ).toEqual({ comparable: false, reason: 'policy_version_changed' });
  });
});

describe('the diff explains a comparable change, largest movement first', () => {
  it('names a price move with its delta and both unit prices', () => {
    const diff = diffWatchlistSnapshots(
      side('s1', [line({ watchlistItemId: 'a' }), line({ watchlistItemId: 'b' })]),
      side('s2', [
        line({ watchlistItemId: 'a', unitItemPriceAmount: 1200, lineItemPriceAmount: 1200 }),
        line({ watchlistItemId: 'b' }),
      ]),
    );
    expect(diff.comparable).toBe(true);
    if (!diff.comparable) return;
    expect(diff.totalDeltaMinor).toBe(200);
    expect(diff.items).toEqual([
      {
        itemId: 'a',
        canonicalProductId: 'cp_a',
        kind: 'price_moved',
        deltaMinor: 200,
        previousUnitPriceMinor: 1000,
        currentUnitPriceMinor: 1200,
      },
    ]);
  });

  it('sorts by the SIZE of the movement, not by list order', () => {
    const diff = diffWatchlistSnapshots(
      side('s1', [line({ watchlistItemId: 'a' }), line({ watchlistItemId: 'b' })]),
      side('s2', [
        line({ watchlistItemId: 'a', unitItemPriceAmount: 1050, lineItemPriceAmount: 1050 }),
        line({ watchlistItemId: 'b', unitItemPriceAmount: 400, lineItemPriceAmount: 400 }),
      ]),
    );
    if (!diff.comparable) throw new Error('expected a comparable diff');
    expect(diff.items.map((item) => item.itemId)).toEqual(['b', 'a']);
  });

  it('attributes a quantity change to the BUYER, never to the market', () => {
    const diff = diffWatchlistSnapshots(
      side('s1', [line({ watchlistItemId: 'a' })]),
      side('s2', [line({ watchlistItemId: 'a', quantity: 3, lineItemPriceAmount: 3000 })]),
    );
    if (!diff.comparable) throw new Error('expected a comparable diff');
    expect(diff.items[0]).toMatchObject({ kind: 'quantity_changed', deltaMinor: 2000 });
  });

  it('reports an added and a removed item, each with its own contribution', () => {
    const diff = diffWatchlistSnapshots(
      side('s1', [line({ watchlistItemId: 'gone' })]),
      side('s2', [line({ watchlistItemId: 'new' })]),
    );
    if (!diff.comparable) throw new Error('expected a comparable diff');
    expect(diff.items).toContainEqual(
      expect.objectContaining({ itemId: 'new', kind: 'added', deltaMinor: 1000 }),
    );
    expect(diff.items).toContainEqual(
      expect.objectContaining({ itemId: 'gone', kind: 'removed', deltaMinor: -1000 }),
    );
  });

  it('reports crossing priced ↔ unresolved as its own kind', () => {
    const diff = diffWatchlistSnapshots(
      side('s1', [line({ watchlistItemId: 'a' })]),
      side('s2', [
        line({
          watchlistItemId: 'a',
          state: 'unresolved',
          selectedOfferId: null,
          unitItemPriceAmount: null,
          lineItemPriceAmount: null,
        }),
      ]),
    );
    if (!diff.comparable) throw new Error('expected a comparable diff');
    expect(diff.items[0]).toMatchObject({ kind: 'became_unresolved', previousUnitPriceMinor: 1000 });
  });

  it('says nothing about an item that did not move', () => {
    const diff = diffWatchlistSnapshots(
      side('s1', [line({ watchlistItemId: 'a' })]),
      side('s2', [line({ watchlistItemId: 'a' })]),
    );
    if (!diff.comparable) throw new Error('expected a comparable diff');
    expect(diff.items).toEqual([]);
    expect(diff.totalDeltaMinor).toBe(0);
  });

  it('ignores a line whose item was removed from the list entirely', () => {
    // A NULL `watchlist_item_id` is a line whose entry is gone: it is history,
    // and pairing it with anything on the other side would be guessing.
    const diff = diffWatchlistSnapshots(
      side('s1', [line({ watchlistItemId: 'a' })]),
      side('s2', [{ ...line({ watchlistItemId: 'a' }), watchlistItemId: null }]),
    );
    if (!diff.comparable) throw new Error('expected a comparable diff');
    expect(diff.items).toEqual([
      expect.objectContaining({ itemId: 'a', kind: 'removed' }),
    ]);
  });
});
