/**
 * Unit tests for `draft-order.service.completeDraftOrder` (the POS sale path).
 *
 * `mongodb-memory-server` is not available, so the pricing engine, inventory
 * reserve/release, the Listing/ProductVariant/Order/DraftOrder/Customer/Store/
 * Location models, the order.service transition, the order-hydration mapper, the
 * media chokepoint, the discount-code normalizer and the customer lookup are all
 * mocked. Tests assert the B5 POS contract: complete reserves each line at the
 * draft's `locationId`, re-prices via `calculateTotals`, creates a
 * `sourceChannel: 'pos'` order whose items carry `locationId`, runs
 * `transition('paid')` and marks the draft completed; a double-complete is
 * idempotent (returns the same order, no re-reserve/create); a mid-reserve
 * out-of-stock rolls back the prior reservation (at the location) and creates no
 * order.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PricingResult } from '../pricing.service.js';

const reserve = vi.fn();
const release = vi.fn();
const calculateTotals = vi.fn();
const transition = vi.fn();
const hydrateOrders = vi.fn();
const getCustomer = vi.fn();
const resolveDefaultLocationId = vi.fn();
const listingFind = vi.fn();
const listingFindById = vi.fn();
const variantFindById = vi.fn();
const orderCreate = vi.fn();
const orderFindById = vi.fn();
const orderFindOne = vi.fn();
const draftFindOne = vi.fn();
const customerFindOne = vi.fn();
const storeFindById = vi.fn();
const locationFindOne = vi.fn();

vi.mock('../inventory.service.js', () => ({
  reserve: (...args: unknown[]) => reserve(...args),
  release: (...args: unknown[]) => release(...args),
}));

vi.mock('../pricing.service.js', () => ({
  calculateTotals: (...args: unknown[]) => calculateTotals(...args),
}));

vi.mock('../order.service.js', () => ({
  transition: (...args: unknown[]) => transition(...args),
}));

vi.mock('../order-hydration.service.js', () => ({
  hydrateOrders: (...args: unknown[]) => hydrateOrders(...args),
}));

vi.mock('../customer.service.js', () => ({
  getCustomer: (...args: unknown[]) => getCustomer(...args),
}));

vi.mock('../catalog-write.service.js', () => ({
  resolveDefaultLocationId: (...args: unknown[]) => resolveDefaultLocationId(...args),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (value: string) => `resolved:${value}`,
}));

vi.mock('../discount.service.js', () => ({
  normalizeDiscountCode: (code: string) => code.trim().toUpperCase(),
}));

vi.mock('../../models/listing.js', () => ({
  Listing: {
    find: (...args: unknown[]) => listingFind(...args),
    findById: (...args: unknown[]) => listingFindById(...args),
  },
}));

vi.mock('../../models/product-variant.js', () => ({
  ProductVariant: { findById: (...args: unknown[]) => variantFindById(...args) },
}));

vi.mock('../../models/order.js', () => ({
  Order: {
    create: (...args: unknown[]) => orderCreate(...args),
    findById: (...args: unknown[]) => orderFindById(...args),
    findOne: (...args: unknown[]) => orderFindOne(...args),
  },
}));

vi.mock('../../models/draft-order.js', () => ({
  DraftOrder: {
    findOne: (...args: unknown[]) => draftFindOne(...args),
    find: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../../models/customer.js', () => ({
  Customer: { findOne: (...args: unknown[]) => customerFindOne(...args) },
}));

vi.mock('../../models/store.js', () => ({
  Store: { findById: (...args: unknown[]) => storeFindById(...args) },
}));

vi.mock('../../models/location.js', () => ({
  Location: { findOne: (...args: unknown[]) => locationFindOne(...args) },
}));

import { completeDraftOrder } from '../draft-order.service.js';
import { isMercariaError, outOfStock } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';

const STORE = 'store-A';
const DRAFT_ID = '000000000000000000000d01';
const LOCATION = 'loc-register-1';
const ACTOR = 'operator-1';
const L1 = '000000000000000000000101';
const L2 = '000000000000000000000102';
const V1 = '000000000000000000000201';
const V2 = '000000000000000000000202';

/** Build a `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

/** Build a `.select(...).lean()`-able query stub resolving to `value`. */
function selectLeanOf<T>(value: T) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

/** A draft line item. */
function line(listingId: string, variantId: string, quantity: number, amount = 1000) {
  return {
    listingId,
    variantId,
    title: 'Thing',
    variantTitle: 'Default Title',
    unitPrice: { amount, currency: 'FAIR' as const },
    quantity,
    optionValues: [],
    discountTotal: undefined as { amount: number; currency: string } | undefined,
  };
}

/** A mutable mock draft doc (mongoose-like) with a spied `save`. */
function mockDraft(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: DRAFT_ID,
    storeId: STORE,
    locationId: LOCATION,
    customerId: undefined as string | undefined,
    createdByOxyUserId: ACTOR,
    status: 'open' as 'open' | 'completed' | 'cancelled',
    lineItems: [line(L1, V1, 2), line(L2, V2, 1)],
    discountCodes: [] as string[],
    appliedDiscounts: [] as unknown[],
    taxLines: [] as unknown[],
    currency: 'FAIR',
    totals: {
      subtotal: { amount: 0, currency: 'FAIR' },
      discountTotal: { amount: 0, currency: 'FAIR' },
      tax: { amount: 0, currency: 'FAIR' },
      shipping: { amount: 0, currency: 'FAIR' },
      grandTotal: { amount: 0, currency: 'FAIR' },
    },
    convertedOrderId: undefined as string | undefined,
    idempotencyKey: undefined as string | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A pricing result mirroring a 2-line draft (3000 subtotal, no discount/tax). */
function pricing(): PricingResult {
  const currency = 'FAIR' as const;
  return {
    subtotal: { amount: 3000, currency },
    discountTotal: { amount: 0, currency },
    tax: { amount: 0, currency },
    shipping: { amount: 0, currency },
    grandTotal: { amount: 3000, currency },
    appliedDiscounts: [],
    taxLines: [],
    perLineDiscount: [
      { amount: 0, currency },
      { amount: 0, currency },
    ],
  };
}

beforeEach(() => {
  reserve.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(undefined);
  calculateTotals.mockReset().mockResolvedValue(pricing());
  transition.mockReset().mockResolvedValue(undefined);
  hydrateOrders.mockReset().mockResolvedValue([{ id: 'order-1', sourceChannel: 'pos' }]);
  getCustomer.mockReset();
  resolveDefaultLocationId.mockReset();
  listingFind.mockReset().mockReturnValue(leanOf([]));
  listingFindById.mockReset();
  variantFindById.mockReset();
  orderCreate.mockReset();
  orderFindById.mockReset();
  orderFindOne.mockReset();
  draftFindOne.mockReset();
  customerFindOne.mockReset();
  storeFindById.mockReset();
  locationFindOne.mockReset().mockReturnValue(selectLeanOf(null));
});

describe('draft-order.service.completeDraftOrder — POS sale', () => {
  it('reserves each line at the draft location, prices, creates a pos order with item locationId, transitions paid, marks completed', async () => {
    const draft = mockDraft();
    draftFindOne.mockResolvedValueOnce(draft);
    // recompute loads listings (none needed) → empty; complete loads listings for images.
    listingFind.mockReturnValue(leanOf([]));
    orderCreate.mockResolvedValueOnce({
      _id: 'order-1',
      toObject: () => ({ _id: 'order-1', sourceChannel: 'pos' }),
    });

    const result = await completeDraftOrder(STORE, DRAFT_ID, {}, ACTOR);

    // Reserved both lines at the register location.
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenNthCalledWith(1, V1, 2, LOCATION);
    expect(reserve).toHaveBeenNthCalledWith(2, V2, 1, LOCATION);

    // Re-priced via the engine.
    expect(calculateTotals).toHaveBeenCalledTimes(1);

    // Created a pos order whose items carry the register location.
    expect(orderCreate).toHaveBeenCalledTimes(1);
    const doc = orderCreate.mock.calls[0][0] as {
      sourceChannel: string;
      sellerType: string;
      storeId: string;
      items: { variantId: string; locationId?: string }[];
      idempotencyKey: string;
    };
    expect(doc.sourceChannel).toBe('pos');
    expect(doc.sellerType).toBe('store');
    expect(doc.storeId).toBe(STORE);
    expect(doc.items.every((i) => i.locationId === LOCATION)).toBe(true);
    expect(doc.idempotencyKey).toBe(`draft:${DRAFT_ID}`);

    // Drove the shared paid transition + marked the draft converted.
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0][1]).toBe('paid');
    expect(draft.status).toBe('completed');
    expect(draft.convertedOrderId).toBe('order-1');
    expect(draft.save).toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'order-1', sourceChannel: 'pos' });
  });

  it('is idempotent: a second complete (already converted) returns the same order without re-reserving/creating', async () => {
    const draft = mockDraft({ status: 'completed', convertedOrderId: 'order-1' });
    draftFindOne.mockResolvedValueOnce(draft);
    orderFindById.mockReturnValueOnce(leanOf({ _id: 'order-1', sourceChannel: 'pos' }));
    hydrateOrders.mockResolvedValueOnce([{ id: 'order-1', sourceChannel: 'pos' }]);

    const result = await completeDraftOrder(STORE, DRAFT_ID, {}, ACTOR);

    expect(reserve).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'order-1', sourceChannel: 'pos' });
  });

  it('rolls back the prior reservation (at the location) and creates no order when a later line is out of stock', async () => {
    const draft = mockDraft();
    draftFindOne.mockResolvedValueOnce(draft);

    // First reserve succeeds, second throws OUT_OF_STOCK.
    reserve
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(outOfStock('Insufficient stock to reserve'));

    await expect(completeDraftOrder(STORE, DRAFT_ID, {}, ACTOR)).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.OUT_OF_STOCK,
    );

    // Only the first (succeeded) line is released, at the register location.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(V1, 2, LOCATION);
    expect(orderCreate).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    // Draft is not mutated to completed.
    expect(draft.status).toBe('open');
    expect(draft.convertedOrderId).toBeUndefined();
  });
});
