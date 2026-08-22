/**
 * `Order.buyerOxyUserId` — the v1 buyer spelling, asserted at the entry point.
 *
 * Epic #367 line 74, and the third of the read contracts
 * `__tests__/v1-wire-contracts.ts` registers. It is in its own file rather than
 * beside the listing proofs because `vi.mock` is file-scoped and the two entry
 * points need different modules mocked; sharing a file would mean one set of
 * mocks serving two unrelated services.
 *
 * ## What was measured
 *
 * Deleting the serving line at `order-hydration.service.ts:488` left `tsc` at
 * exit 0 and the whole backend suite at 670 files / 10,500 tests passing. There
 * was no `order-hydration.service` test file at all: every test referencing
 * `hydrateOrders` MOCKS it, and `hydrateOrdersForMerchant` had zero test
 * references anywhere in the repository. The field is optional on `Order`, so
 * unlike `Listing.condition` not even its PRESENCE was gated.
 *
 * ## Three properties, and the third is a leak rather than a regression
 *
 * 1. An `oxy`-origin order carries it — what a v1 client reads.
 * 2. A `guest`-origin order does NOT, claimed or unclaimed. Filling it with the
 *    later claimant would tell an old client that an Oxy account placed a
 *    purchase it did not place (#106, ADR 0003 I7), which is a silent
 *    misattribution rather than a crash.
 * 3. A MERCHANT projection never carries it. `hydrateOrdersForMerchant`
 *    discards it by naming it on the left of a rest spread; a `{...dto}` spread
 *    would carry it at runtime while the TYPE said otherwise, and `Omit` cannot
 *    see that. Only a runtime read of an emitted object can.
 *
 * The fixture is a full `OrderRecord` — 68 public columns plus its four child
 * arrays. It is verbose on purpose: `hydrateOrders` is the ONE place an order
 * DTO is built, so the claim "an old client still works" is a claim about that
 * function, and a narrower seam would be a second assembly nobody serves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type { CommercialPresentation } from '@mercaria/shared-types';
import type { OrderRecord } from '../../db/orders/orderRepository.js';

const findSellerProfilesByUserIds = vi.fn();
const findStoresByIds = vi.fn();
const findGuestContactsByIds = vi.fn();
const getProfiles = vi.fn();
const resolveOrderCommercialPresentations = vi.fn();
const readRetailOrderExperience = vi.fn();

vi.mock('../../db/buyers/sellerProfileRepository.js', () => ({
  findSellerProfilesByUserIds: (...args: unknown[]) => findSellerProfilesByUserIds(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoresByIds: (...args: unknown[]) => findStoresByIds(...args),
}));

vi.mock('../../db/guests/guestCheckoutRepository.js', () => ({
  findGuestContactsByIds: (...args: unknown[]) => findGuestContactsByIds(...args),
}));

vi.mock('../oxy-user.service.js', () => ({
  getProfiles: (...args: unknown[]) => getProfiles(...args),
}));

vi.mock('../commercial-presentation/order-commercial.service.js', () => ({
  resolveOrderCommercialPresentations: (...args: unknown[]) =>
    resolveOrderCommercialPresentations(...args),
}));

vi.mock('../commercial-presentation/retail-order.service.js', () => ({
  readRetailOrderExperience: (...args: unknown[]) => readRetailOrderExperience(...args),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (id: string) => `media:${id}`,
  toStoreSummary: () => ({ id: 'store-1', handle: 'acme', name: 'Acme' }),
}));

/**
 * A sentinel handle, not a throwing stub.
 *
 * `loadBuyerContacts` calls `getDb()` unconditionally and hands the result to
 * `findGuestContactsByIds`, which is mocked — so nothing here reaches a server.
 * The sentinel is asserted to arrive at that repository, which is what keeps
 * this from being a mock that quietly accepts anything.
 */
const DB_SENTINEL = { sentinel: 'v1-order-buyer-serving' };

vi.mock('../../db/postgres.js', () => ({
  getDb: () => DB_SENTINEL,
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { warn: vi.fn(), error: vi.fn() } },
}));

import { hydrateOrders, hydrateOrdersForMerchant } from '../order-hydration.service.js';

const BUYER = 'oxy-buyer-1';
const CLAIMANT = 'oxy-claimant-1';
const AT = new Date('2026-05-06T07:08:09.000Z');

/** The commercial presentation `hydrateOrders` throws without. */
const PRESENTATION: CommercialPresentation = {
  mode: 'connected_marketplace',
  sellerKind: 'store',
  sellerLabel: 'Acme',
  sellerRole: 'direct',
  disclosures: ['sold_by_merchant'],
};

/**
 * One order row, with only the buyer identity columns varying.
 *
 * The three buyer columns are parameters and everything else is a constant,
 * because they are the whole subject: a case that spread an override object
 * could silently keep the default and still read as if it had set one.
 */
function orderRow(buyer: {
  buyerOrigin: OrderRecord['buyerOrigin'];
  buyerOxyUserId: string | null;
  buyerGuestCheckoutId: string | null;
  claimedByOxyUserId: string | null;
  claimedAt: Date | null;
}): OrderRecord {
  return {
    id: uuidv7(),
    orderNumber: 'MRC-000123',
    buyerOrigin: buyer.buyerOrigin,
    buyerOxyUserId: buyer.buyerOxyUserId,
    buyerGuestCheckoutId: buyer.buyerGuestCheckoutId,
    claimedByOxyUserId: buyer.claimedByOxyUserId,
    claimedAt: buyer.claimedAt,
    sellerType: 'store',
    commercialRole: 'connected_marketplace',
    sellerOxyUserId: null,
    storeId: 'store-1',
    customerId: null,
    sourceChannel: 'storefront',
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalId: null,
    sourceExternalUpdatedAt: null,
    shippingAddressLabel: null,
    shippingAddressRecipientName: 'A Buyer',
    shippingAddressLine1: '1 Street',
    shippingAddressLine2: null,
    shippingAddressCity: 'Town',
    shippingAddressRegion: null,
    shippingAddressPostalCode: '00000',
    shippingAddressCountry: 'ES',
    shippingAddressPhone: null,
    shippingMethod: 'standard',
    shippingLabel: null,
    shippingCostShopAmount: 0,
    shippingCostShopCurrency: 'FAIR',
    shippingCostPresentmentAmount: 0,
    shippingCostPresentmentCurrency: 'FAIR',
    shippingTrackingNumber: null,
    totalsSubtotalShopAmount: 1000,
    totalsSubtotalShopCurrency: 'FAIR',
    totalsSubtotalPresentmentAmount: 1000,
    totalsSubtotalPresentmentCurrency: 'FAIR',
    totalsDiscountTotalShopAmount: 0,
    totalsDiscountTotalShopCurrency: 'FAIR',
    totalsDiscountTotalPresentmentAmount: 0,
    totalsDiscountTotalPresentmentCurrency: 'FAIR',
    totalsShippingShopAmount: 0,
    totalsShippingShopCurrency: 'FAIR',
    totalsShippingPresentmentAmount: 0,
    totalsShippingPresentmentCurrency: 'FAIR',
    totalsTaxShopAmount: 0,
    totalsTaxShopCurrency: 'FAIR',
    totalsTaxPresentmentAmount: 0,
    totalsTaxPresentmentCurrency: 'FAIR',
    totalsGrandTotalShopAmount: 1000,
    totalsGrandTotalShopCurrency: 'FAIR',
    totalsGrandTotalPresentmentAmount: 1000,
    totalsGrandTotalPresentmentCurrency: 'FAIR',
    fxRateFrom: null,
    fxRateTo: null,
    fxRateRate: null,
    fxRateProvider: null,
    fxRateAsOf: null,
    status: 'paid',
    paymentStatus: 'paid',
    paymentProvider: 'mock',
    paymentPaidAt: AT,
    paymentId: null,
    checkoutGroupId: uuidv7(),
    idempotencyKey: null,
    moderationHold: false,
    createdAt: AT,
    updatedAt: AT,
    items: [],
    statusHistory: [],
    appliedDiscounts: [],
    taxLines: [],
  };
}

const oxyOrder = () =>
  orderRow({
    buyerOrigin: 'oxy',
    buyerOxyUserId: BUYER,
    buyerGuestCheckoutId: null,
    claimedByOxyUserId: null,
    claimedAt: null,
  });

const guestOrder = () =>
  orderRow({
    buyerOrigin: 'guest',
    buyerOxyUserId: null,
    buyerGuestCheckoutId: uuidv7(),
    claimedByOxyUserId: null,
    claimedAt: null,
  });

const claimedGuestOrder = () =>
  orderRow({
    buyerOrigin: 'guest',
    buyerOxyUserId: null,
    buyerGuestCheckoutId: uuidv7(),
    claimedByOxyUserId: CLAIMANT,
    claimedAt: AT,
  });

beforeEach(() => {
  findSellerProfilesByUserIds.mockReset().mockResolvedValue([]);
  findStoresByIds.mockReset().mockResolvedValue([]);
  findGuestContactsByIds.mockReset().mockResolvedValue(new Map());
  getProfiles.mockReset().mockResolvedValue(new Map());
  readRetailOrderExperience.mockReset().mockResolvedValue(undefined);
  resolveOrderCommercialPresentations
    .mockReset()
    .mockImplementation(async (rows: { orderId: string }[]) =>
      new Map(rows.map((row) => [row.orderId, PRESENTATION])),
    );
});

describe('v1 contract — Order.buyerOxyUserId (read)', () => {
  it('serves the v1 buyer id on an oxy-origin order', async () => {
    const [dto] = await hydrateOrders([oxyOrder()]);

    expect(dto.buyerOxyUserId).toBe(BUYER);
    // The successor must agree with it, or the two spellings of one fact have
    // diverged — which is the failure the v1 field exists to avoid, not a
    // separate concern.
    expect(dto.buyer).toEqual({ origin: 'oxy', oxyUserId: BUYER });
    // The contact read really happened through the real code path, with the
    // real handle: a `getDb` mock returning anything at all would otherwise let
    // this suite pass over a `loadBuyerContacts` that had stopped being called.
    expect(findGuestContactsByIds).toHaveBeenCalledWith(DB_SENTINEL, []);
  });

  it('omits it on a guest order rather than inventing one', async () => {
    const [dto] = await hydrateOrders([guestOrder()]);

    expect(dto.buyerOxyUserId).toBeUndefined();
    expect(dto.buyer.origin).toBe('guest');
  });

  it('omits it on a CLAIMED guest order, so an old client is never told the claimant bought it', async () => {
    // #106 / ADR 0003 I7. The claim is a second owner and the origin stays
    // `guest` forever; filling the v1 field with the claimant is the silent
    // misattribution this rule exists to prevent, and it would look exactly
    // like the field working.
    const [dto] = await hydrateOrders([claimedGuestOrder()]);

    expect(dto.buyerOxyUserId).toBeUndefined();
    expect(dto.buyerOxyUserId).not.toBe(CLAIMANT);
    expect(dto.buyer.origin).toBe('guest');
  });

  it('serves the three origins in ONE batch without crossing them over', async () => {
    // The vacuity control for the three cases above. Each asserts one order in
    // isolation, and a projection that read the FIRST row's buyer for every DTO
    // would satisfy all three while being wrong on every real multi-order page.
    const dtos = await hydrateOrders([guestOrder(), oxyOrder(), claimedGuestOrder()]);

    expect(dtos.map((dto) => dto.buyerOxyUserId)).toEqual([undefined, BUYER, undefined]);
  });
});

describe('v1 contract — Order.buyerOxyUserId is withheld from a merchant', () => {
  it('never appears on a merchant projection, checked on the emitted OBJECT', async () => {
    // `MerchantOrder` `Omit`s the field, so `tsc` covers the declared shape and
    // is blind to what the object actually carries. A `{...dto}` spread would
    // pass the compiler and leak at runtime, which is why this reads the keys.
    const [merchant] = await hydrateOrdersForMerchant([oxyOrder()]);

    expect(Object.keys(merchant)).not.toContain('buyerOxyUserId');
    expect(Object.keys(merchant)).not.toContain('buyerContact');
    // The floor: an empty object trivially contains neither key, and an
    // exception swallowed upstream would produce one.
    expect(Object.keys(merchant).length).toBeGreaterThanOrEqual(10);
    expect(merchant.orderNumber).toBe('MRC-000123');
  });
});
