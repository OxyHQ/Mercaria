/**
 * Card checkout on the Peable rail (ADR 0009 D13), end to end, against a REAL
 * Postgres database.
 *
 * The cart is real, the reservation is real, the orders are real, the payment
 * aggregate and its ledger are real, the adapter (`peable-provider.ts`) and the
 * registry are real, every outcome arrives as a delivery signed with the
 * gateway's scheme through the REAL ingress (`ingestPeableDelivery`: verify,
 * store, route, apply), and the settlement writes real transfers and real
 * postings. Only the gateway on the far side of `createPeableClient` is faked
 * (`payments/__tests__/helpers/fake-peable-gateway.ts`), because no sandbox
 * can make a card payment succeed without a browser.
 *
 * Nothing here is about the acquirer. The properties are the MARKETPLACE's —
 * ADR 0001 D1 and D3–D12, which ADR 0009 inherits unchanged — and they held on
 * the deleted direct Stripe rail for the same reasons they hold here.
 *
 * ## Why none of this can be a mocked test
 *
 * Every property here lives in a gap no mock has:
 *
 *  - "one PaymentIntent per checkout group, however many times you submit" is
 *    held by a UNIQUE index on `payments.checkout_group_id` and a per-order
 *    `orders_idempotency_key_key`, and a mocked insert refuses neither;
 *  - "the ledger balances and the seller's payable closes" is arithmetic across
 *    two transactions written by two different modules — the second one only
 *    cancels the first if both agree on the currency and the amount;
 *  - "a withheld transfer does not touch its sibling" is a loop that has to
 *    survive a real failure in the middle of it;
 *  - "a late capture after the sweep raises an exception instead of overselling"
 *    crosses the reservation sweep, the order state machine, the payment CAS and
 *    the webhook ingress, and any one of them being mocked would prove nothing.
 *
 * ## What the Peable path books, stated rather than inherited
 *
 * The gateway's events carry no processor fee and no platform conversion
 * (`event-router.ts`'s "fee gap"), so a success books `charge_succeeded` with
 * NO `processor_expense` leg, and a charge is booked and settled in the USD it
 * was charged in. The cases below assert exactly that, so the day
 * the ledger decision is made those assertions are where it shows.
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL, so
 * nothing here truncates a table another file uses. Every id is minted per test
 * and every assertion is scoped to rows this file wrote — the stronger form
 * anyway, since a table-wide count starts passing for the wrong reason as soon
 * as somebody else adds a fixture.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import Redis from 'ioredis';
import type { Server } from 'node:http';
import { startSupervisionHttpFixture } from './helpers/supervision-http.js';
import { and, eq, sql } from 'drizzle-orm';

/**
 * The paid transition fires best-effort buyer/seller notifications. Left
 * unmocked they buffer against infrastructure this file has no reason to open,
 * and then swallow the failure — so the tests would spend their time on a side
 * effect none of them asserts.
 */
vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueLowInventoryAlert: vi.fn(async () => undefined),
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
}));

/**
 * The gateway, replaced at the ONE seam Mercaria reaches it through. The
 * adapter, the registry and everything behind them are the production code.
 */
const gateway = await vi.hoisted(async () =>
  (await import('../payments/__tests__/helpers/fake-peable-gateway.js')).createFakePeableGateway(),
);
vi.mock('../payments/peable/client.js', () => gateway.clientModule());

const WEBHOOK_SECRET = 'pwhsec_checkout_card_not_a_real_one';

/**
 * The high-value hold threshold this file configures, in USD minor units — far
 * above every other case's total, so only the case that means to cross it does.
 */
const HOLD_THRESHOLD_USD = 900_000;

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

type Database = import('../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let checkout: typeof import('../checkout.service.js').checkout;
let readCheckoutPaymentStatus: typeof import('../payments/checkout-payment.service.js').readCheckoutPaymentStatus;
let ingestPeableDelivery: typeof import('../payments/peable/ingress.js').ingestPeableDelivery;
let handleExpireReservations: typeof import('../../queue/handlers.js').handleExpireReservations;
let insertVariants: typeof import('../../db/catalog/variantRepository.js').insertVariants;
let findVariantsByIds: typeof import('../../db/catalog/variantRepository.js').findVariantsByIds;
let insertAddress: typeof import('../../db/buyers/addressRepository.js').insertAddress;
let ensureCart: typeof import('../../db/buyers/cartRepository.js').ensureCart;
let upsertCartItem: typeof import('../../db/buyers/cartRepository.js').upsertCartItem;
let ensureSellerProfile: typeof import('../../db/buyers/sellerProfileRepository.js').ensureSellerProfile;
let upsertUserPreference: typeof import('../../db/buyers/userPreferenceRepository.js').upsertUserPreference;
let insertProviderAccount: typeof import('../../db/payments/providerAccountRepository.js').insertProviderAccount;
let applyProviderAccountState: typeof import('../../db/payments/providerAccountRepository.js').applyProviderAccountState;
let findNativePaymentByCheckoutGroupId: typeof import('../../db/payments/paymentRepository.js').findNativePaymentByCheckoutGroupId;
let findOrdersInCheckoutGroup: typeof import('../../db/orders/orderRepository.js').findOrdersInCheckoutGroup;
let paymentSchema: typeof import('../../db/schema/payments.js');
let feeOutcomeSchema: typeof import('../../db/schema/feeOutcomes.js');
let ledgerSchema: typeof import('../../db/schema/ledger.js');
let ledgerOrder: Pick<
  typeof import('../../db/payments/ledgerRepository.js'),
  'LEDGER_ENTRY_ORDER' | 'LEDGER_TRANSACTION_ORDER'
>;
let orderSchema: typeof import('../../db/schema/orders.js');
let catalogSchema: typeof import('../../db/schema/catalog.js');
let useGoWayTransportForTests: typeof import('../goway/client.js').useGoWayTransportForTests;

let supervision: Awaited<ReturnType<typeof startSupervisionHttpFixture>>;
let shoppingServer: Server;
let shoppingUrl: string;

beforeAll(async () => {
  // The catalogue-safety reviewer holds `catalog.operate`, answered by the
  // fixture's roles read exactly as Oxy would.
  supervision = await startSupervisionHttpFixture({
    appPermissions: { 'catalog-platform-operator': ['catalog.operate'] },
  });
  process.env.OXY_API_URL = supervision.url;
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result. Everything
  // `resolvePeableEnabled` requires — the flag is a conjunction, and a missing
  // half would leave the rail off and every case here testing a deployment
  // with no rail.
  process.env.PEABLE_ENABLED = 'true';
  process.env.PEABLE_BASE_URL = 'https://api.peable.invalid';
  process.env.PEABLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.PEABLE_WEBHOOK_SECRET_PREVIOUS;
  // Marketplace card sales are USD (owner decision 2026-11-05: Oxy Platforms'
  // account settles USD and Peable transfers only in the payment's currency),
  // stated rather than inherited so a change to the default is a failing test
  // here rather than a surprise in production.
  process.env.PEABLE_PRESENTMENT_CURRENCIES = 'USD';
  process.env.HIGH_VALUE_HOLD_THRESHOLDS = `USD:${String(HOLD_THRESHOLD_USD)}`;
  delete process.env.HIGH_VALUE_HOLD_WINDOW_MS;
  delete process.env.CHECKOUT_PAYMENT_SURFACE_METHODS;
  // Deterministic FX for the cart's own native → presentment conversions.
  process.env.FX_PROVIDER = 'static';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  // Dynamic, like every realdb file here: a STATIC import pulls
  // `config/index.ts` at module load, before the PEABLE_* values above exist.
  ({ checkout } = await import('../checkout.service.js'));
  ({ readCheckoutPaymentStatus } = await import('../payments/checkout-payment.service.js'));
  ({ ingestPeableDelivery } = await import('../payments/peable/ingress.js'));
  ({ handleExpireReservations } = await import('../../queue/handlers.js'));
  ({ insertVariants, findVariantsByIds } = await import('../../db/catalog/variantRepository.js'));
  ({ insertAddress } = await import('../../db/buyers/addressRepository.js'));
  ({ ensureCart, upsertCartItem } = await import('../../db/buyers/cartRepository.js'));
  ({ ensureSellerProfile } = await import('../../db/buyers/sellerProfileRepository.js'));
  ({ upsertUserPreference } = await import('../../db/buyers/userPreferenceRepository.js'));
  ({ insertProviderAccount, applyProviderAccountState } = await import(
    '../../db/payments/providerAccountRepository.js'
  ));
  ({ findNativePaymentByCheckoutGroupId } = await import('../../db/payments/paymentRepository.js'));
  ({ findOrdersInCheckoutGroup } = await import('../../db/orders/orderRepository.js'));
  paymentSchema = await import('../../db/schema/payments.js');
  feeOutcomeSchema = await import('../../db/schema/feeOutcomes.js');
  ledgerSchema = await import('../../db/schema/ledger.js');
  ledgerOrder = await import('../../db/payments/ledgerRepository.js');
  orderSchema = await import('../../db/schema/orders.js');
  catalogSchema = await import('../../db/schema/catalog.js');
  ({ useGoWayTransportForTests } = await import('../goway/client.js'));
  const { oxyClient } = await import('../../middleware/auth.js');
  oxyClient.configureServiceAuth('fixture-key', 'fixture-secret');
  vi.spyOn(oxyClient, 'serviceToken').mockResolvedValue('fixture-service-token');
  const app = express();
  app.use(express.json());
  app.use('/supervised-shopping', (await import('../../routes/supervised-shopping.js')).default);
  app.use('/legacy-product-families', (await import('../../routes/product-families.js')).default);
  app.use('/legacy-listings', (await import('../../routes/listings.js')).default);
  app.use('/legacy-stores', (await import('../../routes/stores.js')).default);
  app.use('/legacy-product-page', (await import('../../routes/product-page.js')).default);
  app.use('/legacy-public-api', (await import('../../routes/public-api.js')).default);
  app.use('/legacy-merchants', (await import('../../routes/merchants.js')).default);
  app.use('/legacy-outbound', (await import('../../routes/outbound.js')).default);
  app.use('/legacy-price-history', (await import('../../routes/price-history.js')).default);
  app.use('/legacy-compatibility', (await import('../../routes/compatibility.js')).default);
  app.use('/legacy-price-signals', (await import('../../routes/price-signals.js')).default);
  app.use('/legacy-storefronts', (await import('../../routes/storefronts.js')).default);
  app.use('/legacy-facets', (await import('../../routes/facets.js')).default);
  app.use(
    '/legacy-catalog-attributes',
    (await import('../../routes/catalog-attributes.js')).default,
  );
  app.use('/legacy-offers', (await import('../../routes/offers.js')).default);
  app.use('/legacy-retail-offers', (await import('../../routes/retail-offers.js')).default);
  app.use('/legacy-seo', (await import('../../routes/seo.js')).default);
  app.use('/legacy-search', (await import('../../routes/search.js')).default);
  app.use(
    '/legacy-canonical-products',
    (await import('../../routes/canonical-products.js')).default,
  );
  app.use(
    '/legacy-brand-relationships',
    (await import('../../routes/brand-relationships.js')).default,
  );
  app.use(
    '/internal/catalog-safety',
    (await import('../../routes/internal-catalog-safety.js')).default,
  );
  shoppingServer = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const address = shoppingServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing app port');
  shoppingUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await closePostgres();
  await new Promise<void>((resolve) => shoppingServer.close(() => resolve()));
  await supervision.close();
});

beforeEach(() => {
  gateway.reset();
});

/**
 * A seller's account on the Peable rail, seeded through the repository.
 *
 * There is no Peable onboarding code path yet (ADR 0009 D13 "As built"), so
 * nothing in production writes this row; the repository is still the only
 * writer, and `onboarding_state` is the stored verdict every gate reads.
 */
async function seedPeableAccount(input: {
  ownerType: 'user' | 'store';
  ownerId: string;
  accountId: string;
}): Promise<void> {
  const account = await insertProviderAccount(db, {
    provider: 'peable',
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    providerAccountId: input.accountId,
    country: 'ES',
  });
  await applyProviderAccountState(db, {
    id: account.id,
    state: {
      onboardingState: 'ready',
      chargesEnabled: false,
      payoutsEnabled: true,
      transfersCapability: 'active',
      requirementsCurrentlyDue: 0,
      requirementsEventuallyDue: 0,
      requirementsPastDue: 0,
      requirementsPendingVerification: 0,
      disabledReasonCodes: [],
      syncedAt: new Date(),
    },
  });
}

/** A seller and their listing — payment-ready on the rail unless told otherwise. */
async function seedSeller(input: {
  label: string;
  priceMinor: number;
  currency: 'EUR' | 'USD';
  available?: number;
  /** `false` seeds a seller with NO account on the rail at all. */
  paymentReady?: boolean;
}): Promise<{ sellerId: string; accountId: string; listingId: string; variantId: string }> {
  const sellerId = `seller-${RUN}-${input.label}`;
  const accountId = `ca_${RUN}_${input.label}`;
  await ensureSellerProfile(sellerId);
  if (input.paymentReady !== false) {
    await seedPeableAccount({ ownerType: 'user', ownerId: sellerId, accountId });
  }

  // Inserted through the table rather than `insertListing`, so the column
  // defaults apply: this fixture cares about the owner, the price and the stock,
  // and spelling out thirty columns it does not read would be a fixture that
  // breaks whenever the catalogue gains one.
  const [listing] = await db
    .insert(catalogSchema.listings)
    .values({
      ownerType: 'user',
      oxyUserId: sellerId,
      title: `Thing ${input.label}`,
      description: '',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning();
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: input.priceMinor,
      priceCurrency: input.currency,
      inventoryTracked: true,
      inventoryAvailable: input.available ?? 5,
      position: 0,
      optionValues: [],
    },
  ]);

  return { sellerId, accountId, listingId: listing.id, variantId: variant.id };
}

/** A buyer with a saved address, a presentment currency and a cart. */
async function seedBuyer(input: {
  label: string;
  currency: 'EUR' | 'USD' | 'GBP';
  lines: { listingId: string; variantId: string; quantity: number }[];
}): Promise<{ buyerId: string; addressId: string }> {
  const buyerId = `buyer-${RUN}-${input.label}`;
  await upsertUserPreference(buyerId, { preferredCurrency: input.currency });

  const address = await insertAddress(buyerId, {
    recipientName: 'Buyer',
    line1: '1 Street',
    city: 'Barcelona',
    postalCode: '08001',
    country: 'ES',
  });

  const cart = await ensureCart({ kind: 'oxy_user', oxyUserId: buyerId });
  for (const line of input.lines) {
    await upsertCartItem(cart.id, line);
  }
  return { buyerId, addressId: address.id };
}

/**
 * Deliver a signed `payment_intent.*` event to the REAL Peable ingress.
 *
 * The body is the gateway's CURRENT rendering of the intent, as a real delivery
 * would carry it; the event id is per run so a redelivery in a test is a real
 * duplicate and nothing collides with a sibling file.
 */
async function deliverIntentEvent(input: {
  eventId: string;
  type: string;
  intentId: string;
}): Promise<Awaited<ReturnType<typeof ingestPeableDelivery>>> {
  return await ingestPeableDelivery(
    gateway.intentDelivery({
      eventId: `evt_${input.eventId}_${RUN}`,
      type: input.type,
      intentId: input.intentId,
      secret: WEBHOOK_SECRET,
    }),
  );
}

/**
 * The payment opened for a checkout group, which every case below needs — the
 * cart's ONE checkout session (ADR 0021), confirmed BY CARD as the payer would
 * in Peable's sheet. `providerObjectId` is that card payment: Mercaria links it
 * from the gateway's first event about it, through its own metadata marker.
 */
async function paymentFor(checkoutGroupId: string, method: 'card' | 'faircoin' = 'card') {
  const payment = await findNativePaymentByCheckoutGroupId(db, checkoutGroupId);
  if (!payment?.providerCheckoutSessionId) {
    throw new Error(`Checkout group ${checkoutGroupId} opened no checkout session at the rail`);
  }
  const intent = gateway.confirmSession(payment.providerCheckoutSessionId, method);
  return {
    ...payment,
    providerCheckoutSessionId: payment.providerCheckoutSessionId,
    providerObjectId: intent.id,
  };
}

/**
 * Every ledger entry this payment produced, flattened for assertion.
 *
 * Ordered by the ledger's PUBLISHED read order rather than a spelling of its
 * own — see `LEDGER_TRANSACTION_ORDER`. The timestamps alone tie (every leg of a
 * transaction is written by ONE statement and `now()` is the transaction's, so
 * they share an instant to the microsecond), and a tied `ORDER BY` is
 * unspecified in PostgreSQL. That is issue #466: this helper's exact-sequence
 * assertion below failed CI once and passed on the re-run with no change.
 *
 * The order is now TOTAL, so the sequence no longer flickers — but it is stable,
 * not chronological, and the leg order it produces comes from freshly minted
 * uuid v7 keys, so it is not reproducible from one run to the next. Assertions
 * over the legs of a single transaction are therefore written as MULTISETS by
 * {@link legsOfKind}, which is not a workaround: the ledger records no order
 * among the legs of one balanced transaction, so there is none to assert.
 */
async function ledgerEntriesFor(
  paymentId: string,
): Promise<{ kind: string; account: string; currency: string; amount: bigint }[]> {
  const rows = await db
    .select({
      kind: ledgerSchema.ledgerTransactions.kind,
      account: ledgerSchema.ledgerEntries.account,
      currency: ledgerSchema.ledgerEntries.currency,
      amount: ledgerSchema.ledgerEntries.amountMinor,
    })
    .from(ledgerSchema.ledgerEntries)
    .innerJoin(
      ledgerSchema.ledgerTransactions,
      eq(ledgerSchema.ledgerEntries.transactionId, ledgerSchema.ledgerTransactions.id),
    )
    .where(eq(ledgerSchema.ledgerTransactions.paymentId, paymentId))
    .orderBy(...ledgerOrder.LEDGER_TRANSACTION_ORDER, ...ledgerOrder.LEDGER_ENTRY_ORDER);
  return rows.map((row) => ({ ...row, amount: BigInt(row.amount) }));
}

/**
 * One ledger transaction's legs, as a MULTISET in a canonical order.
 *
 * The canonical order is `(account, currency, amount)` — a property of the legs
 * themselves, so both sides of an assertion can be written in it and neither
 * depends on the sequence the database returned. That is the honest shape for
 * this comparison: the legs of a balanced transaction are simultaneous by
 * construction, so "the third leg" names nothing.
 *
 * This is deliberately NOT sorting a result to paper over a non-deterministic
 * query. The query is total (see {@link ledgerEntriesFor}); what this states is
 * that the ASSERTION is about accounting content, and it fails on a missing leg,
 * an extra leg, a wrong account, a wrong currency and a wrong amount alike.
 */
function legsOfKind(
  entries: { kind: string; account: string; currency: string; amount: bigint }[],
  kind: string,
): { account: string; currency: string; amount: bigint }[] {
  return entries
    .filter((entry) => entry.kind === kind)
    .map(({ account, currency, amount }) => ({ account, currency, amount }))
    .sort(
      (a, b) =>
        a.account.localeCompare(b.account) ||
        a.currency.localeCompare(b.currency) ||
        (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0),
    );
}

/** The payment's transfers, oldest first. */
async function transfersFor(paymentId: string) {
  return await db
    .select()
    .from(paymentSchema.transfers)
    .where(eq(paymentSchema.transfers.paymentId, paymentId))
    .orderBy(paymentSchema.transfers.createdAt);
}

/** The outbox rows this payment produced, by event type. */
async function outboxTypesFor(paymentId: string): Promise<string[]> {
  const rows = await db
    .select({ type: paymentSchema.paymentOutboxes.eventType })
    .from(paymentSchema.paymentOutboxes)
    .where(sql`${paymentSchema.paymentOutboxes.payload}->>'paymentId' = ${paymentId}`)
    .orderBy(paymentSchema.paymentOutboxes.createdAt);
  return rows.map((row) => row.type);
}

/** One variant's stock, as the columns actually hold it. */
async function stockOf(variantId: string): Promise<{ available: number; committed: number }> {
  const [variant] = await findVariantsByIds([variantId]);
  return { available: variant.inventoryAvailable, committed: variant.inventoryCommitted };
}

describe('card checkout on the Peable rail — single seller', () => {
  it('creates ONE PaymentIntent carrying everything ADR 0001 D11 requires', async () => {
    const seller = await seedSeller({ label: 'eur1', priceMinor: 4_500, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'eur1',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-eur1`,
    );

    expect(result.orders).toHaveLength(1);
    const payment = await paymentFor(result.checkoutGroupId);
    expect(payment.provider).toBe('peable');

    // The charge is the ORDER's own grand total — shipping included — not the
    // cart subtotal: the buyer must be charged the figure their order states.
    // It crosses the boundary as the gateway's canonical integer STRING.
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    // ONE checkout session for the cart (ADR 0021): a line per seller order —
    // its grand total, shipping included — naming the seller, and ADR 0001
    // D11's metadata copied onto every payment the session creates.
    expect(gateway.state.sessionCalls).toHaveLength(1);
    const [call] = gateway.state.sessionCalls;
    const metadata = {
      paymentId: payment.id,
      checkoutGroupId: result.checkoutGroupId,
      orderCount: '1',
      orderIds: order.id,
      mercaria_payment_id: payment.id,
      mercaria_checkout_group_id: result.checkoutGroupId,
    };
    expect(call.params).toEqual({
      mode: 'payment',
      contact_collection: 'merchant_account',
      ui_mode: 'embedded',
      line_items: [
        {
          price_data: {
            currency: 'USD',
            unit_amount: String(order.totalsGrandTotalPresentmentAmount),
            product_data: { name: `Order ${order.orderNumber}` },
          },
          quantity: 1,
          connected_account: seller.accountId,
        },
      ],
      client_reference_id: payment.id,
      metadata: {
        mercaria_payment_id: payment.id,
        mercaria_checkout_group_id: result.checkoutGroupId,
      },
      payment_intent_data: { metadata },
      expires_at: expect.any(Number),
    });
    expect(call.idempotencyKey).toBe(`cs:${payment.id}`);
    // The payer's card payment carries Mercaria's marker, so its events link.
    expect(gateway.intent(payment.providerObjectId).metadata).toEqual(metadata);

    // The handoff carries the session's client material and NOTHING else (issue
    // #47, backend 7): no charge id, no connected account, no seller identity,
    // and — since ADR 0009 D20 — no key of any kind.
    expect(result.payment).toEqual({
      paymentId: payment.id,
      provider: 'peable',
      checkoutSessionId: payment.providerCheckoutSessionId,
      clientSecret: `${payment.providerCheckoutSessionId}_secret_fixture`,
      amount: {
        amount: order.totalsGrandTotalPresentmentAmount,
        currency: 'USD',
      },
      methods: ['card', 'apple_pay', 'google_pay', 'link'],
    });
  });

  it('delivers while GoWay is DOWN: only a collection depends on where a shop is (ADR 0013)', async () => {
    // GoWay answering nothing but 503s, and counting what is asked of it.
    const asked: string[] = [];
    useGoWayTransportForTests({
      apiBaseUrl: 'https://goway.test',
      fetch: async (url) => {
        asked.push(url);
        const body = JSON.stringify({ error: { code: 'service_unavailable', message: 'down' } });
        return { status: 503, headers: { get: () => 'application/json' }, text: async () => body };
      },
    });
    try {
      const seller = await seedSeller({ label: 'goway-down', priceMinor: 4_500, currency: 'USD' });
      const buyer = await seedBuyer({
        label: 'goway-down',
        currency: 'USD',
        lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
      });
      const result = await checkout(
        { kind: 'oxy', oxyUserId: buyer.buyerId },
        { addressId: buyer.addressId },
        `key-${RUN}-goway-down`,
      );
      expect(result.orders).toHaveLength(1);
      // Not merely tolerated: a delivery checkout never asks GoWay at all.
      expect(asked).toEqual([]);
    } finally {
      useGoWayTransportForTests(null);
    }
  });

  it('pays the order, books a balanced ledger and settles the seller', async () => {
    const seller = await seedSeller({ label: 'eur2', priceMinor: 4_500, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'eur2',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-eur2`,
    );
    const payment = await paymentFor(result.checkoutGroupId);
    const paymentId = payment.id;
    const intentId = payment.providerObjectId;
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    const gross = order.totalsGrandTotalPresentmentAmount;

    gateway.succeed(intentId);
    const delivered = await deliverIntentEvent({
      eventId: 'eur2',
      type: 'payment_intent.succeeded',
      intentId,
    });
    expect(delivered.outcome).toBe('accepted');

    // The order is paid and its stock committed — by the ORDER transition, which
    // is the only thing that moves inventory.
    const [paid] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(paid.status).toBe('paid');
    expect(paid.paymentStatus).toBe('paid');
    // The reservation was CONSUMED, not released: `available` stays down (the
    // unit left the shelf at reserve time) and `committed` returns to zero (it
    // is no longer merely held). The sweep case below is the contrast — there
    // `available` goes back up.
    expect(await stockOf(seller.variantId)).toEqual({ available: 4, committed: 0 });

    // The ledger: the charge, then the transfer that settles it. Both in USD,
    // and the seller's payable closes to zero — which only happens if the two
    // modules agreed on the amount AND the currency.
    const entries = await ledgerEntriesFor(paymentId);
    // Asserted per transaction KIND, as a multiset — see `legsOfKind`.
    expect(entries).toHaveLength(4);
    // The gateway reports no processor fee, so the charge books NO
    // `processor_expense` leg and the whole gross lands in clearing. That is
    // the Peable path's stated fee gap (`event-router.ts`), asserted so the day
    // it is closed this is where it shows.
    expect(legsOfKind(entries, 'charge_succeeded')).toEqual([
      { account: 'merchant_payable', currency: 'USD', amount: BigInt(-gross) },
      { account: 'provider_clearing', currency: 'USD', amount: BigInt(gross) },
    ]);
    expect(legsOfKind(entries, 'transfer_created')).toEqual([
      { account: 'merchant_payable', currency: 'USD', amount: BigInt(gross) },
      { account: 'provider_clearing', currency: 'USD', amount: BigInt(-gross) },
    ]);
    expect(entries.some((entry) => entry.account === 'processor_expense')).toBe(false);
    // There is no commission leg: the rate is zero until #88, so the residual
    // `chargeSucceeded` computes is zero and a zero leg is omitted rather than
    // booked. A non-zero one here would be a rounding leak reported as revenue.
    expect(entries.some((entry) => entry.account === 'commission_revenue')).toBe(false);
    // Balanced per currency, which is the invariant the whole ledger rests on.
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);

    // No conversion happened, so none is recorded: the payment settles in the
    // currency it was charged in.
    const settled = await paymentFor(result.checkoutGroupId);
    expect(settled.status).toBe('succeeded');
    expect(settled.platformAmount).toBeNull();
    expect(settled.platformCurrency).toBeNull();

    // The transfer: one per seller order, drawn from the payment, to the
    // seller's own account, keyed on two durable Mercaria ids. The amount is the
    // one Mercaria computed — the gateway is never asked to split anything.
    const [transfer] = await transfersFor(paymentId);
    expect(transfer.status).toBe('paid');
    expect(transfer.amountAmount).toBe(gross);
    expect(transfer.amountCurrency).toBe('USD');
    expect(transfer.orderId).toBe(order.id);
    expect(gateway.state.transferCalls).toHaveLength(1);
    expect(gateway.state.transferCalls[0].params).toEqual({
      payment_intent: intentId,
      connected_account: seller.accountId,
      external_ref: order.id,
      amount: String(gross),
    });
    expect(gateway.state.transferCalls[0].idempotencyKey).toBe(`tr:${paymentId}:${order.id}`);
    // The row names the object the rail actually made.
    const [madeTransferId] = [...gateway.state.transfers.keys()];
    expect(transfer.providerObjectId).toBe(madeTransferId);

    // No exception was raised: the only outbox row is the success itself.
    expect(await outboxTypesFor(paymentId)).toEqual(['payment_succeeded']);
  });

  it('books and settles a EUR-priced listing in USD: the catalogue converts, the gateway converts nothing', async () => {
    // The catalogue stores NATIVE currency, so a seller pricing in EUR still
    // sells: the buyer is priced and charged in USD at the cart's rates, and
    // everything after the charge is USD.
    const seller = await seedSeller({ label: 'usd1', priceMinor: 10_000, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'usd1',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-usd1`,
    );
    const payment = await paymentFor(result.checkoutGroupId);
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    const gross = order.totalsGrandTotalPresentmentAmount;

    // The buyer is charged in USD — their presentment currency.
    expect(gateway.state.sessionCalls[0]?.params).toMatchObject({
      line_items: [{ price_data: { currency: 'USD' } }],
    });
    expect(order.totalsGrandTotalPresentmentCurrency).toBe('USD');

    gateway.succeed(payment.providerObjectId);
    await deliverIntentEvent({
      eventId: 'usd1',
      type: 'payment_intent.succeeded',
      intentId: payment.providerObjectId,
    });

    // No conversion was reported, so none is captured: `settlementBasis` falls
    // to the presentment side, which is both what the buyer paid and what is
    // owed. Every ledger leg and the transfer are in USD, so the payable closes
    // in ONE currency rather than holding two for a single order.
    const settled = await paymentFor(result.checkoutGroupId);
    expect(settled.platformAmount).toBeNull();
    expect(settled.platformCurrency).toBeNull();
    expect(settled.platformRateProvider).toBeNull();

    const entries = await ledgerEntriesFor(payment.id);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.currency === 'USD')).toBe(true);
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);
    expect(
      entries
        .filter((entry) => entry.account === 'merchant_payable')
        .reduce((sum, entry) => sum + entry.amount, 0n),
    ).toBe(0n);

    const [transfer] = await transfersFor(payment.id);
    expect(transfer.amountCurrency).toBe('USD');
    expect(transfer.amountAmount).toBe(gross);
    expect(gateway.state.transferCalls[0].params.amount).toBe(String(gross));
  });
});

describe('card checkout on the Peable rail — multi-seller', () => {
  it('funds two sellers with ONE PaymentIntent and settles each separately', async () => {
    const first = await seedSeller({ label: 'multiA', priceMinor: 3_000, currency: 'USD' });
    const second = await seedSeller({ label: 'multiB', priceMinor: 7_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'multi',
      currency: 'USD',
      lines: [
        { listingId: first.listingId, variantId: first.variantId, quantity: 1 },
        { listingId: second.listingId, variantId: second.variantId, quantity: 1 },
      ],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-multi`,
    );
    expect(result.orders).toHaveLength(2);

    // ONE intent for the whole group (ADR 0001 D4): one statement line, one SCA
    // challenge, one charge every later refund draws from.
    expect(gateway.state.sessionCalls).toHaveLength(1);
    const payment = await paymentFor(result.checkoutGroupId);
    const orders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    const gross = orders.reduce(
      (total, order) => total + order.totalsGrandTotalPresentmentAmount,
      0,
    );
    // One line per seller order, each naming its seller (ADR 0021).
    expect(gateway.session(payment.providerCheckoutSessionId).amount).toBe(BigInt(gross));
    expect(gateway.session(payment.providerCheckoutSessionId).lines).toHaveLength(2);
    expect(gateway.intent(payment.providerObjectId).metadata).toMatchObject({ orderCount: '2' });

    gateway.succeed(payment.providerObjectId);
    await deliverIntentEvent({
      eventId: 'multi',
      type: 'payment_intent.succeeded',
      intentId: payment.providerObjectId,
    });

    // Both siblings funded together — they cannot have different outcomes.
    const paidOrders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(paidOrders.map((order) => order.status)).toEqual(['paid', 'paid']);

    // TWO transfers, one per seller order, summing to exactly the gross, each
    // drawn from the ONE intent.
    const transfers = await transfersFor(payment.id);
    expect(transfers).toHaveLength(2);
    expect(transfers.reduce((sum, transfer) => sum + transfer.amountAmount, 0)).toBe(gross);
    expect(
      gateway.state.transferCalls.map((call) => String(call.params.connected_account)).sort(),
    ).toEqual([first.accountId, second.accountId].sort());
    expect(new Set(gateway.state.transferCalls.map((call) => call.params.payment_intent))).toEqual(
      new Set([payment.providerObjectId]),
    );
    // Each order's transfer matches the order's own total: the split is the
    // orders' proportions, not an even division.
    for (const order of paidOrders) {
      const transfer = transfers.find((row) => row.orderId === order.id);
      expect(transfer?.amountAmount).toBe(order.totalsGrandTotalPresentmentAmount);
    }

    const entries = await ledgerEntriesFor(payment.id);
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);
  });

  it('withholds ONE seller whose account lapsed, and settles the sibling anyway', async () => {
    const good = await seedSeller({ label: 'isoA', priceMinor: 2_500, currency: 'USD' });
    const lapsed = await seedSeller({ label: 'isoB', priceMinor: 6_500, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'iso',
      currency: 'USD',
      lines: [
        { listingId: good.listingId, variantId: good.variantId, quantity: 1 },
        { listingId: lapsed.listingId, variantId: lapsed.variantId, quantity: 1 },
      ],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-iso`,
    );
    const payment = await paymentFor(result.checkoutGroupId);

    // The seller loses readiness AFTER the buyer paid and BEFORE the transfer —
    // the window ADR 0001 D4 calls Mercaria's controlled skipped transfer.
    await db
      .update(paymentSchema.providerAccounts)
      .set({ onboardingState: 'restricted', payoutsEnabled: false })
      .where(
        and(
          eq(paymentSchema.providerAccounts.provider, 'peable'),
          eq(paymentSchema.providerAccounts.ownerId, lapsed.sellerId),
        ),
      );

    gateway.succeed(payment.providerObjectId);
    await deliverIntentEvent({
      eventId: 'iso',
      type: 'payment_intent.succeeded',
      intentId: payment.providerObjectId,
    });

    // BOTH orders stay paid: the buyer's side of the sale is complete either way,
    // and un-paying one because its seller cannot be paid would take goods back
    // from a buyer who did nothing wrong.
    const orders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(orders.map((order) => order.status)).toEqual(['paid', 'paid']);

    // The good seller was paid; the lapsed one's transfer exists but is pending
    // and was never sent.
    const transfers = await transfersFor(payment.id);
    expect(transfers).toHaveLength(2);
    const goodOrder = orders.find((order) => order.sellerOxyUserId === good.sellerId);
    const lapsedOrder = orders.find((order) => order.sellerOxyUserId === lapsed.sellerId);
    const goodTransfer = transfers.find((row) => row.orderId === goodOrder?.id);
    const lapsedTransfer = transfers.find((row) => row.orderId === lapsedOrder?.id);
    expect(goodTransfer?.status).toBe('paid');
    expect(goodTransfer?.providerObjectId).toBeTruthy();
    expect(lapsedTransfer?.status).toBe('pending');
    expect(lapsedTransfer?.providerObjectId).toBeNull();
    expect(gateway.state.transferCalls).toHaveLength(1);
    expect(gateway.state.transferCalls[0].params.connected_account).toBe(good.accountId);

    // The exception is DURABLE, not a log line — money is owed and unsent.
    expect(await outboxTypesFor(payment.id)).toEqual(['payment_succeeded', 'transfer_withheld']);
    const [withheld] = await db
      .select()
      .from(paymentSchema.paymentOutboxes)
      .where(
        eq(
          paymentSchema.paymentOutboxes.id,
          `payment:transfer_withheld:${payment.id}:${String(lapsedOrder?.id)}`,
        ),
      );
    expect(withheld?.payload).toMatchObject({
      orderId: lapsedOrder?.id,
      sellerKey: `user:${lapsed.sellerId}`,
      reason: expect.stringContaining('restricted'),
    });

    // Only the settled seller's payable closed. The lapsed one's stays open,
    // which is exactly what "Mercaria still owes them" means in the accounts.
    const entries = await ledgerEntriesFor(payment.id);
    const payableBalance = entries
      .filter((entry) => entry.account === 'merchant_payable')
      .reduce((sum, entry) => sum + entry.amount, 0n);
    expect(payableBalance).toBe(BigInt(-(lapsedOrder?.totalsGrandTotalPresentmentAmount ?? 0)));
  });

  it('holds a HIGH-VALUE share for review and settles the ordinary sibling at once', async () => {
    // One share above `HIGH_VALUE_HOLD_THRESHOLDS`, one far below it.
    const big = await seedSeller({
      label: 'holdA',
      priceMinor: HOLD_THRESHOLD_USD + 50_000,
      currency: 'USD',
    });
    const small = await seedSeller({ label: 'holdB', priceMinor: 2_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'hold',
      currency: 'USD',
      lines: [
        { listingId: big.listingId, variantId: big.variantId, quantity: 1 },
        { listingId: small.listingId, variantId: small.variantId, quantity: 1 },
      ],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-hold`,
    );
    const payment = await paymentFor(result.checkoutGroupId);
    gateway.succeed(payment.providerObjectId);
    const before = Date.now();
    await deliverIntentEvent({
      eventId: 'hold',
      type: 'payment_intent.succeeded',
      intentId: payment.providerObjectId,
    });

    const orders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(orders.map((order) => order.status)).toEqual(['paid', 'paid']);
    const bigOrder = orders.find((order) => order.sellerOxyUserId === big.sellerId);
    const smallOrder = orders.find((order) => order.sellerOxyUserId === small.sellerId);

    const transfers = await transfersFor(payment.id);
    const held = transfers.find((row) => row.orderId === bigOrder?.id);
    const settled = transfers.find((row) => row.orderId === smallOrder?.id);

    // The high-value share waits: a pending row that never reached the rail,
    // with its releasable instant DURABLE on the row — the column the release
    // sweep reads — one review window after it became settleable.
    expect(held?.status).toBe('pending');
    expect(held?.providerObjectId).toBeNull();
    const heldUntil = held?.heldUntil?.getTime() ?? 0;
    const windowMs = 72 * 60 * 60 * 1_000;
    expect(heldUntil).toBeGreaterThanOrEqual(before - 60_000 + windowMs);
    expect(heldUntil).toBeLessThanOrEqual(Date.now() + windowMs);

    // The sibling is not held hostage by it.
    expect(settled?.status).toBe('paid');
    expect(settled?.heldUntil).toBeNull();
    expect(gateway.state.transferCalls).toHaveLength(1);
    expect(gateway.state.transferCalls[0].params.connected_account).toBe(small.accountId);

    // A person can see the case, and the seller is still owed in the accounts.
    const [withheld] = await db
      .select()
      .from(paymentSchema.paymentOutboxes)
      .where(
        eq(
          paymentSchema.paymentOutboxes.id,
          `payment:transfer_withheld:${payment.id}:${String(bigOrder?.id)}`,
        ),
      );
    expect(withheld?.payload).toMatchObject({
      orderId: bigOrder?.id,
      sellerKey: `user:${big.sellerId}`,
      reason: expect.stringContaining('high-value'),
    });
    const entries = await ledgerEntriesFor(payment.id);
    expect(
      entries
        .filter((entry) => entry.account === 'merchant_payable')
        .reduce((sum, entry) => sum + entry.amount, 0n),
    ).toBe(BigInt(-(bigOrder?.totalsGrandTotalPresentmentAmount ?? 0)));
  });
});

describe('card checkout on the Peable rail — idempotency and refusals', () => {
  it('converges two concurrent submits on ONE PaymentIntent and one reservation', async () => {
    const seller = await seedSeller({
      label: 'idem',
      priceMinor: 4_000,
      currency: 'USD',
      available: 5,
    });
    const buyer = await seedBuyer({
      label: 'idem',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 2 }],
    });
    const key = `key-${RUN}-idem`;

    // Both submits start against the SAME full cart — the double-tap, and the
    // shape the durable guarantee is actually for. Redis is best-effort and is
    // not running here, so what converges these two is the per-order
    // `orders_idempotency_key_key`: the loser rolls its own reservations back
    // and returns the winner's group.
    const [first, replay] = await Promise.all([
      checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, key),
      checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, key),
    ]);

    expect(replay.checkoutGroupId).toBe(first.checkoutGroupId);
    expect(replay.orders.map((order) => order.id).sort()).toEqual(
      first.orders.map((order) => order.id).sort(),
    );
    // ONE intent object, and the same client secret — a second charge for the
    // same goods is the failure the whole idempotency chain exists to prevent.
    expect(gateway.state.sessions.size).toBe(1);
    expect(replay.payment?.clientSecret).toBe(first.payment?.clientSecret);
    expect(replay.payment?.paymentId).toBe(first.payment?.paymentId);

    // One payment row, one reservation: stock was taken once, not twice.
    const payments = await db
      .select()
      .from(paymentSchema.payments)
      .where(eq(paymentSchema.payments.checkoutGroupId, first.checkoutGroupId));
    expect(payments).toHaveLength(1);
    expect((await stockOf(seller.variantId)).available).toBe(3);
  });

  it('re-reads an opened intent on a later replay instead of creating a second one', async () => {
    const seller = await seedSeller({ label: 'resume', priceMinor: 4_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'resume',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });
    const key = `key-${RUN}-resume`;
    const actor = { kind: 'oxy', oxyUserId: buyer.buyerId } as const;

    const first = await checkout(actor, { addressId: buyer.addressId }, key);
    // The rail's idempotency key ages out after 24 hours; the replay must not
    // depend on it. Once Mercaria holds the intent id, the replay READS it.
    gateway.state.intentsByKey.clear();
    // The same cart submitted again under the same key — the buyer's retry after
    // a lost response. Redis is not running, so it is the per-order unique index
    // that converges it on the first group, whose payment is already open.
    const cart = await ensureCart({ kind: 'oxy_user', oxyUserId: buyer.buyerId });
    await upsertCartItem(cart.id, {
      listingId: seller.listingId,
      variantId: seller.variantId,
      quantity: 1,
    });
    const later = await checkout(actor, { addressId: buyer.addressId }, key);

    expect(later.checkoutGroupId).toBe(first.checkoutGroupId);
    // The SAME payment, payer material and all: the resume reads the intent
    // and hands back its own `client_secret` again.
    expect(later.payment?.checkoutSessionId).toBe(first.payment?.checkoutSessionId);
    expect(later.payment?.clientSecret).toBe(first.payment?.clientSecret);
    expect(later.payment?.clientSecret).toMatch(/^cs_.*_secret_fixture$/);
    expect(gateway.state.sessionCalls).toHaveLength(1);
    expect(gateway.state.sessions.size).toBe(1);
    // …and the loser's reservation was rolled back: stock was taken once.
    expect((await stockOf(seller.variantId)).available).toBe(4);
  });

  it('refuses a EUR cart — marketplace card sales are USD — before taking any stock', async () => {
    const seller = await seedSeller({ label: 'eur-buyer', priceMinor: 4_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'eur-buyer',
      currency: 'EUR',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    await expect(
      checkout(
        { kind: 'oxy', oxyUserId: buyer.buyerId },
        { addressId: buyer.addressId },
        `key-${RUN}-eur-buyer`,
      ),
    ).rejects.toThrow(/not available in EUR.*Switch your currency to USD/is);

    // Nothing was reserved and no charge was opened: a currency question needs
    // no stock to answer.
    expect((await stockOf(seller.variantId)).available).toBe(5);
    expect(gateway.state.sessionCalls).toHaveLength(0);
  });

  it('refuses a seller with no account on the rail, naming them, before taking any stock', async () => {
    const ready = await seedSeller({ label: 'gateA', priceMinor: 3_000, currency: 'USD' });
    const unready = await seedSeller({
      label: 'gateB',
      priceMinor: 3_000,
      currency: 'USD',
      paymentReady: false,
    });
    const buyer = await seedBuyer({
      label: 'gate',
      currency: 'USD',
      lines: [
        { listingId: ready.listingId, variantId: ready.variantId, quantity: 1 },
        { listingId: unready.listingId, variantId: unready.variantId, quantity: 1 },
      ],
    });

    // ADR 0001 D4: the group is refused and NAMED, so the buyer can deselect it
    // through `sellerKeys` — never the ready seller's.
    const unreadyKey = `user:${unready.sellerId}`;
    const refusal = checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-gate`,
    );
    await expect(refusal).rejects.toThrow(/cannot accept payment/);
    // The KEY is the machine field the client deselects by; the sentence a
    // buyer reads never carries it. This fixture seller has no Oxy display
    // name, so the sentence says "A seller" rather than its account id.
    await expect(refusal).rejects.toMatchObject({
      details: { reason: 'seller_not_payment_ready', sellers: [{ sellerKey: unreadyKey }] },
    });
    await expect(refusal).rejects.not.toThrow(unready.sellerId);
    await expect(refusal).rejects.not.toThrow(`user:${ready.sellerId}`);
    expect(gateway.state.sessionCalls).toHaveLength(0);
    expect(await stockOf(ready.variantId)).toEqual({ available: 5, committed: 0 });
    expect(await stockOf(unready.variantId)).toEqual({ available: 5, committed: 0 });

    // Deselecting it is the documented remedy, and it works.
    const placed = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId, sellerKeys: [`user:${ready.sellerId}`] },
      `key-${RUN}-gate-ready`,
    );
    expect(placed.orders).toHaveLength(1);
    expect(gateway.state.sessionCalls).toHaveLength(1);
  });

  it.each(['seller_not_payment_ready', 'seller_not_activated', 'timed_out_claim'] as const)(
    'releases only its own pre-order refusal claim and retries the same key: %s',
    async (scenario) => {
      const redisUrl = process.env.TEST_REDIS_URL;
      if (!redisUrl) throw new Error('TEST_REDIS_URL is required for checkout lease regressions');
      const seller = await seedSeller({
        label: scenario,
        priceMinor: 3_000,
        currency: 'USD',
        paymentReady: false,
      });
      const buyer = await seedBuyer({
        label: scenario,
        currency: 'USD',
        lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
      });
      const key = `key-${RUN}-${scenario}`;
      const redisKey = `checkout:oxy:${buyer.buyerId}:${key}`;
      let activate: () => Promise<unknown>;
      if (scenario === 'seller_not_activated') {
        const { stores } = await import('../../db/schema/stores.js');
        const { updateMerchantCheckoutIntents } = await import(
          '../../db/merchantActivation/activationSettingsRepository.js'
        );
        const [store] = await db
          .insert(stores)
          .values({
            oxyAccountId: seller.sellerId,
            handle: `redis-${RUN}`,
            name: 'Lease fixture',
            description: '',
            brandColor: '#123456',
            defaultCurrency: 'USD',
          })
          .returning();
        await db
          .update(catalogSchema.listings)
          .set({ ownerType: 'store', storeId: store.id, oxyUserId: null })
          .where(eq(catalogSchema.listings.id, seller.listingId));
        const { insertLocation } = await import('../../db/stores/locationRepository.js');
        const { insertLevels } = await import('../../db/catalog/inventoryLevelRepository.js');
        const location = await insertLocation(store.id, {
          name: 'Warehouse',
          type: 'warehouse',
          isDefault: true,
          isActive: true,
          fulfillsOnlineOrders: true,
        });
        await insertLevels([
          {
            variantId: seller.variantId,
            listingId: seller.listingId,
            locationId: location.id,
            available: 5,
            committed: 0,
          },
        ]);
        await seedPeableAccount({
          ownerType: 'store',
          ownerId: store.id,
          accountId: seller.accountId,
        });
        await db.transaction((tx) =>
          updateMerchantCheckoutIntents(tx, { storeId: store.id, nativeCheckoutIntent: 'paused' }),
        );
        activate = () =>
          db.transaction((tx) =>
            updateMerchantCheckoutIntents(tx, {
              storeId: store.id,
              nativeCheckoutIntent: 'enabled',
            }),
          );
      } else {
        activate = () =>
          seedPeableAccount({
            ownerType: 'user',
            ownerId: seller.sellerId,
            accountId: seller.accountId,
          });
      }
      const actor = { kind: 'oxy' as const, oxyUserId: buyer.buyerId };
      const input = { addressId: buyer.addressId };
      const redis = new Redis(redisUrl);
      const redisModule = await import('../../lib/redis.js');
      const redisSpy = vi.spyOn(redisModule, 'getRedisClient').mockReturnValue(redis);
      // Execute the real SET, but lose its acknowledgement beyond the production timeout.
      const originalSet = redis.set.bind(redis);
      const setSpy =
        scenario === 'timed_out_claim'
          ? vi.spyOn(redis, 'set').mockImplementationOnce(async (...args) => {
              const result = await originalSet(...args);
              await new Promise((resolve) =>
                setTimeout(resolve, redisModule.REDIS_TIMEOUT_MS + 50),
              );
              return result;
            })
          : undefined;
      try {
        await expect(checkout(actor, input, key)).rejects.toMatchObject({
          details: {
            reason: scenario === 'seller_not_activated' ? scenario : 'seller_not_payment_ready',
          },
        });
        expect(await redis.get(redisKey)).toBeNull();
        expect(await stockOf(seller.variantId)).toEqual({ available: 5, committed: 0 });
        expect(
          await db
            .select({ id: orderSchema.orders.id })
            .from(orderSchema.orders)
            .where(eq(orderSchema.orders.buyerOxyUserId, buyer.buyerId)),
        ).toHaveLength(0);
        expect(gateway.state.sessionCalls).toHaveLength(0);
        await activate();
        const placed = await checkout(actor, input, key);
        expect(placed.orders).toHaveLength(1);
        expect(await redis.get(redisKey)).toBe(placed.checkoutGroupId);
        const replay = await checkout(actor, input, key);
        expect(replay.checkoutGroupId).toBe(placed.checkoutGroupId);
        expect(
          await db
            .select({ id: orderSchema.orders.id })
            .from(orderSchema.orders)
            .where(eq(orderSchema.orders.buyerOxyUserId, buyer.buyerId)),
        ).toHaveLength(1);
        expect(await stockOf(seller.variantId)).toEqual({ available: 4, committed: 1 });
      } finally {
        setSpy?.mockRestore();
        redisSpy.mockRestore();
        await redis.del(redisKey);
        await redis.quit();
      }
    },
  );

  it('leaves the reservation clock alone when a payment fails and is retried', async () => {
    const seller = await seedSeller({ label: 'retry', priceMinor: 5_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'retry',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });
    const key = `key-${RUN}-retry`;

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      key,
    );
    const payment = await paymentFor(result.checkoutGroupId);
    const intentId = payment.providerObjectId;
    const [before] = await findOrdersInCheckoutGroup(result.checkoutGroupId);

    // A declined attempt: the gateway returns the card intent to
    // `requires_payment_method` with `last_payment_error`, still payable, so the
    // buyer retries on the SAME intent with another card.
    gateway.decline(intentId);
    await deliverIntentEvent({
      eventId: 'retry-failed',
      type: 'payment_intent.payment_failed',
      intentId,
    });

    // Mercaria's `failed`, which is NOT terminal — a declined card is retried.
    const failed = await paymentFor(result.checkoutGroupId);
    expect(failed.status).toBe('failed');
    // The order is untouched: a failed payment releases nothing (#45 acceptance
    // 4). Only the reservation sweep releases stock, and its clock is the
    // ORDER's creation time, which no retry can move.
    const [after] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(after.status).toBe('pending_payment');
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(await outboxTypesFor(payment.id)).toEqual(['payment_failed']);

    // The buyer confirms again on that same intent and it succeeds. No second
    // PaymentIntent was ever created, and the reservation clock, which belongs
    // to the order, never restarts.
    gateway.succeed(intentId);
    await deliverIntentEvent({
      eventId: 'retry-succeeded',
      type: 'payment_intent.succeeded',
      intentId,
    });

    expect(gateway.state.sessions.size).toBe(1);
    expect(gateway.state.sessionCalls).toHaveLength(1);
    const [settledOrder] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(settledOrder.status).toBe('paid');
    expect(settledOrder.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it('applies a redelivered success once: one ledger charge, one transfer', async () => {
    const seller = await seedSeller({ label: 'dup', priceMinor: 3_300, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'dup',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });
    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-dup`,
    );
    const payment = await paymentFor(result.checkoutGroupId);
    gateway.succeed(payment.providerObjectId);

    const deliveries = [
      // The same delivery twice — caught by the event store's unique index.
      { eventId: 'dup-1', expected: 'accepted' },
      { eventId: 'dup-1', expected: 'duplicate' },
      // A DIFFERENT event asserting the same success — caught by the payment CAS.
      { eventId: 'dup-2', expected: 'accepted' },
    ] as const;
    for (const delivery of deliveries) {
      const outcome = await deliverIntentEvent({
        eventId: delivery.eventId,
        type: 'payment_intent.succeeded',
        intentId: payment.providerObjectId,
      });
      expect(outcome.outcome).toBe(delivery.expected);
    }

    const entries = await ledgerEntriesFor(payment.id);
    expect(entries.filter((entry) => entry.kind === 'charge_succeeded')).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === 'transfer_created')).toHaveLength(2);
    expect(await transfersFor(payment.id)).toHaveLength(1);
    expect(gateway.state.transferCalls).toHaveLength(1);
    expect(await outboxTypesFor(payment.id)).toEqual(['payment_succeeded']);
  });
});

describe('card checkout on the Peable rail — abandonment and a late capture', () => {
  /**
   * The checkout the sweep releases and the gateway then captures anyway.
   *
   * Shared by the two cases below, which assert the two halves of one
   * invariant separately: nothing is re-committed (no oversell), and the
   * condition is raised durably for a person.
   */
  async function releaseThenCapture(label: string) {
    const seller = await seedSeller({ label, priceMinor: 3_500, currency: 'USD' });
    const buyer = await seedBuyer({
      label,
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-${label}`,
    );
    const payment = await paymentFor(result.checkoutGroupId);
    const intentId = payment.providerObjectId;
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);

    // Age the order past the reservation TTL, the way time would.
    await db
      .update(orderSchema.orders)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1_000) })
      .where(eq(orderSchema.orders.id, order.id));

    await handleExpireReservations();

    // Stock went back, the order is cancelled, and the rail was told to stop —
    // under a key derived from the payment, so a second sweep cannot cancel
    // twice.
    expect((await stockOf(seller.variantId)).available).toBe(5);
    const [cancelled] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(cancelled.status).toBe('cancelled');
    // The cart's checkout session is expired, which cancels its payment.
    expect(gateway.state.expireCalls).toEqual([payment.providerCheckoutSessionId]);
    expect(gateway.intent(intentId).status).toBe('canceled');
    const released = await paymentFor(result.checkoutGroupId);
    expect(released.status).toBe('canceled');

    // …and then the money arrives anyway: a capture that raced the sweep.
    gateway.succeed(intentId);
    const delivered = await deliverIntentEvent({
      eventId: `${label}-late`,
      type: 'payment_intent.succeeded',
      intentId,
    });
    expect(delivered.outcome).toBe('accepted');
    return { seller, paymentId: payment.id, checkoutGroupId: result.checkoutGroupId };
  }

  it('cancels the PaymentIntent when the reservation expires, and re-commits NOTHING if the money arrives anyway', async () => {
    const { seller, paymentId, checkoutGroupId } = await releaseThenCapture('sweep');

    // NOTHING is re-committed. Re-committing would oversell whatever has been
    // bought since; booking the charge would credit commission with the whole
    // gross; refunding is a policy decision needing a person.
    expect(await stockOf(seller.variantId)).toEqual({ available: 5, committed: 0 });
    const [stillCancelled] = await findOrdersInCheckoutGroup(checkoutGroupId);
    expect(stillCancelled.status).toBe('cancelled');
    expect((await paymentFor(checkoutGroupId)).status).toBe('canceled');
    expect(await ledgerEntriesFor(paymentId)).toEqual([]);
    expect(await transfersFor(paymentId)).toEqual([]);
    expect(gateway.state.transferCalls).toHaveLength(0);
  });

  it('raises the late capture as a durable exception for an operator (#50)', async () => {
    const { paymentId } = await releaseThenCapture('sweep-flag');

    // The condition is durable and visible — #50's operator queue — rather than
    // a log line and a processing note on the event row.
    expect(await outboxTypesFor(paymentId)).toEqual(['payment_succeeded_after_release']);
  });
});

describe('the buyer-facing payment status', () => {
  it('answers from verified state, and only to the buyer who owns the group', async () => {
    const seller = await seedSeller({ label: 'status', priceMinor: 2_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'status',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-status`,
    );
    const before = await readCheckoutPaymentStatus(
      { kind: 'oxy_user', oxyUserId: buyer.buyerId },
      result.checkoutGroupId,
    );
    expect(before.status).toBe('created');
    expect(before.provider).toBe('peable');
    expect(before.orders).toHaveLength(1);
    expect(before.orders[0]?.paymentStatus).toBe('unpaid');

    // The gateway saying `succeeded` is not enough: until a VERIFIED delivery
    // lands, the buyer is told what Mercaria has verified.
    const payment = await paymentFor(result.checkoutGroupId);
    gateway.succeed(payment.providerObjectId);
    expect(
      (
        await readCheckoutPaymentStatus(
          { kind: 'oxy_user', oxyUserId: buyer.buyerId },
          result.checkoutGroupId,
        )
      ).status,
    ).toBe('created');

    await deliverIntentEvent({
      eventId: 'status',
      type: 'payment_intent.succeeded',
      intentId: payment.providerObjectId,
    });

    const after = await readCheckoutPaymentStatus(
      { kind: 'oxy_user', oxyUserId: buyer.buyerId },
      result.checkoutGroupId,
    );
    expect(after.status).toBe('succeeded');
    expect(after.orders[0]?.status).toBe('paid');
    expect(after.orders[0]?.paymentStatus).toBe('paid');

    // Somebody else's checkout group does not exist as far as this buyer is
    // concerned — a 404, never a 403, because its existence is not a fact to
    // confirm.
    await expect(
      readCheckoutPaymentStatus(
        { kind: 'oxy_user', oxyUserId: `stranger-${RUN}` },
        result.checkoutGroupId,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses a forged delivery and changes nothing', async () => {
    const seller = await seedSeller({ label: 'forged', priceMinor: 2_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'forged',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });
    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-forged`,
    );
    const payment = await paymentFor(result.checkoutGroupId);
    gateway.succeed(payment.providerObjectId);

    // Signed with a secret this deployment does not hold.
    const forged = await ingestPeableDelivery(
      gateway.intentDelivery({
        eventId: `evt_forged_${RUN}`,
        type: 'payment_intent.succeeded',
        intentId: payment.providerObjectId,
        secret: 'pwhsec_attacker',
      }),
    );
    expect(forged).toEqual({ outcome: 'rejected', code: 'invalid_signature' });
    expect((await paymentFor(result.checkoutGroupId)).status).toBe('created');
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(order.status).toBe('pending_payment');
    expect(await ledgerEntriesFor(payment.id)).toEqual([]);
  });
});

/** Real app routes + real SDK HTTP; only the external Oxy policy service and the Peable gateway are fixtures. */
async function shoppingRequest(
  path: string,
  token: string | null,
  method = 'GET',
  body?: unknown,
  key?: string,
) {
  const response = await fetch(`${shoppingUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      data: {
        listing: import('@mercaria/shared-types').ReviewedShoppingListing;
        items: import('@mercaria/shared-types').ReviewedShoppingListing[];
        checkoutGroupId: string;
        purchaseApproval: import('@oxy.so/contracts').PurchaseApproval;
        payment?: import('@mercaria/shared-types').CheckoutPaymentHandoff;
      };
    },
  };
}
async function reviewShoppingListing(listingId: string) {
  const operator = supervision.token('catalog-platform-operator', false);
  const candidate = await shoppingRequest(`/internal/catalog-safety/${listingId}`, operator);
  expect(candidate.status, JSON.stringify(candidate.body)).toBe(200);
  const result = await shoppingRequest(
    `/internal/catalog-safety/${listingId}/reviews`,
    operator,
    'POST',
    {
      contentDigest: candidate.body.data.listing.reviewDigest,
      decision: 'allow',
    },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}
async function approveShoppingPurchase(approvalId: string) {
  const details = await fetch(`${supervision.url}/safety/supervision/purchases/${approvalId}`, {
    headers: { Authorization: 'Bearer guardian-fixture' },
  });
  expect(details.status).toBe(200);
  const evidence = (await details.json()) as import('@oxy.so/contracts').PurchaseApproval;
  expect(evidence.lineItems.length).toBeGreaterThan(0);
  expect(
    evidence.lineItems.reduce((sum, line) => sum + line.lineAmountMinor, 0) +
      evidence.shippingMinor +
      evidence.taxMinor -
      evidence.discountMinor +
      evidence.roundingAdjustmentMinor,
  ).toBe(evidence.amountMinor);
  const response = await fetch(
    `${supervision.url}/safety/supervision/purchases/${approvalId}/review`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer guardian-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    },
  );
  expect(response.status).toBe(200);
  return evidence;
}

describe('supervised shopping through the existing checkout and payment seam', () => {
  it('public catalog keeps anonymous/adult reads but never downgrades invalid or unavailable authority', async () => {
    const path = `/legacy-merchants/lookup?domain=missing-${RUN}.example`;
    expect((await shoppingRequest(path, null)).status).toBe(200);
    expect((await shoppingRequest(path, supervision.token('catalog-adult', false))).status).toBe(
      200,
    );
    expect((await shoppingRequest(path, 'invalid-token')).status).toBe(401);
    const valid = supervision.token('catalog-expired', false).split('.');
    valid[1] = Buffer.from(
      JSON.stringify({ userId: 'catalog-expired', sessionId: 'session-catalog-expired', exp: 1 }),
    ).toString('base64url');
    expect((await shoppingRequest(path, valid.join('.'))).status).toBe(401);
    const outage = '/session/validate-header/session-catalog-unavailable';
    supervision.failAlways.add(outage);
    try {
      expect((await shoppingRequest(path, supervision.token('catalog-unavailable'))).status).toBe(
        503,
      );
    } finally {
      supervision.failAlways.delete(outage);
    }
  });

  it('refuses explicit supervised sessions on every legacy anonymous catalog router', async () => {
    const token = supervision.token('legacy-child');
    for (const name of [
      'listings',
      'stores',
      'product-page',
      'public-api',
      'product-families',
      'merchants',
      'outbound',
      'price-history',
      'compatibility',
      'price-signals',
      'storefronts',
      'facets',
      'catalog-attributes',
      'offers',
      'retail-offers',
      'seo',
      'search',
      'canonical-products',
      'brand-relationships',
    ]) {
      const result = await shoppingRequest(`/legacy-${name}`, token);
      expect(result.status, name).toBe(403);
    }
  });

  it('operator review → child browse/cart → exact multi-seller guardian evidence → PSP timeout/retry → signed webhook', async () => {
    const first = await seedSeller({ label: 'kids-a', priceMinor: 1200, currency: 'USD' });
    const second = await seedSeller({ label: 'kids-b', priceMinor: 800, currency: 'USD' });
    const buyer = await seedBuyer({ label: 'kids-main', currency: 'USD', lines: [] });
    const token = supervision.token(buyer.buyerId);
    const seller = supervision.token(first.sellerId, false);
    const deniedReview = await shoppingRequest(
      `/internal/catalog-safety/${first.listingId}/reviews`,
      seller,
      'POST',
      { contentDigest: 'a'.repeat(64), decision: 'allow' },
    );
    // A seller holds no `catalog.operate`: the review surface is not revealed.
    expect(deniedReview.status).toBe(404);
    const unreviewed = await shoppingRequest('/supervised-shopping/cart/items', token, 'POST', {
      listingId: first.listingId,
      variantId: first.variantId,
      quantity: 1,
    });
    expect(unreviewed.status, JSON.stringify(unreviewed.body)).toBe(409);
    await reviewShoppingListing(first.listingId);
    await reviewShoppingListing(second.listingId);
    const browse = await shoppingRequest('/supervised-shopping/catalog', token);
    expect(browse.status, JSON.stringify(browse.body)).toBe(200);
    expect(
      browse.body.data.items.find((row: { id: string }) => row.id === first.listingId),
    ).not.toHaveProperty('imageFileIds');
    for (const item of [first, second]) {
      const added = await shoppingRequest('/supervised-shopping/cart/items', token, 'POST', {
        listingId: item.listingId,
        variantId: item.variantId,
        quantity: 1,
      });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
    }
    const key = `kids-${RUN}-complete`;
    const input = { addressId: buyer.addressId, paymentMethod: 'card' };
    const prepared = await shoppingRequest(
      '/supervised-shopping/checkout',
      token,
      'POST',
      input,
      key,
    );
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const { checkoutGroupId, purchaseApproval } = prepared.body.data;
    expect(purchaseApproval.status).toBe('pending');
    expect(gateway.state.sessionCalls).toHaveLength(0);
    expect(purchaseApproval.merchantAccountIds.sort()).toEqual(
      [first.sellerId, second.sellerId].sort(),
    );
    expect(purchaseApproval.lineItems).toHaveLength(2);
    const beforeStock = await Promise.all([stockOf(first.variantId), stockOf(second.variantId)]);
    const replay = await shoppingRequest(
      '/supervised-shopping/checkout',
      token,
      'POST',
      input,
      key,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.checkoutGroupId).toBe(checkoutGroupId);
    expect(replay.body.data.purchaseApproval.id).toBe(purchaseApproval.id);
    expect(await Promise.all([stockOf(first.variantId), stockOf(second.variantId)])).toEqual(
      beforeStock,
    );
    const changed = await shoppingRequest(
      '/supervised-shopping/checkout',
      token,
      'POST',
      { ...input, shippingSelections: { [`user:${first.sellerId}`]: 'express' } },
      key,
    );
    expect(changed.status).toBe(409);
    const premature = await shoppingRequest(
      `/supervised-shopping/checkout/${checkoutGroupId}/resume`,
      token,
      'POST',
    );
    expect(premature.status).toBe(200);
    expect(premature.body.data.payment).toBeUndefined();
    const evidence = await approveShoppingPurchase(purchaseApproval.id);
    expect(evidence.amountMinor).toBe(purchaseApproval.amountMinor);
    gateway.state.acceptThenTimeout = true;
    const lost = await shoppingRequest(
      `/supervised-shopping/checkout/${checkoutGroupId}/resume`,
      token,
      'POST',
    );
    expect(lost.status).toBeGreaterThanOrEqual(500);
    expect(gateway.state.sessions.size).toBe(1);
    expect(supervision.approvals.get(purchaseApproval.id)?.status).toBe('reserved');
    // Approval expiry limits the first reservation, not recovery of an already
    // reserved PSP operation. Keep the original session valid while passing that deadline.
    vi.useFakeTimers({ toFake: ['Date'] });
    let resumed: Awaited<ReturnType<typeof shoppingRequest>>;
    try {
      vi.setSystemTime(new Date(Date.parse(purchaseApproval.expiresAt) + 1000));
      resumed = await shoppingRequest(
        `/supervised-shopping/checkout/${checkoutGroupId}/resume`,
        token,
        'POST',
      );
    } finally {
      vi.useRealTimers();
    }
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(gateway.state.sessions.size).toBe(1);
    expect(new Set(gateway.state.sessionCalls.map((call) => call.idempotencyKey)).size).toBe(1);
    // The durable thing is the cart's ONE checkout session; the payer pays it by card.
    const payment = await paymentFor(checkoutGroupId);
    gateway.succeed(payment.providerObjectId);
    await deliverIntentEvent({
      eventId: 'kids-paid',
      type: 'payment_intent.succeeded',
      intentId: payment.providerObjectId,
    });
    expect(supervision.approvals.get(purchaseApproval.id)?.status).toBe('confirmed');
    expect(
      (await findOrdersInCheckoutGroup(checkoutGroupId)).every((order) => order.status === 'paid'),
    ).toBe(true);
    await deliverIntentEvent({
      eventId: 'kids-paid',
      type: 'payment_intent.succeeded',
      intentId: payment.providerObjectId,
    });
    expect(gateway.state.sessions.size).toBe(1);
  });

  it.each([false, true])(
    'closes approval only with confirmed cancellation; uncertain PSP=%s',
    async (uncertain) => {
      const label = uncertain ? 'kids-uncertain-cancel' : 'kids-confirmed-cancel';
      const item = await seedSeller({ label, priceMinor: 1200, currency: 'USD' });
      const buyer = await seedBuyer({ label, currency: 'USD', lines: [{ ...item, quantity: 1 }] });
      const token = supervision.token(buyer.buyerId);
      await reviewShoppingListing(item.listingId);
      const prepared = await shoppingRequest(
        '/supervised-shopping/checkout',
        token,
        'POST',
        { addressId: buyer.addressId, paymentMethod: 'card' },
        `kids-${RUN}-${label}`,
      );
      expect(prepared.status).toBe(200);
      const { checkoutGroupId, purchaseApproval } = prepared.body.data;
      await approveShoppingPurchase(purchaseApproval.id);
      gateway.state.acceptThenTimeout = uncertain;
      const resumed = await shoppingRequest(
        `/supervised-shopping/checkout/${checkoutGroupId}/resume`,
        token,
        'POST',
      );
      expect(resumed.status).toBe(uncertain ? 500 : 200);
      expect(supervision.approvals.get(purchaseApproval.id)?.status).toBe('reserved');
      const payment = await findNativePaymentByCheckoutGroupId(db, checkoutGroupId);
      if (!payment) throw new Error('Expected durable payment');
      await db
        .update(orderSchema.orders)
        .set({ createdAt: new Date(Date.now() - 3600_000) })
        .where(eq(orderSchema.orders.checkoutGroupId, checkoutGroupId));
      await handleExpireReservations();
      const eventId = `payment:supervised_purchase_cancelled:${payment.id}`;
      const { drainPaymentOutbox } = await import('../payments/payment-outbox.service.js');
      const { runPaymentOutboxEvent } = await import('../payments/outbox-handlers.js');
      await drainPaymentOutbox({ eventId, handler: runPaymentOutboxEvent });
      expect(supervision.approvals.get(purchaseApproval.id)?.status).toBe(
        uncertain ? 'reserved' : 'cancelled',
      );
      expect((await outboxTypesFor(payment.id)).includes('supervised_purchase_cancelled')).toBe(
        !uncertain,
      );
      // Repeated sweeps and outbox delivery never recycle consent or open a new intent.
      await handleExpireReservations();
      await drainPaymentOutbox({ eventId, handler: runPaymentOutboxEvent });
      expect(gateway.state.sessions.size).toBe(1);
      expect(supervision.approvals.get(purchaseApproval.id)?.status).toBe(
        uncertain ? 'reserved' : 'cancelled',
      );
    },
  );

  /**
   * The gateway cancelling an intent on its OWN (an expiry, not the sweep) is
   * a confirmed cancellation, and it must release the purchase approval the
   * same way the sweep's confirmed cancel does — the Peable router records it.
   */
  it('releases the approval when the gateway itself cancels the intent', async () => {
    const item = await seedSeller({
      label: 'kids-gateway-cancel',
      priceMinor: 1300,
      currency: 'USD',
    });
    const buyer = await seedBuyer({
      label: 'kids-gateway-cancel',
      currency: 'USD',
      lines: [{ ...item, quantity: 1 }],
    });
    const token = supervision.token(buyer.buyerId);
    await reviewShoppingListing(item.listingId);
    const prepared = await shoppingRequest(
      '/supervised-shopping/checkout',
      token,
      'POST',
      { addressId: buyer.addressId, paymentMethod: 'card' },
      `kids-${RUN}-gateway-cancel`,
    );
    expect(prepared.status).toBe(200);
    const { checkoutGroupId, purchaseApproval } = prepared.body.data;
    await approveShoppingPurchase(purchaseApproval.id);
    const resumed = await shoppingRequest(
      `/supervised-shopping/checkout/${checkoutGroupId}/resume`,
      token,
      'POST',
    );
    expect(resumed.status).toBe(200);
    expect(supervision.approvals.get(purchaseApproval.id)?.status).toBe('reserved');

    const payment = await paymentFor(checkoutGroupId);
    const intent = gateway.state.intents.get(payment.providerObjectId);
    if (!intent) throw new Error('Expected the gateway to hold the intent');
    intent.status = 'canceled';
    const delivered = await deliverIntentEvent({
      eventId: `gateway-cancel-${payment.id}`,
      type: 'payment_intent.canceled',
      intentId: payment.providerObjectId,
    });
    expect(delivered.outcome).toBe('accepted');

    const eventId = `payment:supervised_purchase_cancelled:${payment.id}`;
    const { drainPaymentOutbox } = await import('../payments/payment-outbox.service.js');
    const { runPaymentOutboxEvent } = await import('../payments/outbox-handlers.js');
    await drainPaymentOutbox({ eventId, handler: runPaymentOutboxEvent });
    expect(supervision.approvals.get(purchaseApproval.id)?.status).toBe('cancelled');
    expect(await outboxTypesFor(payment.id)).toContain('supervised_purchase_cancelled');
  });

  it('revokes exposed text and prevents charging after the reviewed item changes', async () => {
    const item = await seedSeller({ label: 'kids-edit', priceMinor: 1400, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'kids-edit',
      currency: 'USD',
      lines: [{ ...item, quantity: 1 }],
    });
    const token = supervision.token(buyer.buyerId);
    await reviewShoppingListing(item.listingId);
    const prepared = await shoppingRequest(
      '/supervised-shopping/checkout',
      token,
      'POST',
      { addressId: buyer.addressId, paymentMethod: 'card' },
      `kids-${RUN}-edit`,
    );
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const { checkoutGroupId, purchaseApproval } = prepared.body.data;
    await approveShoppingPurchase(purchaseApproval.id);
    await db
      .update(catalogSchema.listings)
      .set({ title: 'Materially different text' })
      .where(eq(catalogSchema.listings.id, item.listingId));
    const resumed = await shoppingRequest(
      `/supervised-shopping/checkout/${checkoutGroupId}/resume`,
      token,
      'POST',
    );
    expect(resumed.status).toBe(409);
    expect(gateway.state.sessionCalls).toHaveLength(0);
    const browse = await shoppingRequest('/supervised-shopping/catalog', token);
    expect(browse.body.data.items.some((row: { id: string }) => row.id === item.listingId)).toBe(
      false,
    );
  });

  it('rolls back every seller order when the second insert fails, then retries without duplicated stock', async () => {
    const first = await seedSeller({ label: 'kids-atomic-a', priceMinor: 900, currency: 'USD' });
    const second = await seedSeller({ label: 'kids-atomic-b', priceMinor: 1100, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'kids-atomic',
      currency: 'USD',
      lines: [
        { ...first, quantity: 1 },
        { ...second, quantity: 1 },
      ],
    });
    const token = supervision.token(buyer.buyerId);
    await reviewShoppingListing(first.listingId);
    await reviewShoppingListing(second.listingId);
    const trigger = `kids_order_fault_${RUN}`.replaceAll('-', '_');
    // Fixture IDs are generated locally; still quote as SQL literals, never identifier interpolation from requests.
    const buyerLiteral = `'${buyer.buyerId.replaceAll("'", "''")}'`;
    await db.execute(
      sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.buyer_oxy_user_id = ${buyerLiteral} AND EXISTS
        (SELECT 1 FROM orders WHERE buyer_oxy_user_id = NEW.buyer_oxy_user_id) THEN
        RAISE EXCEPTION 'fixture second seller insert failure';
      END IF; RETURN NEW; END; $$`),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      ),
    );
    const input = { addressId: buyer.addressId, paymentMethod: 'card' };
    const key = `kids-${RUN}-atomic`;
    try {
      const failed = await shoppingRequest(
        '/supervised-shopping/checkout',
        token,
        'POST',
        input,
        key,
      );
      expect(failed.status).toBe(500);
      expect(
        await db
          .select({ id: orderSchema.orders.id })
          .from(orderSchema.orders)
          .where(eq(orderSchema.orders.buyerOxyUserId, buyer.buyerId)),
      ).toHaveLength(0);
      expect(await stockOf(first.variantId)).toEqual({ available: 5, committed: 0 });
      expect(await stockOf(second.variantId)).toEqual({ available: 5, committed: 0 });
      expect(gateway.state.sessions.size).toBe(0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${trigger} ON orders`));
      await db.execute(sql.raw(`DROP FUNCTION ${trigger}()`));
    }
    const retry = await shoppingRequest('/supervised-shopping/checkout', token, 'POST', input, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(await findOrdersInCheckoutGroup(retry.body.data.checkoutGroupId)).toHaveLength(2);
    expect(await stockOf(first.variantId)).toEqual({ available: 4, committed: 1 });
    expect(await stockOf(second.variantId)).toEqual({ available: 4, committed: 1 });
  });

  it('recovers committed orders after approval preparation fails and refuses changed selection under the original key', async () => {
    const item = await seedSeller({ label: 'kids-recovery', priceMinor: 1500, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'kids-recovery',
      currency: 'USD',
      lines: [{ ...item, quantity: 1 }],
    });
    const token = supervision.token(buyer.buyerId);
    await reviewShoppingListing(item.listingId);
    supervision.failNext.add('/safety/service/purchases');
    const input = { addressId: buyer.addressId, paymentMethod: 'card' };
    const key = `kids-${RUN}-recovery`;
    const failed = await shoppingRequest(
      '/supervised-shopping/checkout',
      token,
      'POST',
      input,
      key,
    );
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const persisted = await db
      .select()
      .from(orderSchema.orders)
      .where(eq(orderSchema.orders.buyerOxyUserId, buyer.buyerId));
    expect(persisted).toHaveLength(1);
    const retry = await shoppingRequest('/supervised-shopping/checkout', token, 'POST', input, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.data.checkoutGroupId).toBe(persisted[0].checkoutGroupId);
    expect(await stockOf(item.variantId)).toEqual({ available: 4, committed: 1 });
    const added = await shoppingRequest('/supervised-shopping/cart/items', token, 'POST', {
      listingId: item.listingId,
      variantId: item.variantId,
      quantity: 2,
    });
    expect(added.status).toBe(200);
    const changed = await shoppingRequest(
      '/supervised-shopping/checkout',
      token,
      'POST',
      input,
      key,
    );
    expect(changed.status).toBe(409);
    expect(gateway.state.sessions.size).toBe(0);
  });
});

describe('ONE checkout session per cart; the fee follows the method used (ADR 0021)', () => {
  async function twoSellerCart(label: string) {
    const first = await seedSeller({ label: `${label}A`, priceMinor: 3_000, currency: 'USD' });
    const second = await seedSeller({ label: `${label}B`, priceMinor: 7_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label,
      currency: 'USD',
      lines: [
        { listingId: first.listingId, variantId: first.variantId, quantity: 1 },
        { listingId: second.listingId, variantId: second.variantId, quantity: 1 },
      ],
    });
    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyer.buyerId },
      { addressId: buyer.addressId },
      `key-${RUN}-${label}`,
    );
    const session = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    if (!session?.providerCheckoutSessionId) throw new Error('no checkout session opened');
    return {
      first,
      second,
      result,
      payment: session,
      sessionId: session.providerCheckoutSessionId,
    };
  }

  async function outcomesFor(paymentId: string) {
    const rows = await db
      .select()
      .from(feeOutcomeSchema.orderFeeOutcomes)
      .where(eq(feeOutcomeSchema.orderFeeOutcomes.paymentId, paymentId));
    return rows.map((row) => [row.method, row.feeAmount]);
  }

  it('a USD cart of two sellers paid by CARD: the platform charge, a transfer each, card fees', async () => {
    const { first, second, result, payment, sessionId } = await twoSellerCart('sess-card');
    // A line per seller order, each naming its seller; the session sums to the payment.
    const session = gateway.session(sessionId);
    expect(session.lines.map((line) => line.connectedAccount).sort()).toEqual(
      [first.accountId, second.accountId].sort(),
    );
    expect(session.amount).toBe(BigInt(payment.presentmentAmount));

    const intent = gateway.confirmSession(sessionId, 'card');
    // The session's card payment is Mercaria's OWN platform charge: no seller on it.
    expect(intent.faircoin).toBeUndefined();
    gateway.succeed(intent.id);
    await deliverIntentEvent({
      eventId: 'sess-card-paid',
      type: 'payment_intent.succeeded',
      intentId: intent.id,
    });

    const paid = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    expect(paid).toMatchObject({
      status: 'succeeded',
      provider: 'peable',
      providerObjectId: intent.id,
    });
    // …settled to each seller by the transfers the platform charge has always made.
    expect((await transfersFor(payment.id)).length).toBe(2);
    expect((await outcomesFor(payment.id)).map(([method]) => method)).toEqual(['card', 'card']);
  });

  it('a USD cart paid by FAIRCOIN: each seller paid directly, no transfer, no ledger, no fee', async () => {
    const { result, payment, sessionId } = await twoSellerCart('sess-fair');
    const intent = gateway.confirmSession(sessionId, 'faircoin');
    expect(intent.faircoin?.outputs).toHaveLength(2);
    gateway.succeed(intent.id);
    await deliverIntentEvent({
      eventId: 'sess-fair-paid',
      type: 'payment_intent.succeeded',
      intentId: intent.id,
    });

    const paid = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    expect(paid).toMatchObject({
      status: 'succeeded',
      provider: 'peable_faircoin',
      providerObjectId: intent.id,
    });
    const orders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(orders.map((order) => order.status)).toEqual(['paid', 'paid']);
    expect(gateway.state.transferCalls).toEqual([]);
    expect(await ledgerEntriesFor(payment.id)).toEqual([]);
    expect(await outcomesFor(payment.id)).toEqual([
      ['faircoin', 0],
      ['faircoin', 0],
    ]);
  });

  it('a payer who switches from the card to FairCoin: the stale card cancel changes nothing', async () => {
    const { result, sessionId } = await twoSellerCart('sess-switch');
    const card = gateway.confirmSession(sessionId, 'card');
    gateway.decline(card.id);
    await deliverIntentEvent({
      eventId: 'sess-switch-declined',
      type: 'payment_intent.payment_failed',
      intentId: card.id,
    });
    expect((await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId))?.provider).toBe(
      'peable',
    );

    // The payer chooses FairCoin instead: the card payment is cancelled at the gateway.
    const fair = gateway.confirmSession(sessionId, 'faircoin');
    expect(gateway.intent(card.id).status).toBe('canceled');
    const stale = await deliverIntentEvent({
      eventId: 'sess-switch-stale',
      type: 'payment_intent.canceled',
      intentId: card.id,
    });
    expect(stale.outcome).toBe('accepted');
    const afterStale = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    expect(afterStale?.status).not.toBe('canceled');

    gateway.succeed(fair.id);
    await deliverIntentEvent({
      eventId: 'sess-switch-paid',
      type: 'payment_intent.succeeded',
      intentId: fair.id,
    });
    expect(await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId)).toMatchObject({
      status: 'succeeded',
      provider: 'peable_faircoin',
      providerObjectId: fair.id,
    });
  });

  it('a session that expires unpaid cancels the payment', async () => {
    const { result, sessionId } = await twoSellerCart('sess-expired');
    gateway.session(sessionId).status = 'expired';
    const delivered = await ingestPeableDelivery(
      gateway.sessionDelivery({
        eventId: `evt_sess_expired_${RUN}`,
        type: 'checkout.session.expired',
        sessionId,
        secret: WEBHOOK_SECRET,
      }),
    );
    expect(delivered.outcome).toBe('accepted');
    expect((await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId))?.status).toBe(
      'canceled',
    );
  });
});
