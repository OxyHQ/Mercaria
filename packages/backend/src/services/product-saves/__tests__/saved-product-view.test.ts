/**
 * The pure decisions of the saved-product projection (#80 API rules 3, 4 and 6,
 * acceptance 7).
 *
 * Every case here is one a buyer actually hits — a product whose offers all
 * expired, a price observed in a currency the seller has since changed, a save
 * made when nothing was for sale — and each one has to produce a STATED reason
 * rather than a missing field, because the alternative is a saved list that
 * renders a blank price and says nothing about why.
 */

import { describe, expect, it } from 'vitest';
import {
  discloseProductSaveCount,
  PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR,
  type SavedProductOffer,
} from '@mercaria/shared-types';
import { derivePriceChange } from '../saved-product-view.js';

const REFERENCE = { amount: 49_900, currency: 'EUR', observedAt: '2026-08-01T00:00:00.000Z' };

function offerAt(amount: number, currency = 'EUR'): SavedProductOffer {
  return {
    state: 'available',
    offerId: 'offer-1',
    canonicalVariantId: 'variant-1',
    price: { amount, currency },
    availability: 'in_stock',
    conditionKey: 'new',
    conditionGroup: 'new',
    nativeCheckoutEligible: true,
  };
}

describe('derivePriceChange', () => {
  it('reports a fall, a rise and no movement, each against the observed reference', () => {
    expect(derivePriceChange(REFERENCE, offerAt(44_900))).toEqual({
      known: true,
      direction: 'down',
      deltaMinor: -5_000,
      currency: 'EUR',
      since: REFERENCE.observedAt,
    });
    expect(derivePriceChange(REFERENCE, offerAt(54_900)).known).toBe(true);
    expect(derivePriceChange(REFERENCE, offerAt(54_900))).toMatchObject({ direction: 'up' });
    expect(derivePriceChange(REFERENCE, offerAt(49_900))).toMatchObject({
      direction: 'unchanged',
      deltaMinor: 0,
    });
  });

  it('refuses a cross-currency comparison instead of converting it', () => {
    // Running this through FX would report a RATE movement as a price movement,
    // and a buyer reading "12% cheaper" would be reading about the euro. #80
    // asks for a price change, and the honest answer when the currencies differ
    // is that there is not one.
    expect(derivePriceChange(REFERENCE, offerAt(49_900, 'USD'))).toEqual({
      known: false,
      reason: 'currency_changed',
    });
  });

  it('says WHY it cannot answer, and never falls back to "unchanged"', () => {
    // A buyer told a saved product has not moved when nothing was ever compared
    // has been given a wrong answer; "we have no earlier price" is a true one.
    expect(derivePriceChange(undefined, offerAt(49_900))).toEqual({
      known: false,
      reason: 'no_reference_price',
    });
    expect(
      derivePriceChange(REFERENCE, { state: 'none', reason: 'all_offers_retired' }),
    ).toEqual({ known: false, reason: 'no_current_offer' });
  });

  it('an available offer with no PRICE is still "no current offer" to compare against', () => {
    // #57 models an unpriced offer as one with no `price` at all rather than as
    // a zero, and a comparison against absence is not a comparison.
    const unpriced: SavedProductOffer = {
      state: 'available',
      offerId: 'offer-2',
      canonicalVariantId: 'variant-1',
      availability: 'in_stock',
      conditionKey: 'new',
      nativeCheckoutEligible: false,
    };
    expect(derivePriceChange(REFERENCE, unpriced)).toEqual({
      known: false,
      reason: 'no_current_offer',
    });
  });
});

describe('discloseProductSaveCount (#80 privacy rule 4)', () => {
  it('withholds below the floor as a STATE, never as a rounded number', () => {
    // "Under 10" beside a timestamp is a person on a small product, so the
    // withheld branch carries no count at all — a rounded one would be the same
    // disclosure with a friendlier face.
    const withheld = discloseProductSaveCount(PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR - 1);
    expect(withheld).toEqual({ disclosed: false, floor: PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR });
    expect('count' in withheld).toBe(false);
  });

  it('discloses at the floor and above', () => {
    expect(discloseProductSaveCount(PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR)).toEqual({
      disclosed: true,
      count: PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR,
    });
    expect(discloseProductSaveCount(1_204)).toEqual({ disclosed: true, count: 1_204 });
  });

  it('withholds zero rather than reporting it', () => {
    // Zero is below the floor and is treated as every other small number: a
    // product nobody has saved is not a fact this surface volunteers.
    expect(discloseProductSaveCount(0).disclosed).toBe(false);
  });
});
