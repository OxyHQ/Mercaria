/**
 * Unit tests for `draft-order.service` — the POS cart line rules and the
 * `completeDraftOrder` sale path.
 *
 * Everything these paths touch is mocked: the pricing engine, inventory
 * reserve/release, the Order/DraftOrder/Store/Location models, the CATALOGUE
 * repositories (`db/catalog/listingRepository`, `db/catalog/variantRepository` —
 * the catalogue is Postgres now, so a mock of the old `Listing`/`ProductVariant`
 * models would stub something this service no longer imports), the order-number
 * counter, the order.service transition, the order-hydration mapper, the media
 * chokepoint, the discount-code normalizer and the customer lookup.
 *
 * That mocking has one blind spot, and it is not hypothetical: a mocked
 * `Order.create` runs no validator, so it accepted a payload missing the
 * `required` + UNIQUE `orderNumber` and every POS sale 500d on a real server while
 * this file stayed green. The assertions here now pin the number reaching the
 * payload, but the property that a REAL server accepts the document can only be
 * checked against one — `draft-order-complete.realdb.test.ts` does that, against
 * both databases at once.
 *
 * Tests assert the B5 POS contract: a line can only be rung up at a price, so a
 * variant whose `price_amount` is NULL is refused (CONFLICT) rather than sold for
 * nothing; complete reserves each line at the draft's `locationId`, re-prices via
 * `calculateTotals`, creates a `sourceChannel: 'pos'` order whose items carry
 * `locationId`, runs `transition('paid')` and marks the draft completed; a
 * double-complete is idempotent (returns the same order, no re-reserve/create); a
 * mid-reserve out-of-stock rolls back the prior reservation (at the location) and
 * creates no order.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PricingResult, PricingLine } from '../pricing.service.js';
import type { DualMoney } from '@mercaria/shared-types';

const reserve = vi.fn();
const release = vi.fn();
const calculateTotals = vi.fn();
const transition = vi.fn();
const hydrateOrders = vi.fn();
const getCustomer = vi.fn();
const resolveDefaultLocationId = vi.fn();
const findLocation = vi.fn(async (..._args: unknown[]) => ({
  id: 'loc-1',
  name: 'Register',
  addressCity: 'Valencia',
  addressPostalCode: '46001',
  addressCountry: 'ES',
}));
const findListingById = vi.fn();
const findListingsByIds = vi.fn();
const findListingChildren = vi.fn();
const findVariantById = vi.fn();
const findVariantOptionValues = vi.fn();
const orderCreate = vi.fn();
const orderFindById = vi.fn();
const orderFindOne = vi.fn();
const draftFindOne = vi.fn();
const storeFindById = vi.fn();
const locationFindOne = vi.fn();
const nextOrderNumber = vi.fn();

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

/**
 * The pickup snapshot reads the sale's location for its city/postcode/country.
 * That address was an embedded sub-document and is now flat columns on
 * `locations`, so the fixture returns the row shape rather than an `address`
 * object — a mock still handing back `{address: {...}}` would silently produce a
 * receipt with no pickup address at all.
 */
vi.mock('../../db/stores/locationRepository.js', () => ({
  findLocation: (...args: unknown[]) => findLocation(...args),
}));

vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (value: string) => `resolved:${value}`,
}));

vi.mock('../discount.service.js', () => ({
  normalizeDiscountCode: (code: string) => code.trim().toUpperCase(),
}));

vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
  findListingsByIds: (...args: unknown[]) => findListingsByIds(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));

vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantById: (...args: unknown[]) => findVariantById(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
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

vi.mock('../../models/store.js', () => ({
  Store: { findById: (...args: unknown[]) => storeFindById(...args) },
}));

vi.mock('../../models/location.js', () => ({
  Location: { findOne: (...args: unknown[]) => locationFindOne(...args) },
}));

vi.mock('../../models/counter.js', () => ({
  nextOrderNumber: (...args: unknown[]) => nextOrderNumber(...args),
}));

import { addLine, completeDraftOrder } from '../draft-order.service.js';
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
/** The number `nextOrderNumber` is stubbed to allocate for the sale. */
const ORDER_NUMBER = 'MRC-000777';

/** Build a `.lean()`-able query stub resolving to `value`. */
function leanOf<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

/** Build a `.select(...).lean()`-able query stub resolving to `value`. */
function selectLeanOf<T>(value: T) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

/** An empty `findListingChildren` result — images/options/memberships by listing id. */
function noChildren() {
  return { images: new Map(), options: new Map(), collectionIds: new Map() };
}

/**
 * A variant ROW as `variantRepository` returns it: FLAT, with the price split
 * across two NULLABLE columns rather than a `price` sub-document.
 */
function variantRow(
  overrides: { id?: string; listingId?: string; priceAmount?: number | null } = {},
) {
  const priceAmount = overrides.priceAmount === undefined ? 1000 : overrides.priceAmount;
  return {
    id: overrides.id ?? V1,
    listingId: overrides.listingId ?? L1,
    title: 'Default Title',
    sku: null,
    barcode: null,
    priceAmount,
    priceCurrency: priceAmount === null ? null : ('FAIR' as const),
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: true,
    inventoryAvailable: 5,
    inventoryCommitted: 0,
    position: 0,
  };
}

/** A listing ROW as `listingRepository` returns it — `id`, and no `images`. */
function listingRow(id = L1) {
  return { id, title: 'Thing', productType: null, storeId: STORE, ownerType: 'store' };
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
    optionValues: [] as { name: string; value: string }[],
    discountTotal: undefined as { amount: number; currency: string } | undefined,
  };
}

/** A mutable mock draft doc (mongoose-like) with a spied `save` and a `toObject`. */
function mockDraft(overrides: Partial<Record<string, unknown>> = {}) {
  const draft = {
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
  // `addLine` returns `draft.toObject()`; the mock hands back the same mutable
  // object so a test can read what the service actually pushed onto it.
  return Object.assign(draft, { toObject: () => draft });
}

/** A `DualMoney` in FAIR where shop == presentment (a POS sale). */
function fairDual(amount: number): DualMoney {
  return { shop: { amount, currency: 'FAIR' }, presentment: { amount, currency: 'FAIR' } };
}

/** A pricing result mirroring a 2-line draft (3000 subtotal, no discount/tax). */
function pricing(): PricingResult {
  return {
    subtotal: fairDual(3000),
    discountTotal: fairDual(0),
    tax: fairDual(0),
    shipping: fairDual(0),
    grandTotal: fairDual(3000),
    appliedDiscounts: [],
    taxLines: [],
    perLineDiscount: [fairDual(0), fairDual(0)],
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
  findListingById.mockReset().mockResolvedValue(null);
  findListingsByIds.mockReset().mockResolvedValue([]);
  findListingChildren.mockReset().mockResolvedValue(noChildren());
  findVariantById.mockReset().mockResolvedValue(null);
  findVariantOptionValues.mockReset().mockResolvedValue(new Map());
  orderCreate.mockReset();
  orderFindById.mockReset();
  orderFindOne.mockReset();
  draftFindOne.mockReset();
  storeFindById.mockReset();
  locationFindOne.mockReset().mockReturnValue(selectLeanOf(null));
  nextOrderNumber.mockReset().mockResolvedValue(ORDER_NUMBER);
});

describe('draft-order.service.addLine — a line needs a price', () => {
  it('REFUSES a variant whose price is NULL (CONFLICT)', async () => {
    /**
     * `product_variants.price_amount` is nullable — a connector can import a
     * product whose price the source platform withholds, and the catalogue stores
     * that faithfully rather than inventing a zero. A POS line has to charge
     * something, so the register refuses it instead of ringing up a free item or
     * persisting `unitPrice: {amount: undefined}` for the pricing engine to reduce
     * to NaN.
     */
    const draft = mockDraft();
    draft.lineItems = [];
    draftFindOne.mockResolvedValueOnce(draft);
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ priceAmount: null }));

    await expect(
      addLine(STORE, DRAFT_ID, { listingId: L1, variantId: V1, quantity: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    expect(draft.lineItems).toHaveLength(0);
    expect(draft.save).not.toHaveBeenCalled();
    expect(calculateTotals).not.toHaveBeenCalled();
  });

  it('adds a PRICED variant, carrying its price and option values onto the line', async () => {
    /**
     * The vacuity guard for the refusal above: a rule that rejected every variant
     * would satisfy it and break the register. It also pins the row shape the
     * service reads — `priceAmount`/`priceCurrency` columns, and option values
     * from the child table keyed by variant id.
     */
    const draft = mockDraft();
    draft.lineItems = [];
    draftFindOne.mockResolvedValueOnce(draft);
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ priceAmount: 2500 }));
    findVariantOptionValues.mockResolvedValueOnce(
      new Map([[V1, [{ variantId: V1, name: 'Size', value: 'M', position: 0 }]]]),
    );

    await addLine(STORE, DRAFT_ID, { listingId: L1, variantId: V1, quantity: 3 });

    expect(findVariantOptionValues).toHaveBeenCalledWith([V1]);
    expect(draft.lineItems).toHaveLength(1);
    expect(draft.lineItems[0].unitPrice).toEqual({ amount: 2500, currency: 'FAIR' });
    expect(draft.lineItems[0].optionValues).toEqual([{ name: 'Size', value: 'M' }]);
    expect(draft.save).toHaveBeenCalledTimes(1);

    // And the priced line is what the engine re-priced.
    const priced = calculateTotals.mock.calls[0][0] as { lines: PricingLine[] };
    expect(priced.lines[0].unitPrice).toEqual({ amount: 2500, currency: 'FAIR' });
  });

  it('refuses a variant that belongs to a different listing (CONFLICT)', async () => {
    const draft = mockDraft();
    draft.lineItems = [];
    draftFindOne.mockResolvedValueOnce(draft);
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ listingId: L2 }));

    await expect(
      addLine(STORE, DRAFT_ID, { listingId: L1, variantId: V1, quantity: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(draft.save).not.toHaveBeenCalled();
  });
});

describe('draft-order.service.completeDraftOrder — POS sale', () => {
  it('reserves each line at the draft location, prices, creates a pos order with item locationId, transitions paid, marks completed', async () => {
    const draft = mockDraft();
    draftFindOne.mockResolvedValueOnce(draft);
    // recompute reads the lines' listings (`findListingsByIds`) and their
    // collection memberships (`findListingChildren`); complete reads the same
    // children again for the item thumbnails. Neither is needed for this sale.
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
      orderNumber: string;
      sourceChannel: string;
      sellerType: string;
      storeId: string;
      items: { variantId: string; locationId?: string }[];
      idempotencyKey: string;
    };
    // The order number is `required` + UNIQUE on the schema, so a payload without
    // it is rejected by a real server (see `draft-order-complete.realdb.test.ts`);
    // exactly one is allocated per sale, from the shared customer-facing sequence.
    expect(doc.orderNumber).toBe(ORDER_NUMBER);
    expect(nextOrderNumber).toHaveBeenCalledTimes(1);
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

  it('takes each item thumbnail from the listing images CHILD TABLE, lowest position first', async () => {
    /**
     * `ListingRecord` carries no `images`, so the gallery is loaded once for the
     * whole sale by `findListingChildren` and indexed by listing id. A port that
     * kept reading `listing.images` would silently drop every receipt thumbnail —
     * `undefined`, no error.
     */
    const draft = mockDraft();
    draftFindOne.mockResolvedValueOnce(draft);
    findListingChildren.mockResolvedValue({
      images: new Map([
        [L1, [{ listingId: L1, fileId: 'file-l1', alt: null, position: 0 }]],
      ]),
      options: new Map(),
      collectionIds: new Map(),
    });
    orderCreate.mockResolvedValueOnce({
      _id: 'order-1',
      toObject: () => ({ _id: 'order-1', sourceChannel: 'pos' }),
    });

    await completeDraftOrder(STORE, DRAFT_ID, {}, ACTOR);

    const doc = orderCreate.mock.calls[0][0] as { items: { imageUrl?: string }[] };
    expect(doc.items[0].imageUrl).toBe('resolved:file-l1');
    // The second line's listing has no images at all — absent, not empty string.
    expect(doc.items[1].imageUrl).toBeUndefined();
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
    // The short-circuit returns before any allocation — a repeated complete must
    // not burn an order number.
    expect(nextOrderNumber).not.toHaveBeenCalled();
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
    // A sale that never reaches `Order.create` allocates no number either.
    expect(nextOrderNumber).not.toHaveBeenCalled();
    // Draft is not mutated to completed.
    expect(draft.status).toBe('open');
    expect(draft.convertedOrderId).toBeUndefined();
  });
});
