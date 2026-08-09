/**
 * The refund, dispute and payout lifecycle end to end (#49), against a REAL
 * Postgres and a fake Stripe.
 *
 * ## Why none of it can be mocked here
 *
 * Every property this file asserts is a property of the DATABASE. The ledger
 * balances per currency because a repository refuses an unbalanced set and a
 * trigger refuses an edit; a refund executes once because a compare-and-swap on
 * `provider_refund_id` matched one caller; a redelivered dispute books nothing
 * because `opened_booked_at` was already set. A mocked `update` accepts every
 * one of those and returns whatever the test wired — which is exactly the blind
 * spot `AGENTS.md` records for the moderation writes, and the money here is
 * larger.
 *
 * ## What IS mocked, and only that
 *
 * `stripe/client.js`, the single module that talks to Stripe. Everything above
 * it — the adapter, the refund executor, the dispute service, the ledger, the
 * outbox and the webhook ingress — is the real code, and the webhook signatures
 * are real too (`generateTestHeaderStringAsync`, verified by the real SDK).
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL, so
 * nothing here truncates a table another file uses. Every id carries this run's
 * own suffix and every assertion is scoped to rows this test wrote — which is
 * the stronger form anyway, since a count over a whole table passes for the
 * wrong reason the moment a fixture is added elsewhere.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';

const PLATFORM_SECRET = 'whsec_refund_lifecycle_not_a_real_one';
const CONNECT_SECRET = 'whsec_refund_lifecycle_connect';

/** The order's grand total, in EUR cents. Divisible by 4, so quarters are exact. */
const ORDER_TOTAL = 4_000;
/** What Stripe keeps on the charge. Mercaria's cost (ADR 0001 D5). */
const CHARGE_FEE = 116;

/**
 * The fake Stripe API's state. Hoisted so the `vi.mock` factory can close over
 * it — a factory is hoisted above every `const` in this file.
 */
const api = vi.hoisted(() => ({
  intents: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, Record<string, unknown>>(),
  refunds: new Map<string, Record<string, unknown>>(),
  transfers: new Map<string, Record<string, unknown>>(),
  disputes: new Map<string, Record<string, unknown>>(),
  payouts: new Map<string, Record<string, unknown>>(),
  /** Idempotency key → the object that key already produced (Stripe's own rule). */
  byKey: new Map<string, Record<string, unknown>>(),
  refundCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  reversalCalls: [] as {
    transferId: string;
    params: Record<string, unknown>;
    idempotencyKey: string;
  }[],
  /**
   * Reversals the rail should REFUSE, and how.
   *
   * Keyed by transfer id, because the failure this exists to reproduce is
   * per-seller: ADR 0001 D7's insufficient balance stops one order's recovery
   * while its siblings' succeed, and a global switch could not express that.
   */
  reversalFailures: new Map<string, { type: string; message: string; code: string }>(),
  /** Refunds the rail should refuse outright, keyed by charge id. */
  refundFailures: new Map<string, { type: string; message: string; code: string }>(),
  /**
   * Charge id → the rate its refunds convert at.
   *
   * A refund converts at the REFUND-time rate (ADR 0001 D7), so this is the
   * fake's own conversion rather than something read off the charge — the two
   * being the same number here is a simplification, and what matters is that a
   * converted refund reports a PLATFORM amount that is not its presentment one.
   */
  chargeRates: new Map<string, number>(),
  nextId: 0,
}));

vi.mock('../stripe/client.js', () => ({
  STRIPE_API_VERSION: '2026-07-29.dahlia',
  getStripeClient: () => {
    throw new Error('This suite must not construct a real Stripe client.');
  },
  resetStripeClient: () => undefined,
  retrieveStripePaymentIntent: (id: string) => {
    const intent = api.intents.get(id);
    if (!intent) throw new Error(`No fake PaymentIntent registered for ${id}`);
    return Promise.resolve(intent);
  },
  retrieveStripeChargeWithBalance: (id: string) => {
    const charge = api.charges.get(id);
    if (!charge) throw new Error(`No fake charge registered for ${id}`);
    return Promise.resolve(charge);
  },
  retrieveStripeChargeWithRefunds: (id: string) => {
    const charge = api.charges.get(id);
    if (!charge) throw new Error(`No fake charge registered for ${id}`);
    const listed = [...api.refunds.values()].filter((refund) => {
      const owner: unknown = refund.charge;
      return typeof owner === 'object' && owner !== null && (owner as { id?: string }).id === id;
    });
    return Promise.resolve({ ...charge, refunds: { object: 'list', data: listed } });
  },
  createStripeTransfer: (params: Record<string, unknown>, idempotencyKey: string) => {
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);
    api.nextId += 1;
    const transfer = {
      id: `tr_fake_${String(api.nextId)}`,
      object: 'transfer',
      amount_reversed: 0,
      ...params,
    };
    api.transfers.set(String(transfer.id), transfer);
    api.byKey.set(idempotencyKey, transfer);
    return Promise.resolve(transfer);
  },
  retrieveStripeTransfer: (id: string) => {
    const transfer = api.transfers.get(id);
    if (!transfer) throw new Error(`No fake transfer registered for ${id}`);
    return Promise.resolve(transfer);
  },
  createStripeRefund: (params: Record<string, unknown>, idempotencyKey: string) => {
    api.refundCalls.push({ params, idempotencyKey });
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const chargeId = String(params.charge);
    const armed = api.refundFailures.get(chargeId);
    if (armed) {
      throw Object.assign(new Error(armed.message), { type: armed.type, code: armed.code });
    }
    const charge = api.charges.get(chargeId);
    if (!charge) throw new Error(`No fake charge registered for ${chargeId}`);

    const amount = Number(params.amount);
    charge.amount_refunded = Number(charge.amount_refunded ?? 0) + amount;

    api.nextId += 1;
    const refund = {
      id: `re_fake_${String(api.nextId)}`,
      object: 'refund',
      amount,
      currency: charge.currency,
      status: 'succeeded',
      metadata: params.metadata,
      charge,
      balance_transaction: {
        id: `txn_re_${String(api.nextId)}`,
        object: 'balance_transaction',
        // NEGATIVE: funds leaving the platform balance. A fake reporting it
        // positive would hide that the adapter takes the magnitude.
        amount: -Math.round(amount * (api.chargeRates.get(chargeId) ?? 1)),
        currency: 'eur',
        fee: 0,
        exchange_rate: api.chargeRates.get(chargeId) ?? null,
        created: Math.floor(Date.now() / 1000),
      },
    };
    api.refunds.set(refund.id, refund);
    api.byKey.set(idempotencyKey, refund);
    return Promise.resolve(refund);
  },
  retrieveStripeRefund: (id: string) => {
    const refund = api.refunds.get(id);
    if (!refund) throw new Error(`No fake refund registered for ${id}`);
    return Promise.resolve(refund);
  },
  createStripeTransferReversal: (
    transferId: string,
    params: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    api.reversalCalls.push({ transferId, params, idempotencyKey });
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const armed = api.reversalFailures.get(transferId);
    if (armed) {
      throw Object.assign(new Error(armed.message), { type: armed.type, code: armed.code });
    }
    const transfer = api.transfers.get(transferId);
    if (!transfer) throw new Error(`No fake transfer registered for ${transferId}`);
    transfer.amount_reversed = Number(transfer.amount_reversed ?? 0) + Number(params.amount);

    api.nextId += 1;
    const reversal = {
      id: `trr_fake_${String(api.nextId)}`,
      object: 'transfer_reversal',
      amount: params.amount,
      transfer,
    };
    api.byKey.set(idempotencyKey, reversal);
    return Promise.resolve(reversal);
  },
  retrieveStripeDispute: (id: string) => {
    const dispute = api.disputes.get(id);
    if (!dispute) throw new Error(`No fake dispute registered for ${id}`);
    return Promise.resolve(dispute);
  },
  retrieveStripePayout: (id: string) => {
    const payout = api.payouts.get(id);
    if (!payout) throw new Error(`No fake payout registered for ${id}`);
    return Promise.resolve(payout);
  },
  cancelStripePaymentIntent: () => {
    throw new Error('This suite cancels no PaymentIntent.');
  },
  createStripePaymentIntent: () => {
    throw new Error('This suite creates no PaymentIntent.');
  },
  // Present so the mocked module offers every export the real one does — a named
  // import missing from a mock factory fails at LINK time, in whichever file
  // imported the chain rather than in the one that left it out.
  createStripeConnectedAccount: () => {
    throw new Error('This suite creates no connected accounts.');
  },
  retrieveStripeAccount: () => {
    throw new Error('This suite reads no connected accounts.');
  },
  createStripeAccountLink: () => {
    throw new Error('This suite mints no account links.');
  },
}));

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

type Database = import('../../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../../db/postgres.js').closePostgres;
let ingestStripeDelivery: typeof import('../stripe/ingress.js').ingestStripeDelivery;
let applyPaymentStatus: typeof import('../payment.service.js').applyPaymentStatus;
let ensurePayment: typeof import('../payment.service.js').ensurePayment;
let tracePayment: typeof import('../payment.service.js').tracePayment;
let processRefund: typeof import('../../refund.service.js').process;
let insertOrder: typeof import('../../../db/orders/orderRepository.js').insertOrder;
let nextOrderNumber: typeof import('../../../db/orders/orderRepository.js').nextOrderNumber;
let insertStore: typeof import('../../../db/stores/storeRepository.js').insertStore;
let insertLocation: typeof import('../../../db/stores/locationRepository.js').insertLocation;
let insertVariants: typeof import('../../../db/catalog/variantRepository.js').insertVariants;
let setAvailable: typeof import('../../inventory.service.js').setAvailable;
let insertProviderAccount: typeof import('../../../db/payments/providerAccountRepository.js').insertProviderAccount;
let applyProviderAccountState: typeof import('../../../db/payments/providerAccountRepository.js').applyProviderAccountState;
let findRefundById: typeof import('../../../db/orders/refundRepository.js').findRefundById;
let paymentSchema: typeof import('../../../db/schema/payments.js');
let ledgerSchema: typeof import('../../../db/schema/ledger.js');
let orderSchema: typeof import('../../../db/schema/orders.js');
let catalogSchema: typeof import('../../../db/schema/catalog.js');

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result. Set EXPLICITLY and
  // not inherited — vitest reuses a worker PROCESS across files while giving
  // each its own module registry, so a sibling file's write survives into this
  // one's `config`.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.STRIPE_PLATFORM_CURRENCY = 'EUR';
  process.env.STRIPE_PRESENTMENT_CURRENCIES = 'EUR,USD';

  // Dynamic, like everything else here: a STATIC import of any repository pulls
  // `db/postgres.js` and therefore `config/index.ts`, which would freeze its view
  // of process.env before the lines above ran.
  const postgres = await import('../../../db/postgres.js');
  db = await postgres.connectPostgres();
  ({ closePostgres } = postgres);
  ({ ingestStripeDelivery } = await import('../stripe/ingress.js'));
  ({ applyPaymentStatus, ensurePayment, tracePayment } = await import('../payment.service.js'));
  ({ process: processRefund } = await import('../../refund.service.js'));
  ({ insertOrder, nextOrderNumber } = await import('../../../db/orders/orderRepository.js'));
  ({ insertStore } = await import('../../../db/stores/storeRepository.js'));
  ({ insertLocation } = await import('../../../db/stores/locationRepository.js'));
  ({ insertVariants } = await import('../../../db/catalog/variantRepository.js'));
  ({ setAvailable } = await import('../../inventory.service.js'));
  ({ insertProviderAccount, applyProviderAccountState } = await import(
    '../../../db/payments/providerAccountRepository.js'
  ));
  ({ findRefundById } = await import('../../../db/orders/refundRepository.js'));
  paymentSchema = await import('../../../db/schema/payments.js');
  ledgerSchema = await import('../../../db/schema/ledger.js');
  orderSchema = await import('../../../db/schema/orders.js');
  catalogSchema = await import('../../../db/schema/catalog.js');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  // Only the in-memory rail is reset. Nothing in Postgres is deleted — see the
  // file docblock on why a realdb file may not truncate.
  api.intents.clear();
  api.charges.clear();
  api.refunds.clear();
  api.transfers.clear();
  api.disputes.clear();
  api.payouts.clear();
  api.byKey.clear();
  api.refundCalls.length = 0;
  api.reversalCalls.length = 0;
  api.reversalFailures.clear();
  api.refundFailures.clear();
});

/** A EUR `DualMoney` whose two sides are equal — no conversion in play. */
function eur(amount: number) {
  return {
    shop: { amount, currency: 'EUR' as const },
    presentment: { amount, currency: 'EUR' as const },
  };
}

/** Everything one scenario needs, all of it freshly minted. */
interface Fixture {
  storeId: string;
  ownerId: string;
  orderId: string;
  paymentId: string;
  intentId: string;
  chargeId: string;
  accountId: string;
  checkoutGroupId: string;
}

/**
 * A store whose seller is payment ready, its paid order, and the settled
 * transfer that paid it.
 *
 * Driven through the REAL success path — `applyPaymentStatus('succeeded')`
 * books the charge, marks the order paid and settles the seller — rather than
 * by inserting a transfer row directly. That matters: the transfer's amount and
 * the ledger's payable both come from `allocateSellerShares` here, exactly as
 * they do in production, so a refund's proportional recovery is measured
 * against a figure the system computed rather than one this fixture typed in.
 */
async function seedSettledOrder(
  label: string,
  options: {
    orders?: number;
    quantity?: number;
    /**
     * What the charge became on the PLATFORM balance, when it was converted.
     *
     * Absent means presentment IS the settlement currency, which is every
     * same-currency charge. Supplying it makes the seller's share a PRORATION of
     * a converted gross rather than the order's own total — which is the only
     * shape in which a per-refund proration and a cumulative one can disagree.
     */
    platformGross?: number;
    /**
     * A marketplace-fee snapshot (#88) stamped on each order, presentment side.
     * Absent means no snapshot row at all — the pre-#88 zero-fee reality every
     * older test in this file was written against, unchanged.
     */
    feeMinorPerOrder?: number;
    /**
     * Stamp each order `mercaria_retail` / `not_applicable` instead — the mode
     * the marketplace fee structurally excludes.
     */
    retailNotApplicable?: boolean;
  } = {},
): Promise<Fixture[]> {
  const suffix = `${label}-${RUN}-${uuidv7()}`;
  const ownerId = `owner-${suffix}`;
  const accountId = `acct_${suffix.replace(/-/g, '').slice(0, 20)}`;
  const store = await insertStore(
    {
      handle: `refund-${suffix}`,
      name: 'Refund lifecycle store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'EUR',
    },
    [{ oxyUserId: ownerId, role: 'owner', permissions: ['store:manage'] }],
  );

  // A store's inventory is multi-location, so committing stock on `paid` and
  // restocking on a refund both resolve a location. Without one the ORDER
  // transition throws before settlement ever runs — which would make every
  // assertion below measure a payment that was never settled rather than the
  // refund path it is about.
  const location = await insertLocation(store.id, {
    name: 'Warehouse',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
    address: {
      recipientName: 'Refund lifecycle store',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
  });

  // A payment-ready connected account, so settlement transfers rather than
  // withholding. Readiness is ONE stored verdict (#46) and is set through the
  // repository that computes it, never by writing a boolean.
  const account = await insertProviderAccount(db, {
    provider: 'stripe',
    ownerType: 'store',
    ownerId: store.id,
    providerAccountId: accountId,
    country: 'ES',
  });
  await applyProviderAccountState(db, {
    id: account.id,
    state: {
      onboardingState: 'ready',
      chargesEnabled: true,
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

  const checkoutGroupId = `group-${suffix}`;
  const intentId = `pi_${suffix.replace(/-/g, '')}`;
  const chargeId = `ch_${suffix.replace(/-/g, '')}`;
  const orderCount = options.orders ?? 1;
  // Units per order. `ORDER_TOTAL` is the order's GRAND TOTAL either way, so a
  // two-unit order prices each line at half — which is what makes a two-step
  // partial refund reverse two halves that must sum to the whole transfer.
  const quantity = options.quantity ?? 1;
  const unitPrice = ORDER_TOTAL / quantity;

  const orderIds: string[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    const [listing] = await db
      .insert(catalogSchema.listings)
      .values({
        ownerType: 'store',
        storeId: store.id,
        title: `Refundable ${String(index)}`,
        description: '',
        condition: 'new',
      })
      .returning({ id: catalogSchema.listings.id });
    const [variant] = await insertVariants(listing.id, [
      {
        title: 'Default',
        priceAmount: unitPrice,
        priceCurrency: 'EUR',
        inventoryTracked: true,
        inventoryAvailable: 10,
        position: 0,
        optionValues: [],
      },
    ]);

    // A STORE variant's `inventory_available` is DERIVED — recomputed as the sum
    // over its `inventory_levels` rows — so the scalar `insertVariants` wrote is
    // overwritten the first time anything recomputes it. Seeding the level is
    // what makes the restock assertion measure a real number rather than a
    // fixture's initial value that the paid transition had already zeroed.
    await setAvailable(variant.id, listing.id, location.id, 10);

    const order = await insertOrder({
      orderNumber: await nextOrderNumber(),
      buyerOrigin: 'oxy',
      buyerOxyUserId: `buyer-${suffix}`,
      sellerType: 'store',
      storeId: store.id,
      items: [
        {
          listingId: listing.id,
          variantId: variant.id,
          title: `Refundable ${String(index)}`,
          variantTitle: 'Default',
          optionValues: [],
          unitPrice: eur(unitPrice),
          quantity,
          lineTotal: eur(ORDER_TOTAL),
        },
      ],
      shippingAddress: {
        recipientName: 'Buyer',
        line1: '1 Street',
        city: 'Barcelona',
        postalCode: '08001',
        country: 'ES',
      },
      shippingMethod: 'standard',
      shippingLabel: 'Standard',
      shippingCost: eur(0),
      totals: {
        subtotal: eur(ORDER_TOTAL),
        discountTotal: eur(0),
        shipping: eur(0),
        tax: eur(0),
        grandTotal: eur(ORDER_TOTAL),
      },
      status: 'pending_payment',
      paymentStatus: 'unpaid',
      checkoutGroupId,
      statusHistory: [{ status: 'pending_payment', at: new Date(), actorKind: 'system' }],
      appliedDiscounts: [],
      taxLines: [],
      ...(options.retailNotApplicable
        ? {
            feeSnapshot: {
              commercialMode: 'mercaria_retail' as const,
              result: 'not_applicable' as const,
            },
          }
        : {}),
      ...(options.feeMinorPerOrder !== undefined && !options.retailNotApplicable
        ? {
            feeSnapshot: {
              commercialMode: 'connected_marketplace' as const,
              result: 'calculated' as const,
              scheduleKey: 'realdb-fee',
              scheduleVersion: 1,
              basis: 'discounted_item_subtotal' as const,
              basisAmount: { amount: ORDER_TOTAL, currency: 'EUR' as const },
              percentageBps: Math.round((options.feeMinorPerOrder * 10_000) / ORDER_TOTAL),
              fee: { amount: options.feeMinorPerOrder, currency: 'EUR' as const },
              roundingAdjustmentMinor: 0,
              scopeSellerType: 'store' as const,
              scopeCurrency: 'EUR' as const,
              lineAllocationsMinor: [options.feeMinorPerOrder],
            },
          }
        : {}),
    });
    orderIds.push(order.id);
  }

  const gross = ORDER_TOTAL * orderCount;
  const platformGross = options.platformGross ?? gross;
  const exchangeRate = platformGross === gross ? null : platformGross / gross;
  api.intents.set(intentId, {
    id: intentId,
    object: 'payment_intent',
    status: 'succeeded',
    amount: gross,
    currency: 'eur',
    latest_charge: chargeId,
    metadata: {},
  });
  api.charges.set(chargeId, {
    id: chargeId,
    object: 'charge',
    amount: gross,
    currency: 'eur',
    amount_refunded: 0,
    balance_transaction: {
      id: `txn_${chargeId}`,
      object: 'balance_transaction',
      amount: platformGross,
      currency: 'eur',
      fee: CHARGE_FEE,
      exchange_rate: exchangeRate,
      created: Math.floor(Date.now() / 1000),
    },
  });

  const payment = await ensurePayment({
    provider: 'stripe',
    checkoutGroupId,
    presentment: { amount: gross, currency: 'EUR' },
    buyerOxyUserId: `buyer-${suffix}`,
    providerObjectId: intentId,
  });
  api.chargeRates.set(chargeId, exchangeRate ?? 1);

  // The real success path: books `charge_succeeded`, drains the outbox inline,
  // marks every order paid and settles each seller.
  await applyPaymentStatus({
    paymentId: payment.id,
    next: 'succeeded',
    providerObjectId: intentId,
    platform: {
      amount: { amount: platformGross, currency: 'EUR' },
      rate: {
        from: 'EUR',
        to: 'EUR',
        rate: exchangeRate ?? 1,
        provider: 'stripe',
        asOf: new Date().toISOString(),
      },
    },
    feeMinor: BigInt(CHARGE_FEE),
  });

  return orderIds.map((orderId) => ({
    storeId: store.id,
    ownerId,
    orderId,
    paymentId: payment.id,
    intentId,
    chargeId,
    accountId,
    checkoutGroupId,
  }));
}

/** Every ledger entry this payment produced, flattened for assertion. */
async function ledgerFor(
  paymentId: string,
): Promise<{ kind: string; account: string; currency: string; amount: bigint; orderId: string | null }[]> {
  const rows = await db
    .select({
      kind: ledgerSchema.ledgerTransactions.kind,
      account: ledgerSchema.ledgerEntries.account,
      currency: ledgerSchema.ledgerEntries.currency,
      amount: ledgerSchema.ledgerEntries.amountMinor,
      orderId: ledgerSchema.ledgerEntries.orderId,
    })
    .from(ledgerSchema.ledgerEntries)
    .innerJoin(
      ledgerSchema.ledgerTransactions,
      eq(ledgerSchema.ledgerTransactions.id, ledgerSchema.ledgerEntries.transactionId),
    )
    .where(eq(ledgerSchema.ledgerTransactions.paymentId, paymentId));
  return rows;
}

/**
 * The per-currency sums of everything booked for one payment.
 *
 * The invariant #45 exists to hold: every transaction sums to zero per currency,
 * so the WHOLE book for a payment does too. Asserted after each scenario rather
 * than only inside one, because the failure mode that matters is two individually
 * balanced transactions describing the same money twice.
 */
async function ledgerBalance(paymentId: string): Promise<Record<string, bigint>> {
  const totals: Record<string, bigint> = {};
  for (const entry of await ledgerFor(paymentId)) {
    totals[entry.currency] = (totals[entry.currency] ?? 0n) + entry.amount;
  }
  return totals;
}

/** What one account holds for one payment, in one currency. */
async function accountTotal(
  paymentId: string,
  account: string,
  orderId?: string,
): Promise<bigint> {
  const entries = await ledgerFor(paymentId);
  return entries
    .filter(
      (entry) =>
        entry.account === account && (orderId === undefined || entry.orderId === orderId),
    )
    .reduce((sum, entry) => sum + entry.amount, 0n);
}

/** The outbox event types this payment produced. */
async function outboxTypesFor(paymentId: string): Promise<string[]> {
  const rows = await db
    .select({ eventType: paymentSchema.paymentOutboxes.eventType })
    .from(paymentSchema.paymentOutboxes)
    .where(sql`${paymentSchema.paymentOutboxes.payload}->>'paymentId' = ${paymentId}`);
  return rows.map((row) => row.eventType).sort();
}

/** The transfer that settled one seller order. */
async function transferFor(paymentId: string, orderId: string) {
  const [row] = await db
    .select()
    .from(paymentSchema.transfers)
    .where(
      and(eq(paymentSchema.transfers.paymentId, paymentId), eq(paymentSchema.transfers.orderId, orderId)),
    );
  return row;
}

/** The inventory available for the variants of one order. */
async function availableFor(orderId: string): Promise<number> {
  const items = await db
    .select({ variantId: orderSchema.orderItems.variantId })
    .from(orderSchema.orderItems)
    .where(eq(orderSchema.orderItems.orderId, orderId));
  const variants = await db
    .select({ available: catalogSchema.productVariants.inventoryAvailable })
    .from(catalogSchema.productVariants)
    .where(
      inArray(
        catalogSchema.productVariants.id,
        items.map((item) => item.variantId),
      ),
    );
  return variants.reduce((sum, variant) => sum + variant.available, 0);
}

/** Sign and deliver one event to the platform endpoint. */
async function deliver(event: Record<string, unknown>, secret: string = PLATFORM_SECRET) {
  const payload = JSON.stringify({
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...event,
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return await ingestStripeDelivery({
    payload: Buffer.from(payload, 'utf8'),
    signature,
    scope: secret === CONNECT_SECRET ? 'connect' : 'platform',
  });
}

describe('a merchant refund on a settled Stripe order', () => {
  it('refunds the buyer, reverses the whole seller share and balances the ledger', async () => {
    const [fixture] = await seedSettledOrder('full');
    const transferBefore = await transferFor(fixture.paymentId, fixture.orderId);
    expect(transferBefore?.amountAmount).toBe(ORDER_TOTAL);
    const availableBefore = await availableFor(fixture.orderId);

    const refund = await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true }] },
      fixture.ownerId,
    );

    // The rail was asked for exactly the buyer's side, under the ADR's key.
    expect(api.refundCalls).toHaveLength(1);
    expect(api.refundCalls[0]?.idempotencyKey).toBe(`re:${refund.id}`);
    expect(api.refundCalls[0]?.params.amount).toBe(ORDER_TOTAL);
    expect(api.refundCalls[0]?.params.charge).toBe(fixture.chargeId);
    // Mercaria's own id travels in the metadata — the correlation that stops a
    // legitimate refund being reported as one made outside Mercaria.
    expect(api.refundCalls[0]?.params.metadata).toMatchObject({ refundId: refund.id });

    // …and the SELLER's side, in the PLATFORM currency, under its own key.
    expect(api.reversalCalls).toHaveLength(1);
    expect(api.reversalCalls[0]?.idempotencyKey).toBe(`trr:${refund.id}:${fixture.orderId}`);
    expect(api.reversalCalls[0]?.params.amount).toBe(ORDER_TOTAL);

    // The refund's own provider state, which is what a merchant screen reads.
    const stored = await findRefundById(refund.id);
    expect(stored?.provider).toBe('stripe');
    expect(stored?.providerState).toBe('succeeded');
    expect(stored?.reversalState).toBe('succeeded');
    expect(stored?.reversalAmountAmount).toBe(ORDER_TOTAL);
    expect(stored?.reversalAmountCurrency).toBe('EUR');
    expect(refund.providerState).toBe('succeeded');
    // The operator-only half never reaches the DTO a merchant surface returns.
    expect(refund).not.toHaveProperty('providerRefundId');
    expect(refund).not.toHaveProperty('reversalState');

    // The ledger balances per currency across EVERY transaction this payment
    // produced — the charge, the transfer, the refund and the reversal.
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });

    // …and the seller's payable for this order is back to zero: credited by the
    // charge, settled by the transfer, charged by the refund, recovered by the
    // reversal. That closure is what a FAILED reversal would leave open.
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);

    // Commission is zero until #88, so nothing was returned from it. Asserted
    // rather than assumed: a non-zero value here is the rounding leak
    // `settlement-shares.ts` exists to prevent.
    expect(await accountTotal(fixture.paymentId, 'commission_revenue')).toBe(0n);

    // Restock happened exactly ONCE, in the commerce path.
    expect(await availableFor(fixture.orderId)).toBe(availableBefore + 1);

    // A full refund of the whole order, so the order is `refunded`.
    const [order] = await db
      .select({ status: orderSchema.orders.status, paymentStatus: orderSchema.orders.paymentStatus })
      .from(orderSchema.orders)
      .where(eq(orderSchema.orders.id, fixture.orderId));
    expect(order?.status).toBe('refunded');
    expect(order?.paymentStatus).toBe('refunded');
  });

  /**
   * Two partial refunds on a CONVERTED charge, which is the only shape in which
   * the recovery arithmetic's cumulative form and a per-refund one disagree.
   *
   * The seller's share is an ODD 3,667 (a 4,000 charge converted at 0.916_75),
   * refunded in two halves. Cumulative gives 1,833 then 1,834 — each step
   * reverses the DIFFERENCE between where the transfer should stand and where it
   * does — and the two sum to exactly 3,667. Prorating each refund independently
   * would floor 1,833 twice and strand ONE unit on the seller's balance forever.
   *
   * An evenly-divisible fixture cannot tell those apart: it returns the same
   * number either way, which is precisely the false green a suite whose every
   * fixture sits on one side of a distinction produces. Mutation-checked by
   * replacing the cumulative difference with an independent proration, which
   * turns this red and leaves the same-currency cases green.
   */
  it('reverses two partial refunds of a CONVERTED charge with no unit stranded', async () => {
    const platformGross = 3_667;
    const [fixture] = await seedSettledOrder('two-step', { quantity: 2, platformGross });
    const variantId = await firstVariant(fixture.orderId);

    const first = await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId, quantity: 1, restock: false }] },
      fixture.ownerId,
    );
    expect((await findRefundById(first.id))?.reversalAmountAmount).toBe(1_833);
    let transfer = await transferFor(fixture.paymentId, fixture.orderId);
    expect(transfer?.amountAmount).toBe(platformGross);
    expect(transfer?.reversedAmount).toBe(1_833);
    // Half back is not fully reversed — the state Stripe's own boolean cannot
    // represent, and why `transfers` stores an AMOUNT beside the status.
    expect(transfer?.status).toBe('paid');

    const second = await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId, quantity: 1, restock: false }] },
      fixture.ownerId,
    );
    // The ODD unit lands on the second increment, which is what an independent
    // proration would have lost.
    expect((await findRefundById(second.id))?.reversalAmountAmount).toBe(1_834);

    transfer = await transferFor(fixture.paymentId, fixture.orderId);
    // The whole transfer came back, and never more than the whole of it.
    expect(transfer?.reversedAmount).toBe(platformGross);
    expect(transfer?.status).toBe('reversed');
    expect(api.reversalCalls).toHaveLength(2);
    expect(
      api.reversalCalls.reduce((sum, call) => sum + Number(call.params.amount), 0),
    ).toBe(platformGross);

    // The seller's payable nets to zero: credited by the charge, settled by the
    // transfer, charged by two refunds and recovered by two reversals.
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });

  it('never touches inventory from a provider outcome, however many arrive', async () => {
    const [fixture] = await seedSettledOrder('no-restock');
    const variantId = await firstVariant(fixture.orderId);
    const refund = await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId, quantity: 1, restock: true }] },
      fixture.ownerId,
    );
    const afterCommerce = await availableFor(fixture.orderId);

    const stored = await findRefundById(refund.id);
    const providerRefundId = stored?.providerRefundId ?? '';
    expect(providerRefundId).not.toBe('');

    // Two deliveries of the refund's own event, and a `charge.refunded` on top.
    // Issue #49 invariant 2: a provider outcome moves money and NOTHING else.
    for (const eventId of ['a', 'b']) {
      await deliver({
        id: `evt_refund_${eventId}_${RUN}_${refund.id}`,
        type: 'charge.refund.updated',
        data: { object: { id: providerRefundId, object: 'refund', charge: fixture.chargeId } },
      });
    }
    await deliver({
      id: `evt_charge_refunded_${RUN}_${refund.id}`,
      type: 'charge.refunded',
      data: { object: { id: fixture.chargeId, object: 'charge', payment_intent: fixture.intentId } },
    });

    expect(await availableFor(fixture.orderId)).toBe(afterCommerce);
    // …and the money did not move again either.
    expect(api.refundCalls).toHaveLength(1);
    expect(api.reversalCalls).toHaveLength(1);
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });
});

describe('a reversal the rail refuses', () => {
  /**
   * ADR 0001 D7's explicit outcome, and the one place this system deliberately
   * ends up out of pocket: the buyer's refund is NOT blocked on the seller-side
   * recovery.
   */
  it('still refunds the buyer, books the gap and raises one operator exception', async () => {
    const [fixture] = await seedSettledOrder('reversal-fail');
    const transfer = await transferFor(fixture.paymentId, fixture.orderId);
    api.reversalFailures.set(String(transfer?.providerObjectId), {
      type: 'StripeInvalidRequestError',
      message: 'Insufficient funds in the connected account to complete this reversal.',
      code: 'balance_insufficient',
    });

    const refund = await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true }] },
      fixture.ownerId,
    );

    const stored = await findRefundById(refund.id);
    // The buyer has their money…
    expect(stored?.providerState).toBe('succeeded');
    // …and the recovery did not happen.
    expect(stored?.reversalState).toBe('failed');
    expect(stored?.providerReversalId).toBeNull();

    // The gap is BOOKED, not hidden: the order's payable sits in DEBIT by
    // exactly what the seller still owes Mercaria. A positive amount is a debit
    // under the sign convention.
    const payable = await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId);
    expect(payable).toBe(BigInt(ORDER_TOTAL));

    // The book still balances per currency — an honest gap, not an unbalanced one.
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });

    // Exactly one operator exception, and it is the reversal's.
    const types = await outboxTypesFor(fixture.paymentId);
    expect(types).toContain('reversal_failed');
    expect(types).not.toContain('refund_failed');
    const raised = await db
      .select()
      .from(paymentSchema.paymentOutboxes)
      .where(eq(paymentSchema.paymentOutboxes.id, `payment:reversal_failed:${refund.id}:${fixture.orderId}`));
    expect(raised).toHaveLength(1);
  });

  it('leaves a sibling seller of the same charge completely untouched', async () => {
    const [first, second] = await seedSettledOrder('siblings', { orders: 2 });
    const transfer = await transferFor(first.paymentId, first.orderId);
    api.reversalFailures.set(String(transfer?.providerObjectId), {
      type: 'StripeInvalidRequestError',
      message: 'Insufficient funds in the connected account to complete this reversal.',
      code: 'balance_insufficient',
    });

    const siblingPayableBefore = await accountTotal(
      second.paymentId,
      'merchant_payable',
      second.orderId,
    );
    const siblingTransferBefore = await transferFor(second.paymentId, second.orderId);

    await processRefund(
      first.storeId,
      first.orderId,
      { lineItems: [{ variantId: await firstVariant(first.orderId), quantity: 1, restock: true }] },
      first.ownerId,
    );

    // ADR 0001 D4: divergence after funding is per ORDER. The sibling's payable
    // and its transfer are byte-for-byte where they were.
    expect(await accountTotal(second.paymentId, 'merchant_payable', second.orderId)).toBe(
      siblingPayableBefore,
    );
    const siblingTransferAfter = await transferFor(second.paymentId, second.orderId);
    expect(siblingTransferAfter?.reversedAmount).toBe(siblingTransferBefore?.reversedAmount);
    expect(siblingTransferAfter?.status).toBe(siblingTransferBefore?.status);
    expect(await ledgerBalance(first.paymentId)).toEqual({ EUR: 0n });
  });
});

describe('a refund the rail refuses outright', () => {
  /**
   * Issue #49 scope 10, the "local success, provider failure" half: the commerce
   * record has committed and restocked, and the money did not go.
   */
  it('records the refund, raises refund_failed and books NOTHING', async () => {
    const [fixture] = await seedSettledOrder('refund-fail');
    api.refundFailures.set(fixture.chargeId, {
      type: 'StripeInvalidRequestError',
      message: 'Charge ch_x has already been refunded.',
      code: 'charge_already_refunded',
    });
    const ledgerBefore = (await ledgerFor(fixture.paymentId)).length;

    const refund = await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true }] },
      fixture.ownerId,
    );

    const stored = await findRefundById(refund.id);
    expect(stored?.providerState).toBe('failed');
    expect(stored?.providerRefundId).toBeNull();
    // No money left the platform balance, so no leg describes any leaving.
    expect((await ledgerFor(fixture.paymentId)).length).toBe(ledgerBefore);
    expect(await outboxTypesFor(fixture.paymentId)).toContain('refund_failed');
    // …and no reversal was even attempted: there is nothing to recover.
    expect(api.reversalCalls).toHaveLength(0);
  });
});

describe('a refund made OUTSIDE Mercaria', () => {
  /**
   * A refund somebody made in the Stripe dashboard, or one an issuer forced.
   * Turning it into a local refund would restock goods nobody returned and
   * decrement a customer's lifetime spend for a decision Mercaria never took.
   */
  it('becomes an operator exception with no local refund and no restock', async () => {
    const [fixture] = await seedSettledOrder('outside');
    const availableBefore = await availableFor(fixture.orderId);

    // A refund object the rail knows about and Mercaria does not: no metadata,
    // no row.
    const foreignId = `re_outside_${RUN}`;
    api.refunds.set(foreignId, {
      id: foreignId,
      object: 'refund',
      amount: ORDER_TOTAL,
      currency: 'eur',
      status: 'succeeded',
      metadata: {},
      charge: api.charges.get(fixture.chargeId),
    });

    await deliver({
      id: `evt_outside_${RUN}`,
      type: 'charge.refund.updated',
      data: { object: { id: foreignId, object: 'refund', charge: fixture.chargeId } },
    });

    // No local refund exists for it…
    const localRefunds = await db
      .select()
      .from(orderSchema.refunds)
      .where(eq(orderSchema.refunds.orderId, fixture.orderId));
    expect(localRefunds).toHaveLength(0);

    // …no stock came back…
    expect(await availableFor(fixture.orderId)).toBe(availableBefore);

    // …and the exception is keyed on the RAIL's id, which is the only durable
    // one this condition has.
    const raised = await db
      .select()
      .from(paymentSchema.paymentOutboxes)
      .where(eq(paymentSchema.paymentOutboxes.id, `payment:refund_unmatched:stripe:${foreignId}`));
    expect(raised).toHaveLength(1);
    expect(raised[0]?.eventType).toBe('refund_unmatched');
  });
});

describe('the dispute lifecycle, through the real ingress', () => {
  it('created → lost books the debit, charges the seller and recovers it', async () => {
    const [fixture] = await seedSettledOrder('dispute-lost');
    const disputeId = `dp_lost_${RUN}`;
    const fee = 1_500;
    registerDispute(disputeId, fixture.chargeId, fixture.intentId, {
      status: 'needs_response',
      amount: ORDER_TOTAL,
      fee,
    });

    await deliver({
      id: `evt_dp_created_${RUN}`,
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, object: 'dispute', charge: fixture.chargeId } },
    });

    // The platform balance was debited for the amount AND the fee; the principal
    // sits in the holding account until the outcome is known.
    expect(await accountTotal(fixture.paymentId, 'disputes')).toBe(BigInt(ORDER_TOTAL));
    expect(await accountTotal(fixture.paymentId, 'processor_expense')).toBe(
      BigInt(CHARGE_FEE + fee),
    );

    // A redelivery of the SAME creation books nothing a second time.
    await deliver({
      id: `evt_dp_created_again_${RUN}`,
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, object: 'dispute', charge: fixture.chargeId } },
    });
    expect(await accountTotal(fixture.paymentId, 'disputes')).toBe(BigInt(ORDER_TOTAL));

    registerDispute(disputeId, fixture.chargeId, fixture.intentId, {
      status: 'lost',
      amount: ORDER_TOTAL,
      fee,
    });
    await deliver({
      id: `evt_dp_lost_${RUN}`,
      type: 'charge.dispute.closed',
      data: { object: { id: disputeId, object: 'dispute', charge: fixture.chargeId } },
    });

    // The holding account is closed out…
    expect(await accountTotal(fixture.paymentId, 'disputes')).toBe(0n);
    // …the seller bore it and the recovery reversed their transfer, so their
    // payable is back to zero and the cash is back on the platform balance.
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
    expect(api.reversalCalls).toHaveLength(1);
    expect(api.reversalCalls[0]?.idempotencyKey).toContain('trr:dispute:');
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });

    const [row] = await db
      .select()
      .from(paymentSchema.disputes)
      .where(eq(paymentSchema.disputes.providerDisputeId, disputeId));
    expect(row?.outcome).toBe('lost');
    expect(row?.recoveryState).toBe('succeeded');
    expect(row?.orderId).toBe(fixture.orderId);
  });

  it('created → won reverses the holding entry and never touches the seller', async () => {
    const [fixture] = await seedSettledOrder('dispute-won');
    const disputeId = `dp_won_${RUN}`;
    const fee = 1_500;
    registerDispute(disputeId, fixture.chargeId, fixture.intentId, {
      status: 'needs_response',
      amount: ORDER_TOTAL,
      fee,
    });
    await deliver({
      id: `evt_dp_open_${RUN}`,
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, object: 'dispute', charge: fixture.chargeId } },
    });

    const payableBefore = await accountTotal(
      fixture.paymentId,
      'merchant_payable',
      fixture.orderId,
    );

    registerDispute(disputeId, fixture.chargeId, fixture.intentId, {
      status: 'won',
      amount: ORDER_TOTAL,
      fee,
    });
    await deliver({
      id: `evt_dp_won_${RUN}`,
      type: 'charge.dispute.closed',
      data: { object: { id: disputeId, object: 'dispute', charge: fixture.chargeId } },
    });

    // The principal came back and the holding account closed…
    expect(await accountTotal(fixture.paymentId, 'disputes')).toBe(0n);
    // …the seller was never charged and no reversal was attempted…
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(
      payableBefore,
    );
    expect(api.reversalCalls).toHaveLength(0);
    // …and the FEE is NOT returned: a lost fee on a won dispute is a real cost
    // Mercaria bore (ADR 0001 D5), and booking it back would overstate revenue
    // by the amount of every dispute ever raised.
    expect(await accountTotal(fixture.paymentId, 'processor_expense')).toBe(
      BigInt(CHARGE_FEE + fee),
    );
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });

  it('books nothing for an INQUIRY, which moves no money', async () => {
    const [fixture] = await seedSettledOrder('dispute-warning');
    const disputeId = `dp_warn_${RUN}`;
    // No balance movements at all — the shape of an inquiry, and what
    // distinguishes it from a chargeback rather than the status string.
    api.disputes.set(disputeId, {
      id: disputeId,
      object: 'dispute',
      charge: fixture.chargeId,
      payment_intent: fixture.intentId,
      amount: ORDER_TOTAL,
      currency: 'eur',
      status: 'warning_needs_response',
      reason: 'fraudulent',
      balance_transactions: [],
      evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86_400 },
    });

    const before = (await ledgerFor(fixture.paymentId)).length;
    await deliver({
      id: `evt_dp_warn_${RUN}`,
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, object: 'dispute', charge: fixture.chargeId } },
    });

    expect((await ledgerFor(fixture.paymentId)).length).toBe(before);
    const [row] = await db
      .select()
      .from(paymentSchema.disputes)
      .where(eq(paymentSchema.disputes.providerDisputeId, disputeId));
    expect(row?.status).toBe('warning');
    expect(row?.openedBookedAt).toBeNull();
    expect(row?.amountAmount).toBe(0);
  });

  it('does not touch a sibling order of the same charge', async () => {
    const [first, second] = await seedSettledOrder('dispute-siblings', { orders: 2 });
    const disputeId = `dp_multi_${RUN}`;
    registerDispute(disputeId, first.chargeId, first.intentId, {
      status: 'lost',
      amount: ORDER_TOTAL,
      fee: 1_500,
    });

    const siblingPayableBefore = await accountTotal(
      second.paymentId,
      'merchant_payable',
      second.orderId,
    );
    await deliver({
      id: `evt_dp_multi_${RUN}`,
      type: 'charge.dispute.closed',
      data: { object: { id: disputeId, object: 'dispute', charge: first.chargeId } },
    });

    // A multi-seller charge gives the network no line detail, so the dispute is
    // recorded UNATTRIBUTED and the principal stays in the holding account.
    // Guessing an order would reverse an innocent seller's transfer.
    const [row] = await db
      .select()
      .from(paymentSchema.disputes)
      .where(eq(paymentSchema.disputes.providerDisputeId, disputeId));
    expect(row?.orderId).toBeNull();
    expect(api.reversalCalls).toHaveLength(0);
    expect(await accountTotal(second.paymentId, 'merchant_payable', second.orderId)).toBe(
      siblingPayableBefore,
    );
  });
});

describe('payout attribution', () => {
  it('resolves a payout to its seller and announces it; a failure is visible', async () => {
    const [fixture] = await seedSettledOrder('payout');
    const paidId = `po_paid_${RUN}`;
    const failedId = `po_failed_${RUN}`;
    api.payouts.set(paidId, {
      id: paidId,
      object: 'payout',
      amount: 3_884,
      currency: 'eur',
      status: 'paid',
      arrival_date: Math.floor(Date.now() / 1000),
    });
    api.payouts.set(failedId, {
      id: failedId,
      object: 'payout',
      amount: 3_884,
      currency: 'eur',
      status: 'failed',
      failure_code: 'account_closed',
    });

    await deliver(
      {
        id: `evt_po_paid_${RUN}`,
        type: 'payout.paid',
        account: fixture.accountId,
        data: { object: { id: paidId, object: 'payout' } },
      },
      CONNECT_SECRET,
    );
    await deliver(
      {
        id: `evt_po_failed_${RUN}`,
        type: 'payout.failed',
        account: fixture.accountId,
        data: { object: { id: failedId, object: 'payout' } },
      },
      CONNECT_SECRET,
    );

    const rows = await db
      .select()
      .from(paymentSchema.payouts)
      .where(eq(paymentSchema.payouts.providerAccountRef, fixture.accountId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.providerObjectId === failedId)?.failureCode).toBe(
      'account_closed',
    );

    // Attributed to the SELLER, which is the whole reason a payout row is worth
    // writing — #46's account mapping is what makes it possible.
    const announced = await db
      .select()
      .from(paymentSchema.paymentOutboxes)
      .where(
        sql`${paymentSchema.paymentOutboxes.payload}->>'sellerKey' = ${`store:${fixture.storeId}`}`,
      );
    expect(announced.map((row) => row.eventType)).toContain('payout_changed');

    // A payout books NOTHING: the receivable was settled at transfer time (ADR
    // 0001 D6), so a failed payout must not reopen it.
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);

    // …and the trace now reaches them, which was #45's stated deferral.
    const trace = await tracePayment({ byPaymentId: fixture.paymentId });
    expect(trace?.payouts.map((row) => row.providerObjectId).sort()).toEqual(
      [failedId, paidId].sort(),
    );
  });
});

describe('a restated Stripe fee', () => {
  /**
   * Stripe restates a fee occasionally and says so with `charge.updated`. #45 has
   * exactly one mechanism for a mistake in the book — a NEW balanced transaction
   * — and the `charge_succeeded` one is never touched (a trigger would refuse it
   * anyway).
   */
  it('books ONE correcting transaction, and converges on a redelivery', async () => {
    const [fixture] = await seedSettledOrder('fee-correction');
    expect(await accountTotal(fixture.paymentId, 'processor_expense')).toBe(BigInt(CHARGE_FEE));

    const restated = CHARGE_FEE + 40;
    const charge = api.charges.get(fixture.chargeId);
    const balance = charge?.balance_transaction as { fee: number };
    balance.fee = restated;

    await deliver({
      id: `evt_charge_updated_${RUN}`,
      type: 'charge.updated',
      data: { object: { id: fixture.chargeId, object: 'charge', payment_intent: fixture.intentId } },
    });

    expect(await accountTotal(fixture.paymentId, 'processor_expense')).toBe(BigInt(restated));
    const adjustments = (await ledgerFor(fixture.paymentId)).filter(
      (entry) => entry.kind === 'adjustment',
    );
    expect(adjustments).toHaveLength(2);
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });

    // A second delivery measures the delta against everything already booked —
    // including the correction — so it computes zero and writes nothing.
    await deliver({
      id: `evt_charge_updated_again_${RUN}`,
      type: 'charge.updated',
      data: { object: { id: fixture.chargeId, object: 'charge', payment_intent: fixture.intentId } },
    });
    expect(await accountTotal(fixture.paymentId, 'processor_expense')).toBe(BigInt(restated));
    expect(
      (await ledgerFor(fixture.paymentId)).filter((entry) => entry.kind === 'adjustment'),
    ).toHaveLength(2);
  });
});

/** The first variant on an order — what a refund line names. */
async function firstVariant(orderId: string): Promise<string> {
  const [item] = await db
    .select({ variantId: orderSchema.orderItems.variantId })
    .from(orderSchema.orderItems)
    .where(eq(orderSchema.orderItems.orderId, orderId));
  return item.variantId;
}

/** Register (or restate) a fake dispute with a real balance movement. */
function registerDispute(
  disputeId: string,
  chargeId: string,
  intentId: string,
  state: { status: string; amount: number; fee: number },
): void {
  api.disputes.set(disputeId, {
    id: disputeId,
    object: 'dispute',
    charge: chargeId,
    payment_intent: intentId,
    amount: state.amount,
    currency: 'eur',
    status: state.status,
    reason: 'fraudulent',
    // A withdrawal is reported NEGATIVE, with the dispute fee beside it. The
    // amount and the fee are read from here and never from `dispute.amount`,
    // which is populated for an inquiry too.
    balance_transactions: [
      {
        id: `txn_${disputeId}`,
        object: 'balance_transaction',
        amount: -(state.amount + state.fee),
        fee: state.fee,
        currency: 'eur',
      },
    ],
    evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86_400 },
  });
}

describe('the marketplace fee (#88) on the settled money path', () => {
  /** The fee each of these scenarios stamps: 10% of `ORDER_TOTAL`. */
  const FEE = 400;

  it('books the commission as the residual and transfers the seller their NET', async () => {
    const [fixture] = await seedSettledOrder('fee-charge', { feeMinorPerOrder: FEE });

    // The transfer is the net — gross share minus the snapshot fee — and the
    // ledger's payable is the SAME figure, because both read
    // `deriveSellerNetShares`. One definition, two readers.
    const transfer = await transferFor(fixture.paymentId, fixture.orderId);
    expect(transfer?.amountAmount).toBe(ORDER_TOTAL - FEE);

    // Commission revenue holds exactly the snapshot fee, as a CREDIT — ADR 0001
    // D3's residual, now non-zero for the first time.
    expect(await accountTotal(fixture.paymentId, 'commission_revenue')).toBe(-BigInt(FEE));

    // …and it is DISTINCT from the provider's processing cost, which stays an
    // expense on its own account (#88 calculation rule 11): the charge fee did
    // not shrink the commission and the commission did not absorb the charge fee.
    expect(await accountTotal(fixture.paymentId, 'processor_expense')).toBe(BigInt(CHARGE_FEE));

    // The payable was credited net and settled net, so it closes to zero.
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });

  it('returns the whole commission on a full refund, per the proportional policy', async () => {
    const [fixture] = await seedSettledOrder('fee-full-refund', { feeMinorPerOrder: FEE });

    await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true }] },
      fixture.ownerId,
    );

    // The buyer got the WHOLE order back; the seller bore only their net.
    expect(api.refundCalls[0]?.params.amount).toBe(ORDER_TOTAL);
    expect(api.reversalCalls[0]?.params.amount).toBe(ORDER_TOTAL - FEE);

    // The commission came back through the residual: credited at the charge,
    // debited by the refund, net zero — Mercaria keeps nothing on a fully
    // refunded order.
    expect(await accountTotal(fixture.paymentId, 'commission_revenue')).toBe(0n);
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });

  it('returns the commission pro-rata on a partial refund', async () => {
    const [fixture] = await seedSettledOrder('fee-half-refund', {
      feeMinorPerOrder: FEE,
      quantity: 2,
    });

    await processRefund(
      fixture.storeId,
      fixture.orderId,
      { lineItems: [{ variantId: await firstVariant(fixture.orderId), quantity: 1, restock: false }] },
      fixture.ownerId,
    );

    // Half the order back: the seller bears half their NET, and Mercaria keeps
    // exactly half its commission.
    expect(api.refundCalls[0]?.params.amount).toBe(ORDER_TOTAL / 2);
    expect(api.reversalCalls[0]?.params.amount).toBe((ORDER_TOTAL - FEE) / 2);
    expect(await accountTotal(fixture.paymentId, 'commission_revenue')).toBe(-BigInt(FEE / 2));
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });

  it('converts the fee at the charge’s own captured ratio on a converted charge', async () => {
    // 4,000 presentment landed as 3,667 platform. The snapshot fee (400,
    // presentment) converts by the SAME ratio, floored: 366. Deterministic in
    // the payment row alone — no live rate is consulted, so a later FX move can
    // never change what this seller is owed.
    const platformGross = 3_667;
    const convertedFee = Math.floor((FEE * platformGross) / ORDER_TOTAL);
    const [fixture] = await seedSettledOrder('fee-converted', {
      feeMinorPerOrder: FEE,
      platformGross,
    });

    const transfer = await transferFor(fixture.paymentId, fixture.orderId);
    expect(transfer?.amountAmount).toBe(platformGross - convertedFee);
    expect(await accountTotal(fixture.paymentId, 'commission_revenue')).toBe(-BigInt(convertedFee));
    expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });

  it('splits a multi-seller charge into per-order nets whose fees sum to the commission', async () => {
    const fixtures = await seedSettledOrder('fee-multi', { orders: 2, feeMinorPerOrder: FEE });
    const [first, second] = fixtures;

    for (const fixture of fixtures) {
      const transfer = await transferFor(fixture.paymentId, fixture.orderId);
      expect(transfer?.amountAmount).toBe(ORDER_TOTAL - FEE);
      expect(await accountTotal(first.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
    }
    expect(first.paymentId).toBe(second.paymentId);
    expect(await accountTotal(first.paymentId, 'commission_revenue')).toBe(-BigInt(FEE * 2));
    expect(await ledgerBalance(first.paymentId)).toEqual({ EUR: 0n });
  });

  it('mercaria_retail posts NO marketplace commission, structurally', async () => {
    const [fixture] = await seedSettledOrder('fee-retail', { retailNotApplicable: true });

    // The whole gross is the seller side; no commission leg EXISTS — not a
    // zero-valued one, none at all (`chargeSucceeded` omits a zero leg, and the
    // not-applicable snapshot contributes no fee to shrink the share).
    const transfer = await transferFor(fixture.paymentId, fixture.orderId);
    expect(transfer?.amountAmount).toBe(ORDER_TOTAL);
    const entries = await ledgerFor(fixture.paymentId);
    expect(entries.filter((entry) => entry.account === 'commission_revenue')).toHaveLength(0);
    expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
  });
});
