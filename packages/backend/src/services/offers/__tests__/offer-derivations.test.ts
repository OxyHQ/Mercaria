/**
 * The four derivations that decide what a buyer is shown (#57).
 *
 * Every fixture here is chosen to exercise the shape that makes the strict and
 * the loose reading of a check DISAGREE (`~/Oxy/AGENTS.md` rule (E)) — because a
 * suite whose fixtures all sit on one side of a distinction is green against
 * both implementations and proves nothing:
 *
 * - `deriveOfferSellerRole` gets a fixture where the two merchant ids DIFFER and
 *   one where they match. Two matching ids alone cannot tell "compares them"
 *   from "returns direct whenever both are present".
 * - `deriveOfferDelivery` gets a ZERO cost as well as a missing one. `0` and
 *   `undefined` are the pair a `?? 0` coercion collapses, so a fixture set of
 *   only non-zero costs is green against exactly the bug acceptance 4 forbids.
 * - `deriveNativeCheckoutEligibility` gets an UNTRACKED variant with zero
 *   available. Tracked-with-stock and tracked-without both agree under a naive
 *   `available > 0`; only the untracked-with-zero row tells the two apart.
 * - the FRESHNESS derivation moved to `offer-freshness.test.ts` with #68, where
 *   it takes a per-source policy rather than a bare deadline. The
 *   boundary-fixture rule went with it: an instant exactly ON each threshold,
 *   because an off-by-one in `>=` versus `>` is invisible to a fixture in the
 *   middle of an interval.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveNativeCheckoutEligibility,
  deriveOfferDelivery,
  deriveOfferSellerRole,
} from '@mercaria/shared-types';

describe('deriveOfferSellerRole (ADR 0002 D8)', () => {
  it('calls it a marketplace offer when the channel operator is a DIFFERENT merchant', () => {
    // Seller Y on amazon.es. The seller of record is Seller Y and the channel is
    // Amazon's — which is the whole of "marketplace", and it is a comparison of
    // two foreign keys rather than a stored flag.
    expect(deriveOfferSellerRole('merchant-seller-y', 'merchant-amazon')).toBe('marketplace');
  });

  it('calls it direct when the channel operator IS the seller', () => {
    expect(deriveOfferSellerRole('merchant-amazon', 'merchant-amazon')).toBe('direct');
  });

  it('answers unknown rather than guessing when either side is absent', () => {
    // A native offer names no merchant and no storefront. Reading that as
    // `direct` would label every P2P listing a first-party sale.
    expect(deriveOfferSellerRole(null, 'merchant-amazon')).toBe('unknown');
    expect(deriveOfferSellerRole('merchant-seller-y', null)).toBe('unknown');
    expect(deriveOfferSellerRole(undefined, undefined)).toBe('unknown');
  });
});

describe('deriveOfferDelivery — unknown is not zero (issue acceptance 4)', () => {
  it('a ZERO cost is KNOWN and free', () => {
    const delivery = deriveOfferDelivery({
      costAmount: 0,
      costCurrency: 'EUR',
      pickup: 'unknown',
    });
    expect(delivery.known).toBe(true);
    if (!delivery.known) throw new Error('unreachable: the assertion above narrowed it');
    expect(delivery.cost).toEqual({ amount: 0, currency: 'EUR' });
  });

  it('an ABSENT cost is unknown, and the union has no `cost` to misread', () => {
    const delivery = deriveOfferDelivery({ costAmount: null, costCurrency: null, pickup: 'unknown' });
    expect(delivery.known).toBe(false);
    expect('cost' in delivery).toBe(false);
  });

  it('days and a free-over threshold without a cost do NOT make it known', () => {
    // "Arrives in 2–4 days" says nothing about what it costs, and a ranking that
    // read the presence of an estimate as free delivery would put an unpriced
    // offer above a genuinely free one.
    const delivery = deriveOfferDelivery({
      costAmount: null,
      costCurrency: null,
      freeOverAmount: 5_000,
      freeOverCurrency: 'EUR',
      minDays: 2,
      maxDays: 4,
      pickup: 'available',
    });
    expect(delivery.known).toBe(false);
    expect(delivery.pickup).toBe('available');
  });

  it('a HALF-filled money pair is unknown, not a currencyless amount', () => {
    expect(deriveOfferDelivery({ costAmount: 499, costCurrency: null, pickup: 'unknown' }).known).toBe(
      false,
    );
  });

  it('carries pickup through on both branches — unknown pickup is not "no pickup"', () => {
    expect(deriveOfferDelivery({ costAmount: null, costCurrency: null, pickup: 'unknown' }).pickup).toBe(
      'unknown',
    );
    expect(
      deriveOfferDelivery({ costAmount: 0, costCurrency: 'EUR', pickup: 'unavailable' }).pickup,
    ).toBe('unavailable');
  });
});

describe('deriveNativeCheckoutEligibility — the live gate (issue acceptance 6)', () => {
  const buyable = {
    kind: 'native',
    status: 'active',
    listingId: 'listing-1',
    productVariantId: 'variant-1',
    listingStatus: 'active',
    inventoryTracked: true,
    inventoryAvailable: 3,
    sellerPaymentReady: true,
  } as const;

  it('admits a live, stocked, payable native offer', () => {
    const verdict = deriveNativeCheckoutEligibility(buyable);
    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) throw new Error('unreachable: the assertion above narrowed it');
    expect(verdict.listingId).toBe('listing-1');
    expect(verdict.productVariantId).toBe('variant-1');
  });

  it('an UNTRACKED variant with zero available is still buyable', () => {
    // THE fixture that tells a correct implementation from a naive
    // `available > 0`: an untracked P2P variant has no count and sells fine
    // today, and the two readings agree on every other stock shape.
    const verdict = deriveNativeCheckoutEligibility({
      ...buyable,
      inventoryTracked: false,
      inventoryAvailable: 0,
    });
    expect(verdict.eligible).toBe(true);
  });

  it('a TRACKED variant with zero available is not', () => {
    const verdict = deriveNativeCheckoutEligibility({ ...buyable, inventoryAvailable: 0 });
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible === true) throw new Error('unreachable');
    expect(verdict.reasons).toContain('out_of_stock');
  });

  it('tells a restriction apart from an ordinary unpublished listing', () => {
    // Two different facts with two different reasons, deliberately: a seller
    // reading "not active" about a jury decision would republish and be refused.
    const restricted = deriveNativeCheckoutEligibility({ ...buyable, listingStatus: 'restricted' });
    expect(restricted.eligible).toBe(false);
    if (restricted.eligible === true) throw new Error('unreachable');
    expect(restricted.reasons).toContain('listing_restricted');
    expect(restricted.reasons).not.toContain('listing_not_active');

    const draft = deriveNativeCheckoutEligibility({ ...buyable, listingStatus: 'draft' });
    if (draft.eligible === true) throw new Error('unreachable');
    expect(draft.reasons).toContain('listing_not_active');
    expect(draft.reasons).not.toContain('listing_restricted');
  });

  it('fails CLOSED when the listing could not be resolved at all', () => {
    const verdict = deriveNativeCheckoutEligibility({ ...buyable, listingStatus: null });
    expect(verdict.eligible).toBe(false);
  });

  it('refuses an unpayable seller (ADR 0001 D9)', () => {
    const verdict = deriveNativeCheckoutEligibility({ ...buyable, sellerPaymentReady: false });
    if (verdict.eligible === true) throw new Error('unreachable');
    expect(verdict.reasons).toEqual(['seller_not_payment_ready']);
  });

  it('every external kind is refused as `not_native`, with no variant to check out', () => {
    for (const kind of ['external', 'affiliate', 'informational'] as const) {
      const verdict = deriveNativeCheckoutEligibility({
        kind,
        status: 'active',
        listingId: null,
        productVariantId: null,
        listingStatus: null,
        inventoryTracked: null,
        inventoryAvailable: null,
        sellerPaymentReady: true,
      });
      expect(verdict.eligible, `${kind} must never be checkout-eligible`).toBe(false);
      if (verdict.eligible === true) throw new Error('unreachable');
      expect(verdict.reasons).toContain('not_native');
      expect(verdict.reasons).toContain('variant_missing');
    }
  });

  it('reports EVERY reason at once, not the first', () => {
    // An operator explaining a dead offer should not need four round trips.
    const verdict = deriveNativeCheckoutEligibility({
      ...buyable,
      listingStatus: 'restricted',
      inventoryAvailable: 0,
      sellerPaymentReady: false,
    });
    if (verdict.eligible === true) throw new Error('unreachable');
    expect([...verdict.reasons].sort()).toEqual([
      'listing_restricted',
      'out_of_stock',
      'seller_not_payment_ready',
    ]);
  });

  it('a retired offer is refused even when everything around it is healthy', () => {
    const verdict = deriveNativeCheckoutEligibility({ ...buyable, status: 'retired' });
    if (verdict.eligible === true) throw new Error('unreachable');
    expect(verdict.reasons).toEqual(['offer_retired']);
  });
});
