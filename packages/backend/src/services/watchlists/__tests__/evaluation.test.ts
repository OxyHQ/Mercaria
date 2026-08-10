/**
 * Evaluating a list into a basket — #81 acceptances 1, 2 and 7, plus the
 * correction rules that are derivations rather than stored state.
 *
 * #74's comparison and #57's offer read are mocked, and the catalogue reads
 * with them: what is under test is what this domain DOES with an answer, and a
 * real comparison would make the two source currencies of acceptance 1 a
 * property of whichever offers happened to be seeded rather than of the case.
 * The realdb suite covers the half that needs a server (the CHECKs, the uniques
 * and the concurrency).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FxRateSnapshot,
  Offer,
  RankedOffer,
  WatchlistItem,
} from '@mercaria/shared-types';

const rankOfferComparison = vi.fn();
const listOffers = vi.fn();
const findCanonicalProductsByIds = vi.fn();
const findCanonicalVariantsByIds = vi.fn();

vi.mock('../../ranking/comparison.service.js', () => ({
  rankOfferComparison: (...args: unknown[]) => rankOfferComparison(...args),
}));
vi.mock('../../offers/offer.service.js', () => ({
  listOffers: (...args: unknown[]) => listOffers(...args),
}));
vi.mock('../../../db/canonical/canonicalProductRepository.js', () => ({
  findCanonicalProductsByIds: (...args: unknown[]) => findCanonicalProductsByIds(...args),
}));
vi.mock('../../../db/canonical/canonicalVariantRepository.js', () => ({
  findCanonicalVariantsByIds: (...args: unknown[]) => findCanonicalVariantsByIds(...args),
}));
vi.mock('../../../db/postgres.js', () => ({ getDb: () => ({}) }));

const { evaluateWatchlistBasket } = await import('../evaluation.service.js');

const NOW = new Date('2026-08-10T12:00:00.000Z');

function quote(from: FxRateSnapshot['from'], rate: number): FxRateSnapshot {
  return { from, to: 'EUR', rate, provider: 'static', asOf: '2026-08-10T00:00:00.000Z' };
}

/** A watchlist row, reduced to what the evaluation reads. */
function watchlistRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wl_1',
    oxyUserId: 'oxy_1',
    name: 'PC build',
    description: null,
    icon: null,
    visibility: 'private',
    displayCurrency: 'EUR',
    market: null,
    templateKey: null,
    version: 3,
    lastEvaluatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never;
}

/** An item row WITHOUT its note — exactly what `listWatchlistItemFacts` returns. */
function itemRow(id: string, productId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    watchlistId: 'wl_1',
    canonicalProductId: productId,
    preferredCanonicalVariantId: null,
    preferredConditionGroup: null,
    preferredMerchantId: null,
    quantity: 1,
    position: 0,
    targetAmount: null,
    targetCurrency: null,
    resolutionState: 'resolved',
    ambiguousSplitJobId: null,
    addedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never;
}

function projected(id: string, productId: string, quantity = 1): WatchlistItem {
  return {
    id,
    canonicalProductId: productId,
    quantity,
    position: 0,
    resolution: { state: 'resolved' },
    priceAlert: { supported: false, reason: 'price_alerts_not_implemented', ownedBy: '#79' },
    addedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function offer(id: string, merchantId?: string): Offer {
  return {
    id,
    kind: 'external',
    canonicalVariantId: `cv_${id}`,
    availability: 'in_stock',
    condition: { key: 'new', group: 'new', source: 'declared' },
    checkout: { eligible: false, reasons: [] },
    ...(merchantId ? { merchantId } : {}),
  } as unknown as Offer;
}

function ranked(id: string, itemMinor: number, from: FxRateSnapshot['from'], rate: number): RankedOffer {
  return {
    offerId: id,
    rank: 1,
    score: 1,
    signals: [],
    labels: [],
    cost: {
      itemPrice: { known: true, amount: { amount: itemMinor, currency: 'EUR' }, fx: quote(from, rate) },
      deliveryCost: { known: false, reason: 'not_published' },
      total: { known: false, missing: ['delivery_cost'] },
      taxInclusion: 'unknown',
    },
  };
}

function comparison(rows: RankedOffer[], offers: Offer[], version = 'builtin@1') {
  return {
    comparison: {
      policy: { version },
      offers: rows,
    },
    offers: new Map(offers.map((row) => [row.id, row])),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findCanonicalVariantsByIds.mockResolvedValue([]);
  listOffers.mockResolvedValue({ offers: [] });
});

describe('#81 acceptance 1: two items in different source currencies, one total', () => {
  it('sums in the display currency and records BOTH quotes', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
      { id: 'cp_2', status: 'active', mergedIntoId: null },
    ]);
    rankOfferComparison
      // A USD offer, already converted into EUR by #74 with its own quote.
      .mockResolvedValueOnce(comparison([ranked('of_1', 9000, 'USD', 0.9)], [offer('of_1')]))
      // …and a GBP one, converted with a different quote.
      .mockResolvedValueOnce(comparison([ranked('of_2', 11500, 'GBP', 1.15)], [offer('of_2')]));

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1'), itemRow('wi_2', 'cp_2')],
      projected: [projected('wi_1', 'cp_1'), projected('wi_2', 'cp_2')],
      now: NOW,
    });

    expect(basket.total).toEqual({
      known: true,
      completeness: 'complete',
      basis: 'item_price',
      amount: { amount: 20500, currency: 'EUR' },
      includedItems: 2,
      excludedItems: 0,
    });
    // Reproducible: every conversion that produced the total is named, so the
    // same figure can be re-derived after rates move (#81 item rule 8).
    expect(basket.rates.map((rate) => rate.from).sort()).toEqual(['GBP', 'USD']);
    expect(basket.displayCurrency).toBe('EUR');
    expect(basket.rankingPolicyVersions).toEqual(['builtin@1']);
  });

  it('multiplies by quantity, in the display currency', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
    ]);
    rankOfferComparison.mockResolvedValue(
      comparison([ranked('of_1', 1000, 'USD', 0.9)], [offer('of_1')]),
    );

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1', { quantity: 3 })],
      projected: [projected('wi_1', 'cp_1', 3)],
      now: NOW,
    });

    expect(basket.total).toMatchObject({ known: true, amount: { amount: 3000, currency: 'EUR' } });
    const line = basket.lines[0];
    expect(line?.evaluation.state).toBe('priced');
    if (line?.evaluation.state === 'priced') {
      expect(line.evaluation.selection.unitItemPrice.amount).toBe(1000);
      expect(line.evaluation.selection.lineItemPrice.amount).toBe(3000);
    }
  });
});

describe('#81 item rule 7: an item that could not be priced is reported, never dropped', () => {
  beforeEach(() => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
      { id: 'cp_2', status: 'active', mergedIntoId: null },
    ]);
  });

  it('keeps the total PARTIAL and lists the unresolved item separately', async () => {
    rankOfferComparison
      .mockResolvedValueOnce(comparison([ranked('of_1', 5000, 'EUR', 1)], [offer('of_1')]))
      .mockResolvedValueOnce(comparison([], []));

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1'), itemRow('wi_2', 'cp_2')],
      projected: [projected('wi_1', 'cp_1'), projected('wi_2', 'cp_2')],
      now: NOW,
    });

    expect(basket.total).toMatchObject({ completeness: 'partial', includedItems: 1, excludedItems: 1 });
    expect(basket.unresolved).toEqual([
      { itemId: 'wi_2', canonicalProductId: 'cp_2', reason: 'no_offers_recorded' },
    ]);
    // …and the line is STILL in the list, so a page renders a row saying why
    // rather than silently showing one fewer item than the buyer added.
    expect(basket.lines).toHaveLength(2);
  });

  it('tells `all_offers_retired` from `no_offers_recorded` with one existence probe', async () => {
    rankOfferComparison.mockResolvedValue(comparison([], []));
    listOffers.mockResolvedValue({ offers: [{ id: 'of_old' }] });

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1')],
      projected: [projected('wi_1', 'cp_1')],
      now: NOW,
    });

    expect(basket.unresolved[0]?.reason).toBe('all_offers_retired');
    expect(listOffers).toHaveBeenCalledWith(
      expect.objectContaining({ includeStale: true, limit: 1 }),
    );
  });

  it('reports the buyer own filter when offers exist and eligibility refused them all', async () => {
    // The comparison returned offers and ranked none: the remedy is theirs, so
    // it is reported as theirs rather than as a catalogue gap. No probe is made.
    rankOfferComparison.mockResolvedValue(comparison([], [offer('of_1')]));

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1')],
      projected: [projected('wi_1', 'cp_1')],
      now: NOW,
    });

    expect(basket.unresolved[0]?.reason).toBe('no_eligible_offer');
    expect(listOffers).not.toHaveBeenCalled();
  });

  it('reports `no_eligible_offer` when the preferred merchant sells none of them', async () => {
    rankOfferComparison.mockResolvedValue(
      comparison([ranked('of_1', 5000, 'EUR', 1)], [offer('of_1', 'me_other')]),
    );

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1', { preferredMerchantId: 'me_wanted' })],
      projected: [projected('wi_1', 'cp_1')],
      now: NOW,
    });

    expect(basket.unresolved[0]?.reason).toBe('no_eligible_offer');
  });

  it('reports `price_not_convertible` when a matching offer carries no usable price', async () => {
    const unpriced: RankedOffer = {
      ...ranked('of_1', 0, 'EUR', 1),
      cost: {
        itemPrice: { known: false, reason: 'not_convertible' },
        deliveryCost: { known: false, reason: 'not_published' },
        total: { known: false, missing: ['item_price', 'delivery_cost'] },
        taxInclusion: 'unknown',
      },
    };
    rankOfferComparison.mockResolvedValue(comparison([unpriced], [offer('of_1')]));

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1')],
      projected: [projected('wi_1', 'cp_1')],
      now: NOW,
    });

    expect(basket.unresolved[0]?.reason).toBe('price_not_convertible');
  });
});

describe('#81 correction rules 1–3: the derived states', () => {
  it('rule 2: an item awaiting a split answer is unresolved BEFORE any offer is read', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
    ]);

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [
        itemRow('wi_1', 'cp_1', {
          resolutionState: 'ambiguous_after_split',
          ambiguousSplitJobId: 'job_1',
        }),
      ],
      projected: [projected('wi_1', 'cp_1')],
      now: NOW,
    });

    expect(basket.unresolved[0]?.reason).toBe('ambiguous_after_split');
    expect(rankOfferComparison).not.toHaveBeenCalled();
  });

  it('rule 3: a retired preferred variant falls back to UNRESOLVED, never another variant', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
    ]);
    findCanonicalVariantsByIds.mockResolvedValue([
      { id: 'cv_gone', status: 'merged', mergedIntoId: 'cv_other' },
    ]);

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1', { preferredCanonicalVariantId: 'cv_gone' })],
      projected: [projected('wi_1', 'cp_1')],
      now: NOW,
    });

    expect(basket.unresolved[0]?.reason).toBe('preferred_variant_retired');
    // The whole point: nothing widened the scope back to the product and priced
    // a different configuration under the buyer's own pin.
    expect(rankOfferComparison).not.toHaveBeenCalled();
  });

  it('rule 1: a merge that left an entry on a tombstone beside its winner is a DUPLICATE', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_loser', status: 'merged', mergedIntoId: 'cp_winner' },
      { id: 'cp_winner', status: 'active', mergedIntoId: null },
    ]);
    rankOfferComparison.mockResolvedValue(
      comparison([ranked('of_1', 5000, 'EUR', 1)], [offer('of_1')]),
    );

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_loser'), itemRow('wi_2', 'cp_winner')],
      projected: [projected('wi_1', 'cp_loser'), projected('wi_2', 'cp_winner')],
      now: NOW,
    });

    expect(basket.unresolved).toEqual([
      {
        itemId: 'wi_1',
        canonicalProductId: 'cp_loser',
        reason: 'product_merged_into_existing_item',
      },
    ]);
    // …and the winner is counted ONCE, which is the property the reason exists
    // for: a basket must never charge for one product twice.
    expect(basket.total).toMatchObject({ includedItems: 1, amount: { amount: 5000 } });
  });

  it('a merged product with NO twin in the list is `product_unavailable`', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_loser', status: 'merged', mergedIntoId: 'cp_elsewhere' },
    ]);

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_loser')],
      projected: [projected('wi_1', 'cp_loser')],
      now: NOW,
    });

    expect(basket.unresolved[0]?.reason).toBe('product_unavailable');
  });
});

describe('#81 acceptance 7: an evaluation failure does not take the list with it', () => {
  it('isolates the failing item and prices the rest', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
      { id: 'cp_2', status: 'active', mergedIntoId: null },
    ]);
    rankOfferComparison
      .mockRejectedValueOnce(new Error('the comparison is having a bad day'))
      .mockResolvedValueOnce(comparison([ranked('of_2', 7000, 'EUR', 1)], [offer('of_2')]));

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1'), itemRow('wi_2', 'cp_2')],
      projected: [projected('wi_1', 'cp_1'), projected('wi_2', 'cp_2')],
      now: NOW,
    });

    expect(basket.unresolved).toEqual([
      { itemId: 'wi_1', canonicalProductId: 'cp_1', reason: 'evaluation_failed' },
    ]);
    expect(basket.total).toMatchObject({ completeness: 'partial', amount: { amount: 7000 } });
  });

  it('answers with an unknown total rather than throwing when EVERY item fails', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
    ]);
    rankOfferComparison.mockRejectedValue(new Error('everything is down'));

    const basket = await evaluateWatchlistBasket({
      watchlist: watchlistRow(),
      items: [itemRow('wi_1', 'cp_1')],
      projected: [projected('wi_1', 'cp_1')],
      now: NOW,
    });

    expect(basket.total).toEqual({ known: false, completeness: 'unknown' });
    expect(basket.unresolved[0]?.reason).toBe('evaluation_failed');
  });
});

describe('the comparison is asked for what the item actually wants', () => {
  it('scopes to the VARIANT when one is pinned, and to the product otherwise', async () => {
    findCanonicalProductsByIds.mockResolvedValue([
      { id: 'cp_1', status: 'active', mergedIntoId: null },
      { id: 'cp_2', status: 'active', mergedIntoId: null },
    ]);
    findCanonicalVariantsByIds.mockResolvedValue([
      { id: 'cv_pinned', status: 'active', mergedIntoId: null },
    ]);
    rankOfferComparison.mockResolvedValue(
      comparison([ranked('of_1', 100, 'EUR', 1)], [offer('of_1')]),
    );

    await evaluateWatchlistBasket({
      watchlist: watchlistRow({ market: 'ES' }),
      items: [
        itemRow('wi_1', 'cp_1', { preferredCanonicalVariantId: 'cv_pinned' }),
        itemRow('wi_2', 'cp_2', { preferredConditionGroup: 'refurbished' }),
      ],
      projected: [projected('wi_1', 'cp_1'), projected('wi_2', 'cp_2')],
      now: NOW,
    });

    expect(rankOfferComparison).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        canonicalVariantId: 'cv_pinned',
        comparisonCurrency: 'EUR',
        intent: 'cheapest',
        market: 'ES',
      }),
    );
    expect(rankOfferComparison).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        canonicalProductId: 'cp_2',
        conditionGroups: ['refurbished'],
      }),
    );
  });
});
