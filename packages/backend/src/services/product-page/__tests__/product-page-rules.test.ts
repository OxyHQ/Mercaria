/**
 * The pure rules of the canonical product page (#71).
 *
 * Everything here is a decision the page makes about what a shopper is shown,
 * taken over hand-built values so the case a test is about is the ONE fact that
 * differs between two fixtures.
 *
 * The fixtures deliberately exercise the distinctions the checks exist to make:
 * an offer with NO condition group (not `new`, not `used` — absent), an
 * official-standing offer whose condition is refurbished, and an external offer
 * whose destination does not parse. A table of tidy `new`/`used` offers would
 * pass under a rule that read an unknown condition as new, which is the one
 * misreading this partition exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import {
  OFFER_COMPARISON_LABELS,
  OFFER_LABEL_KIND,
  OFFER_LABEL_REASON,
  PRODUCT_PAGE_OFFER_GROUP_KEYS,
  type ConditionGroup,
  type Offer,
  type OfferLabelAward,
} from '@mercaria/shared-types';
import {
  assignOfferGroups,
  collectHighlights,
  groupForOffer,
  type GroupableOffer,
} from '../groups.js';
import { destinationHostOf, resolveProductPageOutbound } from '../outbound.js';
import {
  classifyProductPageShadow,
  readProductPageShadows,
  recordProductPageShadow,
  resetProductPageShadows,
} from '../shadow.js';

function groupable(
  offerId: string,
  conditionGroup: ConditionGroup | undefined,
  labels: readonly OfferLabelAward[] = [],
): GroupableOffer {
  return {
    offerId,
    ...(conditionGroup === undefined ? {} : { conditionGroup }),
    labels,
  };
}

const OFFICIAL: OfferLabelAward = {
  label: 'official_direct_store',
  reason: OFFER_LABEL_REASON.official_direct_store,
};
const AUTHORIZED: OfferLabelAward = {
  label: 'authorized_reseller',
  reason: OFFER_LABEL_REASON.authorized_reseller,
};

/** A minimal external offer. Only the fields the outbound decision reads matter. */
function externalOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-external',
    kind: 'external',
    status: 'active',
    canonicalVariantId: 'variant-1',
    sellerRole: 'direct',
    availability: 'in_stock',
    condition: { key: 'new', group: 'new', mappingState: 'declared' },
    customerEligibility: 'unknown',
    delivery: { known: false, pickup: 'unknown' },
    provenance: {},
    freshness: {
      level: 'current',
      basis: 'source_policy',
      observedAt: '2026-08-10T00:00:00.000Z',
      firstSeenAt: '2026-08-10T00:00:00.000Z',
      lastSeenAt: '2026-08-10T00:00:00.000Z',
      ageSeconds: 10,
      checkedAgeSeconds: 10,
      expiry: { bounded: false },
    },
    qualitySignals: [],
    checkout: { eligible: false, reasons: ['not_native'] },
    destinationUrl: 'https://shop.example.test/item/1?utm=x',
    ...overrides,
  };
}

describe('the partition — one offer, one group (#71 offer groups)', () => {
  it('places every condition segment in its own group, and an official NEW offer apart', () => {
    expect(groupForOffer(groupable('a', 'new'))).toBe('new_retail');
    expect(groupForOffer(groupable('b', 'new', [OFFICIAL]))).toBe('official_direct');
    expect(groupForOffer(groupable('c', 'open_box'))).toBe('open_box');
    expect(groupForOffer(groupable('d', 'refurbished'))).toBe('refurbished');
    expect(groupForOffer(groupable('e', 'used'))).toBe('used');
    expect(groupForOffer(groupable('f', 'for_parts'))).toBe('for_parts');
  });

  it('keeps an UNKNOWN condition out of the new group', () => {
    // The fixture that makes the distinction: absent, not `new` and not `used`.
    // A partition reading absence as `new` would pass every other case here.
    expect(groupForOffer(groupable('g', undefined))).toBe('condition_unknown');
  });

  it('puts an official store\'s REFURBISHED offer under refurbished, badge intact', () => {
    // Apple's certified refurbished store is the real case. Condition is the
    // primary axis (#90 never blends segments); the badge travels on the row.
    expect(groupForOffer(groupable('h', 'refurbished', [OFFICIAL]))).toBe('refurbished');
  });

  it('does NOT treat an authorised reseller as an official direct channel', () => {
    // #55 keeps the two as separate kinds with separate badges; merging them
    // here would undo that in the one place a shopper reads it.
    expect(groupForOffer(groupable('i', 'new', [AUTHORIZED]))).toBe('new_retail');
  });

  it('assigns each offer to exactly one group, in the comparison order, omitting empties', () => {
    const offers = [
      groupable('a', 'new', [OFFICIAL]),
      groupable('b', 'new'),
      groupable('c', 'used'),
      groupable('d', 'new'),
      groupable('e', undefined),
    ];
    const groups = assignOfferGroups(offers);

    const placements = groups.flatMap((group) => group.offerIds);
    expect(placements.slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(placements).size).toBe(placements.length);

    expect(groups.map((group) => group.key)).toEqual([
      'official_direct',
      'new_retail',
      'used',
      'condition_unknown',
    ]);
    // The comparison's own order survives inside a group — this domain sorts
    // nothing, because a second ordering is a second ranking policy.
    expect(groups.find((group) => group.key === 'new_retail')?.offerIds).toEqual(['b', 'd']);
  });

  it('every group key is representable and the vocabulary is closed', () => {
    for (const key of PRODUCT_PAGE_OFFER_GROUP_KEYS) {
      expect(typeof key).toBe('string');
    }
    expect(new Set(PRODUCT_PAGE_OFFER_GROUP_KEYS).size).toBe(
      PRODUCT_PAGE_OFFER_GROUP_KEYS.length,
    );
  });
});

describe('highlights point at rows and never copy them', () => {
  it('takes every COMPARISON award and no standing one', () => {
    const best: OfferLabelAward = {
      label: 'best_overall',
      reason: OFFER_LABEL_REASON.best_overall,
      score: 0.8,
    };
    const cheapestNew: OfferLabelAward = {
      label: 'cheapest_new',
      reason: OFFER_LABEL_REASON.cheapest_new,
      amount: { amount: 1_000, currency: 'EUR' },
    };
    const native: OfferLabelAward = {
      label: 'native_mercaria_checkout',
      reason: OFFER_LABEL_REASON.native_mercaria_checkout,
    };

    const highlights = collectHighlights([
      groupable('a', 'new', [best, cheapestNew, OFFICIAL]),
      groupable('b', 'new', [native, AUTHORIZED]),
    ]);

    expect(highlights.map((highlight) => highlight.award.label)).toEqual([
      'best_overall',
      'cheapest_new',
    ]);
    expect(highlights.every((highlight) => highlight.offerId === 'a')).toBe(true);
  });

  it('classifies every label, so a new one cannot default into the highlights', () => {
    for (const label of OFFER_COMPARISON_LABELS) {
      expect(['comparison', 'standing']).toContain(OFFER_LABEL_KIND[label]);
    }
  });
});

describe('the outbound seam fails closed (#71 actions 2, #37)', () => {
  it('refuses every external handoff and discloses the HOST rather than a link', () => {
    const outbound = resolveProductPageOutbound(externalOffer());
    expect(outbound).toEqual({
      kind: 'unavailable',
      reason: 'redirect_unavailable',
      destinationHost: 'shop.example.test',
    });
    // The whole point: no branch of the refusal carries a URL, so nothing can
    // navigate by reading one field it did not check.
    expect(JSON.stringify(outbound)).not.toContain('https://');
  });

  it('answers `no_destination` for an informational observation', () => {
    const offer = externalOffer({ kind: 'informational' });
    delete (offer as { destinationUrl?: string }).destinationUrl;
    expect(resolveProductPageOutbound(offer)).toEqual({
      kind: 'unavailable',
      reason: 'no_destination',
    });
  });

  it('produces NO host from a destination that is not a URL', () => {
    expect(destinationHostOf(externalOffer({ destinationUrl: 'not a url' }))).toBeUndefined();
    expect(resolveProductPageOutbound(externalOffer({ destinationUrl: 'not a url' }))).toEqual({
      kind: 'unavailable',
      reason: 'no_destination',
    });
  });

  it('hands a native, checkout-eligible offer the ids the cart operates on', () => {
    const offer = externalOffer({
      kind: 'native',
      checkout: { eligible: true, listingId: 'listing-1', productVariantId: 'pv-1' },
    });
    expect(resolveProductPageOutbound(offer)).toEqual({
      kind: 'native_checkout',
      listingId: 'listing-1',
      productVariantId: 'pv-1',
    });
  });

  it('never gives a native offer an outbound branch, even holding a destination', () => {
    // #71 acceptance 3, second half: native offers do not use affiliate
    // redirects. The switch is on the derived verdict, so a native offer that
    // somehow carried a URL still cannot be routed through one.
    const offer = externalOffer({
      kind: 'native',
      checkout: { eligible: false, reasons: ['out_of_stock'] },
      destinationUrl: 'https://affiliate.example.test/x',
    });
    expect(resolveProductPageOutbound(offer)).toEqual({
      kind: 'unavailable',
      reason: 'native_not_purchasable',
    });
  });

  it('an external row carries no variant id an add-to-cart call could use', () => {
    // #71 acceptance 3, first half, as a property of the shape rather than a
    // check somebody remembers.
    const outbound = resolveProductPageOutbound(externalOffer());
    expect(Object.keys(outbound)).not.toContain('productVariantId');
    expect(Object.keys(outbound)).not.toContain('listingId');
  });
});

describe('the shadow comparison (ADR 0002 D24 phase 3)', () => {
  it('classifies the four cases, and names the regression direction', () => {
    expect(classifyProductPageShadow(3, 2)).toBe('both_returned');
    expect(classifyProductPageShadow(3, 0)).toBe('canonical_only');
    expect(classifyProductPageShadow(0, 2)).toBe('listing_only');
    expect(classifyProductPageShadow(0, 0)).toBe('both_empty');
  });

  it('accumulates counters a rollout can read', () => {
    resetProductPageShadows();
    recordProductPageShadow(3, 2);
    recordProductPageShadow(0, 1);
    const counters = readProductPageShadows();
    expect(counters).toEqual({
      pages: 2,
      bothReturned: 1,
      canonicalOnly: 0,
      listingOnly: 1,
      bothEmpty: 0,
      canonicalOffers: 3,
      listingResults: 3,
    });
    resetProductPageShadows();
  });
});
