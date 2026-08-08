/**
 * The checkout readiness gate, with the Stripe rail SWITCHED ON.
 *
 * A separate file from `checkout.service.test.ts` for one reason: `config` reads
 * `process.env` once at module load and freezes the result, so "the rail is on"
 * and "the rail is off" cannot both be true inside one module registry. The two
 * branches are therefore two files, and BOTH are pinned — the sibling suite
 * asserts the gate does not so much as query.
 *
 * ## What this file adds that the service-level tests cannot
 *
 * `account.service.realdb.test.ts` already proves the gate refuses an unready
 * seller against a real database. What is only observable HERE is the ORDER:
 * that checkout consults it before `reserve` runs. Refusing after a reservation
 * would still refuse — and would hold somebody else's stock for the length of a
 * rollback, on a question that needed no stock to answer. So the assertion that
 * matters most below is `expect(reserve).not.toHaveBeenCalled()`.
 *
 * ## The fixtures are repository ROWS, not documents
 *
 * The catalogue, the order and the address are all Postgres since the port, so
 * this mocks the same repositories `checkout.service.test.ts` does and builds
 * flat rows with `id` rather than `_id`. They are written out in full rather
 * than cast into shape: a cast would keep compiling when a column this path
 * actually reads is added, which is the one thing the fixture is for.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type { PricingResult } from '../pricing.service.js';
import type { DualMoney, Money } from '@mercaria/shared-types';
import type {
  ListingChildren,
  ListingImageRecord,
  ListingRecord,
} from '../../db/catalog/listingRepository.js';
import type { VariantRecord } from '../../db/catalog/variantRepository.js';

const getCart = vi.fn();
const clearCart = vi.fn();
const removeCartLines = vi.fn();
const reserve = vi.fn();
const release = vi.fn();
const findListingsByIds = vi.fn();
const findListingChildren = vi.fn();
const findVariantsByIds = vi.fn();
const findVariantOptionValues = vi.fn();
const findStoresByIds = vi.fn();
const findAddress = vi.fn();
const insertOrder = vi.fn();
const findOrdersByCheckoutGroup = vi.fn();
const nextOrderNumber = vi.fn();
const summarizeOrders = vi.fn();
const calculateTotals = vi.fn();
const findProviderAccountByOwner = vi.fn();

vi.mock('../cart.service.js', () => ({
  getCart: (...args: unknown[]) => getCart(...args),
  clearCart: (...args: unknown[]) => clearCart(...args),
  removeCartLines: (...args: unknown[]) => removeCartLines(...args),
}));
vi.mock('../inventory.service.js', () => ({
  reserve: (...args: unknown[]) => reserve(...args),
  release: (...args: unknown[]) => release(...args),
}));
vi.mock('../../db/catalog/listingRepository.js', () => ({
  findListingsByIds: (...args: unknown[]) => findListingsByIds(...args),
  findListingChildren: (...args: unknown[]) => findListingChildren(...args),
}));
vi.mock('../../db/catalog/variantRepository.js', () => ({
  findVariantsByIds: (...args: unknown[]) => findVariantsByIds(...args),
  findVariantOptionValues: (...args: unknown[]) => findVariantOptionValues(...args),
}));
vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoresByIds: (...args: unknown[]) => findStoresByIds(...args),
}));
vi.mock('../../db/buyers/addressRepository.js', () => ({
  findAddress: (...args: unknown[]) => findAddress(...args),
}));
vi.mock('../../db/orders/orderRepository.js', () => ({
  insertOrder: (...args: unknown[]) => insertOrder(...args),
  findOrdersByCheckoutGroup: (...args: unknown[]) => findOrdersByCheckoutGroup(...args),
  findOrderByIdempotencyKey: vi.fn(),
  nextOrderNumber: (...args: unknown[]) => nextOrderNumber(...args),
}));
vi.mock('../../db/merchandising/discountRepository.js', () => ({
  redeemDiscountCode: vi.fn().mockResolvedValue(true),
}));
vi.mock('../order-hydration.service.js', () => ({
  summarizeOrders: (...args: unknown[]) => summarizeOrders(...args),
}));
vi.mock('../catalog-hydration.service.js', () => ({
  resolveMedia: (value: string) => `resolved:${value}`,
}));
vi.mock('../pricing.service.js', () => ({
  calculateTotals: (...args: unknown[]) => calculateTotals(...args),
}));
vi.mock('../../queue/producers.js', () => ({ enqueueOrderEvent: () => Promise.resolve() }));
vi.mock('../../lib/redis.js', () => ({
  getRedisClient: () => null,
  withRedisTimeout: (p: Promise<unknown>) => p,
}));

// The gate's own data source. Mocked at the REPOSITORY rather than at
// `provider-account.service`, so the service under test — the parse, the
// readiness comparison and the refusal message — is the real one.
vi.mock('../../db/payments/providerAccountRepository.js', () => ({
  findProviderAccountByOwner: (...args: unknown[]) => findProviderAccountByOwner(...args),
}));

// `provider-account.service` evaluates `getDb()` as an ARGUMENT to the
// repository call, so it runs whether or not the function it is passed to is
// mocked — and with the rail ON the gate reaches it. `checkout.service` itself
// imports nothing from this module, and every repository that does is mocked
// above, so the only consumer in this graph is the gate. The sibling suite needs
// no such mock: with the rail off the gate returns before `getDb()`, which is
// the property it exists to pin.
vi.mock('../../db/postgres.js', () => ({ getDb: () => ({}) }));

const USER = 'buyer-gate';
const ADDRESS_ID = uuidv7();
const LISTING = uuidv7();
const VARIANT = uuidv7();
const STORE = 'store-gate-A';

/** Every row fixture carries the same timestamps; none of them is asserted on. */
const AT = new Date('2026-01-01T00:00:00.000Z');

let checkout: typeof import('../checkout.service.js').checkout;

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_gate_platform_not_a_real_one';
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_gate_connect_not_a_real_one';

  ({ checkout } = await import('../checkout.service.js'));
});

/** A `DualMoney` in FAIR where shop == presentment. */
function fairDual(amount: number): DualMoney {
  const money: Money = { amount, currency: 'FAIR' };
  return { shop: { ...money }, presentment: { ...money } };
}

function pricingResult(subtotal: number): PricingResult {
  return {
    subtotal: fairDual(subtotal),
    discountTotal: fairDual(0),
    tax: fairDual(0),
    shipping: fairDual(0),
    grandTotal: fairDual(subtotal),
    appliedDiscounts: [],
    taxLines: [],
    perLineDiscount: [fairDual(0)],
  };
}

/** A store-owned `listings` row. */
function listingRow(): ListingRecord {
  return {
    id: LISTING,
    ownerType: 'store',
    oxyUserId: null,
    storeId: STORE,
    title: 'Thing',
    description: 'A thing',
    condition: 'new',
    status: 'active',
    categoryId: null,
    categorySlugs: [],
    tags: [],
    priceRangeMinAmount: null,
    priceRangeMinCurrency: null,
    priceRangeMaxAmount: null,
    priceRangeMaxCurrency: null,
    hasInventory: true,
    variantCount: 1,
    longitude: null,
    latitude: null,
    geo: null,
    vendor: null,
    productType: null,
    handle: null,
    seoTitle: null,
    seoDescription: null,
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalId: null,
    sourceExternalUpdatedAt: null,
    overriddenFields: [],
    rating: 0,
    reviewCount: 0,
    favoriteCount: 0,
    publishedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    searchVector: '',
  };
}

/** A PRICED variant row — an unpriced one would trip step 4c, not the gate. */
function variantRow(): VariantRecord {
  return {
    id: VARIANT,
    listingId: LISTING,
    title: 'Default Title',
    sku: null,
    barcode: null,
    priceAmount: 1000,
    priceCurrency: 'FAIR',
    compareAtPriceAmount: null,
    compareAtPriceCurrency: null,
    inventoryTracked: true,
    inventoryAvailable: 10,
    inventoryCommitted: 0,
    sourceConnectionId: null,
    sourceProvider: null,
    sourceExternalVariantId: null,
    sourceExternalInventoryItemId: null,
    position: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

function imageRow(): ListingImageRecord {
  return {
    id: uuidv7(),
    listingId: LISTING,
    fileId: 'img-1',
    alt: null,
    position: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

function children(): ListingChildren {
  return {
    images: new Map([[LISTING, [imageRow()]]]),
    options: new Map(),
    collectionIds: new Map(),
  };
}

const addressRow = {
  id: ADDRESS_ID,
  oxyUserId: USER,
  label: null,
  recipientName: 'Buyer',
  line1: '1 Main St',
  line2: null,
  city: 'Town',
  region: null,
  postalCode: '00001',
  country: 'ES',
  phone: null,
  isDefault: true,
  createdAt: AT,
  updatedAt: AT,
};

/** A provider-account row in whatever onboarding state the case needs. */
function accountRow(onboardingState: string) {
  return {
    id: 'provider-account-1',
    provider: 'stripe',
    ownerType: 'store',
    ownerId: STORE,
    onboardingState,
  };
}

beforeEach(() => {
  getCart.mockReset().mockResolvedValue({
    id: 'cart-gate',
    currency: 'FAIR',
    items: [
      {
        listingId: LISTING,
        variantId: VARIANT,
        title: 'Thing',
        variantTitle: 'Default Title',
        unitPrice: { amount: 1000, currency: 'FAIR' as const },
        quantity: 1,
        available: 10,
        lineTotal: { amount: 1000, currency: 'FAIR' as const },
      },
    ],
    subtotal: { amount: 1000, currency: 'FAIR' },
  });
  clearCart.mockReset().mockResolvedValue(undefined);
  removeCartLines.mockReset().mockResolvedValue(undefined);
  reserve.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(undefined);
  findListingsByIds.mockReset().mockResolvedValue([listingRow()]);
  findVariantsByIds.mockReset().mockResolvedValue([variantRow()]);
  findListingChildren.mockReset().mockResolvedValue(children());
  findVariantOptionValues.mockReset().mockResolvedValue(new Map());
  findStoresByIds.mockReset().mockResolvedValue([]);
  findAddress.mockReset().mockResolvedValue(addressRow);
  insertOrder.mockReset().mockImplementation((input: Record<string, unknown>) =>
    Promise.resolve({ ...input, id: 'order-1' }),
  );
  findOrdersByCheckoutGroup.mockReset();
  nextOrderNumber.mockReset().mockResolvedValue('MRC-000001');
  summarizeOrders
    .mockReset()
    .mockResolvedValue([{ id: 'o1', orderNumber: 'MRC-000001', status: 'pending_payment' }]);
  calculateTotals.mockReset().mockResolvedValue(pricingResult(1000));
  findProviderAccountByOwner.mockReset();
});

describe('checkout with the Stripe rail on', () => {
  it('refuses a seller who has never onboarded, naming their group', async () => {
    findProviderAccountByOwner.mockResolvedValue(undefined);

    await expect(checkout(USER, { addressId: ADDRESS_ID })).rejects.toThrow(
      new RegExp(`store:${STORE}`),
    );
    // The order that matters: the eligibility question needed no stock, so no
    // stock was taken and no rollback had to unwind one.
    expect(reserve).not.toHaveBeenCalled();
    expect(insertOrder).not.toHaveBeenCalled();
  });

  it.each(['action_required', 'under_review', 'restricted', 'disabled'])(
    'refuses a seller whose account is %s',
    async (state) => {
      findProviderAccountByOwner.mockResolvedValue(accountRow(state));

      await expect(checkout(USER, { addressId: ADDRESS_ID })).rejects.toThrow(
        /cannot accept payment/i,
      );
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('places the order when the seller is ready', async () => {
    findProviderAccountByOwner.mockResolvedValue(accountRow('ready'));

    const result = await checkout(USER, { addressId: ADDRESS_ID });

    expect(result.orders).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    // Asked about the right seller, in the shape the gate derives from the key.
    expect(findProviderAccountByOwner).toHaveBeenCalledWith(expect.anything(), {
      provider: 'stripe',
      ownerType: 'store',
      ownerId: STORE,
    });
  });
});
