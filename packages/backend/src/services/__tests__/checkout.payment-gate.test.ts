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

const ensurePayment = vi.fn();
const attachPaymentProviderObject = vi.fn();
const createPayment = vi.fn();
const resumePayment = vi.fn();
/** The Stripe adapter, reduced to the two methods this path calls. */
const stripeProvider = {
  createPayment: (...args: unknown[]) => createPayment(...args),
  resumePayment: (...args: unknown[]) => resumePayment(...args),
};

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
/**
 * No cart line is a Mercaria-retail line in these fixtures (#123).
 *
 * Mocked rather than left to reach Postgres, exactly as every other repository
 * in this file is: `partitionRetailLines` asks which variants carry a LIVE
 * binding, and it asks BEFORE grouping — so an unmocked lookup would be the one
 * database call in a suite that has no connection.
 *
 * An empty map means every line groups by its seller, which is what these
 * marketplace fixtures are about. The retail path's own behaviour is pinned by
 * `retail-checkout-isolation.test.ts` and `retail-checkout.realdb.test.ts`,
 * where a binding is a real row against a real server.
 */
vi.mock('../../db/retailCheckout/retailCheckoutRepository.js', () => ({
  findLiveRetailBindingsForVariants: vi.fn(async () => new Map()),
  insertRetailProcurementIntents: vi.fn(async () => []),
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

// The payment domain's one read of `guest_checkouts` (#107, ADR 0006 G7): the
// metadata's `guestCheckoutId` comes from the GROUP rather than from a
// parameter, so it survives a converging replay. Every checkout in this suite
// is an Oxy buyer's, which has no contact row — `undefined` is the honest
// answer, not a stub, and the guest branch is covered by the realdb suite where
// a real row exists to find.
vi.mock('../payments/guest-correlation.js', () => ({
  findGuestCheckoutIdForGroup: () => Promise.resolve(undefined),
}));

// The merchant ACTIVATION settings row (#85), pinned to "unwritten" — a store
// that has decided nothing, which is what every fixture in this suite is. With
// the fee mock below pinning "no applicable schedule", the whole activation gate
// is a no-op here and every expectation is unchanged. Stubbed at the REPOSITORY
// rather than at the gate deliberately: mocking the gate itself would make this
// suite unable to notice if the gate started refusing.
vi.mock('../../db/merchantActivation/activationSettingsRepository.js', () => ({
  readMerchantActivationSettings: () =>
    Promise.resolve({
      exists: false,
      nativeCheckoutIntent: 'enabled',
      guestCheckoutIntent: 'enabled',
      supportEmail: null,
      supportUrl: null,
      platformHeld: false,
    }),
}));

// The fee context (#88), pinned to "no active schedule" — the zero-fee
// configuration this suite's expectations were written against. Only the
// schedule LOAD is stubbed; selection and the snapshot plan run for real.
vi.mock('../fees/order-fees.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fees/order-fees.service.js')>();
  return {
    ...actual,
    loadFeeScheduleContext: () => Promise.resolve({ at: new Date(), schedules: [] }),
  };
});

// With the rail ON and a ready seller, checkout goes on to OPEN the payment.
// Both seams are mocked at the narrowest point that still leaves the code under
// test real: `checkout-payment.service` — which resolves the rail, refuses an
// ineligible currency and assembles the handoff — runs for real, and only the
// payment aggregate's persistence and the Stripe adapter behind it are faked.
vi.mock('../payments/payment.service.js', () => ({
  ensurePayment: (...args: unknown[]) => ensurePayment(...args),
}));
vi.mock('../payments/registry.js', () => ({
  resolvePaymentProvider: () => stripeProvider,
}));
vi.mock('../../db/payments/paymentRepository.js', () => ({
  attachPaymentProviderObject: (...args: unknown[]) => attachPaymentProviderObject(...args),
  findNativePaymentByCheckoutGroupId: () => Promise.resolve(undefined),
}));

// #90: the condition domain's reads. Mocked as empty rather than left to hit a
// mocked `getDb()` that has no `.select` — this suite mocks REPOSITORIES, and a
// repository is exactly what these are.
vi.mock('../../db/condition/conditionRepository.js', () => ({
  findConditionDetailsForListings: vi.fn(async () => []),
  findConditionPhotosForListings: vi.fn(async () => []),
}));


const USER = 'buyer-gate';
/** The resolved actor checkout takes since #105 (ADR 0003 D1). */
const ACTOR = { kind: 'oxy', oxyUserId: USER } as const;
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
  // Set EXPLICITLY, not inherited. vitest reuses a worker PROCESS across files
  // while giving each its own module registry, so a sibling file's `process.env`
  // write survives into this one's `config` — and a test that asserts the
  // handoff would then pass or fail on which file ran first in that worker.
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_gate_not_a_real_key';

  ({ checkout } = await import('../checkout.service.js'));
});

/**
 * A `DualMoney` in EUR where shop == presentment.
 *
 * EUR and not FAIR, throughout this file, because the rail is ON here: ADR 0001
 * D8 makes FAIR unroutable through Stripe, so a FAIR cart is refused for its
 * CURRENCY before the readiness gate this file is about is ever consulted.
 */
function eurDual(amount: number): DualMoney {
  const money: Money = { amount, currency: 'EUR' };
  return { shop: { ...money }, presentment: { ...money } };
}

function pricingResult(subtotal: number): PricingResult {
  return {
    subtotal: eurDual(subtotal),
    discountTotal: eurDual(0),
    tax: eurDual(0),
    shipping: eurDual(0),
    grandTotal: eurDual(subtotal),
    appliedDiscounts: [],
    taxLines: [],
    perLineDiscount: [eurDual(0)],
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
    conditionAssertion: 'seller_declared',
    conditionSourceLabel: null,
    conditionAcknowledgedAt: null,
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
    priceCurrency: 'EUR',
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
    currency: 'EUR',
    items: [
      {
        listingId: LISTING,
        variantId: VARIANT,
        title: 'Thing',
        variantTitle: 'Default Title',
        unitPrice: { amount: 1000, currency: 'EUR' as const },
        quantity: 1,
        available: 10,
        lineTotal: { amount: 1000, currency: 'EUR' as const },
      },
    ],
    subtotal: { amount: 1000, currency: 'EUR' },
  });
  ensurePayment.mockReset().mockResolvedValue({
    id: 'payment-gate',
    checkoutGroupId: 'group-gate',
    provider: 'stripe',
    status: 'created',
    presentmentAmount: 1000,
    presentmentCurrency: 'EUR',
    providerObjectId: null,
  });
  attachPaymentProviderObject.mockReset().mockResolvedValue(undefined);
  createPayment.mockReset().mockResolvedValue({
    providerObjectId: 'pi_gate',
    status: 'requires_action',
    clientAction: { kind: 'client_secret', value: 'pi_gate_secret_x' },
  });
  resumePayment.mockReset();
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
    Promise.resolve({
      ...input,
      id: 'order-1',
      // The stored COLUMNS, not the nested `totals` the insert was handed: the
      // payment is sized from what the order row says it charged, and a fixture
      // that omits them makes the charge NaN rather than failing on a shape.
      totalsGrandTotalPresentmentAmount: 1000,
      totalsGrandTotalPresentmentCurrency: 'EUR',
    }),
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

    await expect(checkout(ACTOR, { addressId: ADDRESS_ID })).rejects.toThrow(
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

      await expect(checkout(ACTOR, { addressId: ADDRESS_ID })).rejects.toThrow(
        /cannot accept payment/i,
      );
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('refuses a cart whose currency the rail cannot charge, before reserving', async () => {
    findProviderAccountByOwner.mockResolvedValue(accountRow('ready'));
    const cart = (await getCart()) as { currency: string };
    getCart.mockResolvedValue({ ...cart, currency: 'FAIR' });

    // The message names the eligible set: switching display currency is the
    // buyer's only remedy, and a client cannot offer it without knowing to what.
    await expect(checkout(ACTOR, { addressId: ADDRESS_ID })).rejects.toThrow(
      /not available in FAIR.*EUR or USD/is,
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
  });

  it('opens NO payment when the buyer picks the dev mock rail', async () => {
    findProviderAccountByOwner.mockResolvedValue(accountRow('ready'));

    const result = await checkout(ACTOR, { addressId: ADDRESS_ID, paymentMethod: 'mock' });

    // The order is placed exactly as before, and no charge object exists: the
    // dev seam funds the whole group afterwards through `POST /orders/:id/
    // mock-pay`, which is the ONLY thing that makes a `mock` payment.
    expect(result.orders).toHaveLength(1);
    expect(result.payment).toBeUndefined();
    expect(createPayment).not.toHaveBeenCalled();
    expect(ensurePayment).not.toHaveBeenCalled();
  });

  it('places the order when the seller is ready, and hands back the payment', async () => {
    findProviderAccountByOwner.mockResolvedValue(accountRow('ready'));

    const result = await checkout(ACTOR, { addressId: ADDRESS_ID });

    expect(result.orders).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    // The rail is engaged by DEFAULT when it is enabled — no `paymentMethod` was
    // sent above — and the buyer's client gets exactly the client material and
    // nothing else (issue #47, backend 7).
    expect(result.payment).toEqual({
      paymentId: 'payment-gate',
      provider: 'stripe',
      clientSecret: 'pi_gate_secret_x',
      // The SERVER's publishable key, which belongs to the account that created
      // the payment. The app's own build-time key is only the fallback.
      publishableKey: 'pk_test_gate_not_a_real_key',
      amount: { amount: 1000, currency: 'EUR' },
      // #107's server-authoritative payment surfaces (ADR 0006 G2/G14) — what a
      // client may RENDER, decided by the server and narrowed further by the
      // device. Buyer origin is not an input to it: this is an Oxy checkout and
      // the set is the same one a guest gets, which is B11 in one assertion.
      methods: ['card', 'apple_pay', 'google_pay', 'link'],
    });
    // The charge is the group's own grand total, and its idempotency key is
    // derived from the payment id — ADR 0001 D11, never from the request.
    expect(createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'payment-gate',
        amount: { amount: 1000, currency: 'EUR' },
        idempotencyKey: 'pi:payment-gate',
      }),
    );
    // Asked about the right seller, in the shape the gate derives from the key.
    expect(findProviderAccountByOwner).toHaveBeenCalledWith(expect.anything(), {
      provider: 'stripe',
      ownerType: 'store',
      ownerId: STORE,
    });
  });
});
