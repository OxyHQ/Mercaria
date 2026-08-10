/**
 * The four pure derivations a merchant page adds (#73).
 *
 * They are unit-tested against exact inputs rather than through the page,
 * because each answers a question with a wrong answer that is silent: a
 * standing that reads "unclaimed" for a claimed merchant would put a
 * `Claim this merchant` button on somebody's shop, a mix that filed a
 * market-less offer under a country would let a shopper filter for it and be
 * shown nothing, and a card that took its price from the most recently seen
 * offer rather than the cheapest would quote a price that is not the one the
 * page says it starts from.
 *
 * The realdb file drives the same functions through real rows; this one drives
 * the branches those fixtures do not reach.
 */

import { describe, expect, it } from 'vitest';
import type {
  MerchantNativeCheckoutEligibility,
  Offer,
  OfferConditionKey,
} from '@mercaria/shared-types';
import { summariseMerchantOfferMix } from '../offer-mix.js';
import { deriveMerchantPublicStanding } from '../standing.js';
import { toMerchantCatalogEntry } from '../catalog-entry.js';
import { toMerchantPageNativeStore } from '../native-store.js';
import { resolveChannelOutbound } from '../outbound.js';
import type { MerchantOfferCensusRow } from '../../../db/merchantPages/merchantCatalogRepository.js';

const MERCHANT = 'merchant-1';
const OTHER_SELLER = 'merchant-2';

function eligibility(eligible: boolean): MerchantNativeCheckoutEligibility {
  return {
    merchantId: MERCHANT,
    eligible,
    claimState: eligible ? 'claimed' : 'unclaimed',
    hasActiveNativeStoreLink: eligible,
  };
}

function censusRow(overrides: Partial<MerchantOfferCensusRow>): MerchantOfferCensusRow {
  return {
    kind: 'external',
    condition: 'new',
    country: null,
    sellerMerchantId: MERCHANT,
    operatorMerchantId: MERCHANT,
    activeCount: 1,
    currentCount: 1,
    ...overrides,
  };
}

/**
 * A projected offer, narrowed to what the card derivation reads.
 *
 * A partial rather than a whole `Offer`, and the cast is confined to this ONE
 * builder so no test body carries one: the derivation reads six fields and a
 * fifty-field fixture per case would hide which of them each case is about.
 */
function offer(input: {
  id: string;
  merchantId?: string;
  storefrontId?: string;
  price?: number;
  condition?: OfferConditionKey;
  level?: 'current' | 'warning' | 'expired';
}): Offer {
  return {
    id: input.id,
    kind: 'external',
    status: 'active',
    canonicalVariantId: 'variant-1',
    merchantId: input.merchantId ?? MERCHANT,
    ...(input.storefrontId === undefined ? {} : { storefrontId: input.storefrontId }),
    sellerRole: 'unknown',
    ...(input.price === undefined ? {} : { price: { amount: input.price, currency: 'EUR' } }),
    availability: 'in_stock',
    condition: { key: input.condition ?? 'new', mappingState: 'declared' },
    customerEligibility: 'unknown',
    delivery: { known: false },
    provenance: {},
    freshness: { level: input.level ?? 'current', observedAt: '2026-01-01T00:00:00.000Z' },
    qualitySignals: [],
    checkout: { eligible: false, reasons: [] },
  } as unknown as Offer;
}

describe('the public standing', () => {
  it('reads `selling_on_mercaria` only when claimed AND linked', () => {
    expect(
      deriveMerchantPublicStanding({
        claimState: 'claimed',
        claimInProgress: false,
        nativeCheckout: eligibility(true),
      }),
    ).toBe('selling_on_mercaria');
    expect(
      deriveMerchantPublicStanding({
        claimState: 'claimed',
        claimInProgress: false,
        nativeCheckout: eligibility(false),
      }),
    ).toBe('claimed');
  });

  it('lets a verified claim outrank a squatter’s live claim', () => {
    // #83 permits several claims in flight so a first mover cannot lock the real
    // operator out. Reading the branches the other way round would describe a
    // CLAIMED merchant as "claim in progress" and put a claim button beside a
    // shop that already has an operator.
    expect(
      deriveMerchantPublicStanding({
        claimState: 'claimed',
        claimInProgress: true,
        nativeCheckout: eligibility(false),
      }),
    ).toBe('claimed');
  });

  it('reports a claim in progress from either the stored state or the live signal', () => {
    expect(
      deriveMerchantPublicStanding({
        claimState: 'claim_pending',
        claimInProgress: false,
        nativeCheckout: eligibility(false),
      }),
    ).toBe('claim_in_progress');
    expect(
      deriveMerchantPublicStanding({
        claimState: 'unclaimed',
        claimInProgress: true,
        nativeCheckout: eligibility(false),
      }),
    ).toBe('claim_in_progress');
    expect(
      deriveMerchantPublicStanding({
        claimState: 'unclaimed',
        claimInProgress: false,
        nativeCheckout: eligibility(false),
      }),
    ).toBe('unclaimed');
  });
});

describe('the offer mix', () => {
  it('counts only CURRENT offers into the dimensions, and stale as its own number', () => {
    const mix = summariseMerchantOfferMix([
      censusRow({ activeCount: 3, currentCount: 2, country: 'ES' }),
      censusRow({ activeCount: 1, currentCount: 0, condition: 'used_good' }),
    ]);
    expect(mix.activeOfferCount).toBe(4);
    expect(mix.currentOfferCount).toBe(2);
    expect(mix.staleOfferCount).toBe(2);
    // The lapsed pair is in NEITHER dimension: a chip a shopper can tap and be
    // shown nothing is worse than no chip.
    expect(mix.byCondition).toEqual([{ key: 'new', count: 2 }]);
    expect(mix.byMarket).toEqual([{ key: 'ES', count: 2 }]);
  });

  it('files a market-less offer under `null`, never under a country', () => {
    const mix = summariseMerchantOfferMix([
      censusRow({ country: null, currentCount: 5, activeCount: 5 }),
      censusRow({ country: 'DE', currentCount: 1, activeCount: 1 }),
    ]);
    expect(mix.byMarket).toEqual([
      { key: null, count: 5 },
      { key: 'DE', count: 1 },
    ]);
  });

  it('derives the seller role through the ONE definition of the D8 comparison', () => {
    const mix = summariseMerchantOfferMix([
      censusRow({ operatorMerchantId: MERCHANT, currentCount: 2, activeCount: 2 }),
      censusRow({ operatorMerchantId: OTHER_SELLER, currentCount: 3, activeCount: 3 }),
      // No channel at all: there is no operator to compare against, and
      // `unknown` is the honest answer rather than `direct`.
      censusRow({ operatorMerchantId: null, currentCount: 1, activeCount: 1 }),
    ]);
    expect(mix.bySellerRole).toEqual([
      { key: 'marketplace', count: 3 },
      { key: 'direct', count: 2 },
      { key: 'unknown', count: 1 },
    ]);
  });

  it('narrows the transitional `used` condition rather than counting it apart', () => {
    // `offers.condition` still admits `'used'` until migration `0031`. Counting
    // it as its own bucket would put a key on a chip that no filter accepts.
    const mix = summariseMerchantOfferMix([
      censusRow({ condition: 'used', currentCount: 2, activeCount: 2 }),
      censusRow({ condition: 'used_good', currentCount: 1, activeCount: 1 }),
    ]);
    expect(mix.byCondition).toEqual([{ key: 'used_good', count: 3 }]);
  });

  it('emits no bucket for a dimension nothing falls into', () => {
    expect(summariseMerchantOfferMix([]).byKind).toEqual([]);
    expect(summariseMerchantOfferMix([]).currentOfferCount).toBe(0);
  });
});

describe('a catalogue card', () => {
  const product = {
    canonicalProductId: 'product-1',
    slug: 'product-1',
    name: 'A product',
  };

  it('prices from the CHEAPEST current offer and counts distinct channels', () => {
    const entry = toMerchantCatalogEntry({
      product,
      projected: [
        offer({ id: 'a', price: 9_900, storefrontId: 'channel-a' }),
        offer({ id: 'b', price: 11_900, storefrontId: 'channel-b' }),
        offer({ id: 'c', price: 12_900, storefrontId: 'channel-b' }),
      ],
      pageMerchantId: MERCHANT,
    });
    expect(entry.representativeOffer?.id).toBe('a');
    expect(entry.currentOfferCount).toBe(3);
    expect(entry.eligibleChannelCount).toBe(2);
    expect(entry.hasOtherSellers).toBe(false);
  });

  it('drops an offer the live freshness derivation refused, from every count', () => {
    const entry = toMerchantCatalogEntry({
      product,
      projected: [
        offer({ id: 'expired', price: 1_000, storefrontId: 'channel-a', level: 'expired' }),
        offer({ id: 'live', price: 9_900, storefrontId: 'channel-b' }),
      ],
      pageMerchantId: MERCHANT,
    });
    // The cheapest offer is the expired one, and it is not the representative:
    // a card quoting a price whose source has lapsed is the exact dishonest
    // state #68's derivation exists to prevent.
    expect(entry.representativeOffer?.id).toBe('live');
    expect(entry.currentOfferCount).toBe(1);
    expect(entry.eligibleChannelCount).toBe(1);
  });

  it('flags other sellers so a marketplace page cannot imply it sells everything', () => {
    const entry = toMerchantCatalogEntry({
      product,
      // CHEAPEST FIRST, which is the caller's contract and both fetchers'
      // order. The derivation deliberately does not re-sort: comparing minor
      // units across currencies answers with whichever currency has the smaller
      // unit, so a second ordering here would be a second place that mistake
      // could be made.
      projected: [
        offer({ id: 'theirs', price: 8_900, storefrontId: 'channel-a', merchantId: OTHER_SELLER }),
        offer({ id: 'own', price: 9_900, storefrontId: 'channel-a' }),
      ],
      pageMerchantId: MERCHANT,
    });
    expect(entry.hasOtherSellers).toBe(true);
    expect(entry.representativeOffer?.merchantId).toBe(OTHER_SELLER);
  });

  it('takes the first CURRENT offer as given — the order is the caller’s contract', () => {
    // Stated as its own case because it is a contract nothing enforces at the
    // type level: both fetchers order by the same sentinel-coalesced price in
    // SQL, and a future caller handing this an unordered list would get a
    // representative that is not the cheapest, silently.
    const entry = toMerchantCatalogEntry({
      product,
      projected: [
        offer({ id: 'first', price: 12_000, storefrontId: 'channel-a' }),
        offer({ id: 'cheaper', price: 1_000, storefrontId: 'channel-a' }),
      ],
      pageMerchantId: MERCHANT,
    });
    expect(entry.representativeOffer?.id).toBe('first');
  });

  it('has no rating property at all', () => {
    const entry = toMerchantCatalogEntry({ product, projected: [], pageMerchantId: MERCHANT });
    expect(Object.keys(entry)).not.toContain('rating');
    expect(Object.keys(entry)).not.toContain('reviewCount');
    // And an empty scope produces an honest card rather than a zero price.
    expect(entry.representativeOffer).toBeUndefined();
    expect(entry.currentOfferCount).toBe(0);
  });

  it('contributes NO segment for an offer whose condition did not map', () => {
    const unmapped = offer({ id: 'u', price: 100, storefrontId: 'c' });
    const withoutKey = { ...unmapped, condition: { mappingState: 'unmapped' } } as unknown as Offer;
    const entry = toMerchantCatalogEntry({
      product,
      projected: [withoutKey],
      pageMerchantId: MERCHANT,
    });
    // Filing it under a segment would be Mercaria guessing what the retailer
    // meant; the card still exists and still has a price.
    expect(entry.conditionGroups).toEqual([]);
    expect(entry.currentOfferCount).toBe(1);
  });
});

describe('the native store and the outbound seam', () => {
  it('presents a linked store as a LINK, with five fields and no more', () => {
    const reference = toMerchantPageNativeStore({
      storeId: 'store-1',
      handle: 'a-shop',
      name: 'A shop',
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(reference.presentation).toBe('link');
    expect(Object.keys(reference).sort()).toEqual(
      ['handle', 'linkedAt', 'name', 'presentation', 'storeId'].sort(),
    );
  });

  it('refuses an outbound action and carries no URL to mistake for one', () => {
    const outbound = resolveChannelOutbound('storefront-1');
    expect(outbound).toEqual({ outcome: 'unavailable', reason: 'outbound_redirect_not_built' });
    expect(Object.keys(outbound)).not.toContain('url');
  });
});
