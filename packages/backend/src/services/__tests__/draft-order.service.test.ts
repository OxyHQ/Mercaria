/**
 * Unit tests for `draft-order.service` — the POS cart line rules and the
 * `completeDraftOrder` sale path.
 *
 * Everything these paths touch is mocked: the pricing engine, inventory
 * reserve/release, the DRAFT-ORDER and ORDER repositories, the catalogue
 * repositories, the store repository, the order-number sequence, the
 * order.service transition, the order-hydration mapper, the media chokepoint,
 * the discount-code normalizer and the customer lookup.
 *
 * The draft is a RECORD now rather than a mutable mongoose document, so a
 * mutation is no longer visible by inspecting the fixture: every register edit
 * goes through `replaceDraftPricing`, which replaces the lines wholesale. That is
 * where the "what did the register put on the draft" assertions read from.
 *
 * That mocking has one blind spot, and it is not hypothetical: a mocked create
 * runs no validator, so it accepted a payload missing the `required` + UNIQUE
 * `orderNumber` and every POS sale 500d on a real server while this file stayed
 * green. The assertions here pin the number reaching the payload, but the
 * property that a REAL server accepts the row can only be checked against one —
 * `draft-order-complete.realdb.test.ts` does that.
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
const insertOrder = vi.fn();
const findOrderById = vi.fn();
const findDraftOrder = vi.fn();
const replaceDraftPricing = vi.fn();
const markDraftConverted = vi.fn();
const updateDraftOrderRow = vi.fn();
const findStoreRow = vi.fn();
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

vi.mock('../../db/orders/orderRepository.js', () => ({
  insertOrder: (...args: unknown[]) => insertOrder(...args),
  findOrderById: (...args: unknown[]) => findOrderById(...args),
  findOrderByIdempotencyKey: vi.fn(),
  nextOrderNumber: (...args: unknown[]) => nextOrderNumber(...args),
}));

vi.mock('../../db/pos/draftOrderRepository.js', () => ({
  findDraftOrder: (...args: unknown[]) => findDraftOrder(...args),
  findDraftOrdersPage: vi.fn(),
  insertDraftOrder: vi.fn(),
  replaceDraftPricing: (...args: unknown[]) => replaceDraftPricing(...args),
  updateDraftOrder: (...args: unknown[]) => updateDraftOrderRow(...args),
  markDraftConverted: (...args: unknown[]) => markDraftConverted(...args),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreRow: (...args: unknown[]) => findStoreRow(...args),
}));

import { addLine, completeDraftOrder } from '../draft-order.service.js';
import type {
  DraftLineItemRecord,
  DraftOrderRecord,
  DraftPricing,
  NewDraftLineItem,
} from '../../db/pos/draftOrderRepository.js';
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

/** A stored draft line ROW: flat `unit_price_*` columns and its option values. */
function line(
  listingId: string,
  variantId: string,
  quantity: number,
  amount = 1000,
): DraftLineItemRecord {
  return {
    id: `dl-${variantId}`,
    draftOrderId: DRAFT_ID,
    listingId,
    variantId,
    title: 'Thing',
    variantTitle: 'Default Title',
    unitPriceAmount: amount,
    unitPriceCurrency: 'FAIR',
    quantity,
    discountTotalAmount: null,
    discountTotalCurrency: null,
    position: 0,
    optionValues: [],
  } as unknown as DraftLineItemRecord;
}

/**
 * A draft RECORD with its children attached, as `findDraftOrder` returns it.
 *
 * Flat totals columns, and `lineItems` carrying their own rows — nothing here is
 * mutable state the service writes back into, which is the point: every register
 * edit re-prices and replaces, so the assertions read `replaceDraftPricing`.
 */
function mockDraft(overrides: Record<string, unknown> = {}): DraftOrderRecord {
  return {
    id: DRAFT_ID,
    storeId: STORE,
    locationId: LOCATION,
    customerId: null,
    createdByOxyUserId: ACTOR,
    status: 'open',
    lineItems: [line(L1, V1, 2), line(L2, V2, 1)],
    discountCodes: [],
    appliedDiscounts: [],
    taxLines: [],
    currency: 'FAIR',
    totalsSubtotalAmount: 0,
    totalsSubtotalCurrency: 'FAIR',
    totalsDiscountTotalAmount: 0,
    totalsDiscountTotalCurrency: 'FAIR',
    totalsTaxAmount: 0,
    totalsTaxCurrency: 'FAIR',
    totalsShippingAmount: 0,
    totalsShippingCurrency: 'FAIR',
    totalsGrandTotalAmount: 0,
    totalsGrandTotalCurrency: 'FAIR',
    convertedOrderId: null,
    shippingAddressRecipientName: null,
    note: null,
    createdAt: new Date('2026-06-22T00:00:00.000Z'),
    updatedAt: new Date('2026-06-22T00:00:00.000Z'),
    ...overrides,
  } as unknown as DraftOrderRecord;
}

/** The lines a register edit wrote, read off the `replaceDraftPricing` call. */
function writtenLines(): NewDraftLineItem[] {
  const [, pricingInput] = replaceDraftPricing.mock.calls[0] as [string, DraftPricing];
  return pricingInput.lineItems;
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
  insertOrder.mockReset();
  findOrderById.mockReset();
  findDraftOrder.mockReset();
  // The default write echoes the draft back with the lines it was handed, which
  // is what the real repository returns after the wholesale replace.
  replaceDraftPricing
    .mockReset()
    .mockImplementation((draftId: string, input: DraftPricing) =>
      Promise.resolve(
        mockDraft({
          id: draftId,
          lineItems: input.lineItems.map((item) =>
            line(item.listingId, item.variantId, item.quantity, item.unitPrice.amount),
          ) as unknown as DraftLineItemRecord[],
        }),
      ),
    );
  markDraftConverted.mockReset().mockResolvedValue(true);
  updateDraftOrderRow.mockReset();
  findStoreRow.mockReset().mockResolvedValue({ id: STORE, defaultCurrency: 'FAIR' });
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
    findDraftOrder.mockResolvedValueOnce(mockDraft({ lineItems: [] }));
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ priceAmount: null }));

    await expect(
      addLine(STORE, DRAFT_ID, { listingId: L1, variantId: V1, quantity: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );

    // Nothing was written and nothing was priced — the refusal happens before
    // either.
    expect(replaceDraftPricing).not.toHaveBeenCalled();
    expect(calculateTotals).not.toHaveBeenCalled();
  });

  it('adds a PRICED variant, carrying its price and option values onto the line', async () => {
    /**
     * The vacuity guard for the refusal above: a rule that rejected every variant
     * would satisfy it and break the register. It also pins the row shape the
     * service reads — `priceAmount`/`priceCurrency` columns, and option values
     * from the child table keyed by variant id.
     */
    findDraftOrder.mockResolvedValueOnce(mockDraft({ lineItems: [] }));
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ priceAmount: 2500 }));
    findVariantOptionValues.mockResolvedValueOnce(
      new Map([[V1, [{ variantId: V1, name: 'Size', value: 'M', position: 0 }]]]),
    );

    await addLine(STORE, DRAFT_ID, { listingId: L1, variantId: V1, quantity: 3 });

    expect(findVariantOptionValues).toHaveBeenCalledWith([V1]);
    const written = writtenLines();
    expect(written).toHaveLength(1);
    expect(written[0].unitPrice).toEqual({ amount: 2500, currency: 'FAIR' });
    expect(written[0].optionValues).toEqual([{ name: 'Size', value: 'M' }]);
    expect(replaceDraftPricing).toHaveBeenCalledTimes(1);

    // And the priced line is what the engine re-priced.
    const priced = calculateTotals.mock.calls[0][0] as { lines: PricingLine[] };
    expect(priced.lines[0].unitPrice).toEqual({ amount: 2500, currency: 'FAIR' });
  });

  it('refuses a variant that belongs to a different listing (CONFLICT)', async () => {
    findDraftOrder.mockResolvedValueOnce(mockDraft({ lineItems: [] }));
    findListingById.mockResolvedValueOnce(listingRow());
    findVariantById.mockResolvedValueOnce(variantRow({ listingId: L2 }));

    await expect(
      addLine(STORE, DRAFT_ID, { listingId: L1, variantId: V1, quantity: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.CONFLICT,
    );
    expect(replaceDraftPricing).not.toHaveBeenCalled();
  });
});

describe('draft-order.service.completeDraftOrder — POS sale', () => {
  it('reserves each line at the draft location, prices, creates a pos order with item locationId, transitions paid, marks completed', async () => {
    findDraftOrder.mockResolvedValueOnce(mockDraft());
    // The re-price reads the lines' listings (`findListingsByIds`) and their
    // collection memberships (`findListingChildren`); complete reads the same
    // children again for the item thumbnails. Neither is needed for this sale.
    insertOrder.mockResolvedValueOnce({ id: 'order-1', sourceChannel: 'pos' });
    transition.mockResolvedValueOnce({ id: 'order-1', sourceChannel: 'pos' });

    const result = await completeDraftOrder(STORE, DRAFT_ID, {}, ACTOR);

    // Reserved both lines at the register location.
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenNthCalledWith(1, V1, 2, LOCATION);
    expect(reserve).toHaveBeenNthCalledWith(2, V2, 1, LOCATION);

    // Re-priced via the engine.
    expect(calculateTotals).toHaveBeenCalledTimes(1);

    // Created a pos order whose items carry the register location.
    expect(insertOrder).toHaveBeenCalledTimes(1);
    const doc = insertOrder.mock.calls[0][0] as {
      orderNumber: string;
      sourceChannel: string;
      sellerType: string;
      storeId: string;
      items: { variantId: string; locationId?: string }[];
      idempotencyKey: string;
    };
    // `order_number` is NOT NULL + UNIQUE, so a row without it is rejected by a
    // real server (see `draft-order-complete.realdb.test.ts`); exactly one is
    // allocated per sale, from the shared customer-facing sequence.
    expect(doc.orderNumber).toBe(ORDER_NUMBER);
    expect(nextOrderNumber).toHaveBeenCalledTimes(1);
    expect(doc.sourceChannel).toBe('pos');
    expect(doc.sellerType).toBe('store');
    expect(doc.storeId).toBe(STORE);
    expect(doc.items.every((i) => i.locationId === LOCATION)).toBe(true);
    expect(doc.idempotencyKey).toBe(`draft:${DRAFT_ID}`);

    // Drove the shared paid transition + marked the draft converted. The mark is
    // guarded on the draft still being open, so a second complete that lost the
    // race cannot overwrite the first one's order id.
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0][1]).toBe('paid');
    expect(markDraftConverted).toHaveBeenCalledWith(STORE, DRAFT_ID, 'order-1');
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
    findDraftOrder.mockResolvedValueOnce(mockDraft());
    findListingChildren.mockResolvedValue({
      images: new Map([
        [L1, [{ listingId: L1, fileId: 'file-l1', alt: null, position: 0 }]],
      ]),
      options: new Map(),
      collectionIds: new Map(),
    });
    insertOrder.mockResolvedValueOnce({ id: 'order-1', sourceChannel: 'pos' });
    transition.mockResolvedValueOnce({ id: 'order-1', sourceChannel: 'pos' });

    await completeDraftOrder(STORE, DRAFT_ID, {}, ACTOR);

    const doc = insertOrder.mock.calls[0][0] as { items: { imageUrl?: string }[] };
    expect(doc.items[0].imageUrl).toBe('resolved:file-l1');
    // The second line's listing has no images at all — absent, not empty string.
    expect(doc.items[1].imageUrl).toBeUndefined();
  });

  it('is idempotent: a second complete (already converted) returns the same order without re-reserving/creating', async () => {
    findDraftOrder.mockResolvedValueOnce(
      mockDraft({ status: 'completed', convertedOrderId: 'order-1' }),
    );
    findOrderById.mockResolvedValueOnce({ id: 'order-1', sourceChannel: 'pos' });
    hydrateOrders.mockResolvedValueOnce([{ id: 'order-1', sourceChannel: 'pos' }]);

    const result = await completeDraftOrder(STORE, DRAFT_ID, {}, ACTOR);

    expect(reserve).not.toHaveBeenCalled();
    expect(insertOrder).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    // The short-circuit returns before any allocation — a repeated complete must
    // not burn an order number.
    expect(nextOrderNumber).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'order-1', sourceChannel: 'pos' });
  });

  it('rolls back the prior reservation (at the location) and creates no order when a later line is out of stock', async () => {
    findDraftOrder.mockResolvedValueOnce(mockDraft());

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
    expect(insertOrder).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    // A sale that never reaches the insert allocates no number either.
    expect(nextOrderNumber).not.toHaveBeenCalled();
    // The draft is never marked converted.
    expect(markDraftConverted).not.toHaveBeenCalled();
  });
});
