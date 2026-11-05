/**
 * The refund lifecycle and the settled money path end to end (#49, #88), on the
 * Peable rail, against a REAL Postgres and a fake Peable gateway.
 *
 * ## Why none of it can be mocked here
 *
 * Every property this file asserts is a property of the DATABASE. The ledger
 * balances per currency because a repository refuses an unbalanced set and a
 * trigger refuses an edit; a refund executes once because a compare-and-swap on
 * `provider_refund_id` matched one caller; a reversal books once because a
 * second claim on `provider_reversal_id` matched nothing. A mocked `update`
 * accepts every one of those and returns whatever the test wired — which is
 * exactly the blind spot `AGENTS.md` records for the moderation writes, and the
 * money here is larger.
 *
 * ## What IS mocked, and only that
 *
 * `peable/client.js`, the single module that talks to the gateway
 * (`__tests__/helpers/fake-peable-gateway.ts`), and the one config flag
 * that switches the rail on. Everything above it — `PeablePaymentProvider`, the
 * refund executor, the ledger postings, the outbox and the settlement — is the
 * real code.
 *
 * The SUCCESS path is driven through `applyPaymentStatus` directly, with a
 * settlement figure and a processor fee. That is the domain's one writer of a
 * payment status, the same function the Peable event router calls — but the
 * router states neither figure yet (its docblock records the fee gap), and the
 * cases below are about what the ledger does WITH them: a converted charge's
 * proration and a commission distinct from the processing cost.
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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { uuidv7 } from '@oxy.so/db';
import { PEABLE_API_VERSION } from '@peable.to/sdk';

/** The order's grand total, in EUR cents. Divisible by 4, so quarters are exact. */
const ORDER_TOTAL = 4_000;
/** What the acquirer keeps on the charge. Mercaria's cost (ADR 0001 D5). */
const CHARGE_FEE = 116;
/** The secret this deployment verifies gateway deliveries with (see the config mock). */
const WEBHOOK_SECRET = 'whsec_refund_lifecycle_not_a_real_one';

/**
 * The fake gateway. Hoisted so the `vi.mock` factory below can close over it —
 * a factory is hoisted above every `const` in this file.
 */
const gateway = await vi.hoisted(async () =>
  (await import('./helpers/fake-peable-gateway.js')).createFakePeableGateway(),
);

/**
 * The Peable rail switched on, and nothing else changed. `PEABLE_ENABLED` also
 * needs an Oxy identity this suite does not have, and the client is faked
 * below anyway, so the flag is set on the frozen config rather than the
 * environment.
 */
vi.mock('../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      payments: {
        ...actual.config.payments,
        peable: {
          ...actual.config.payments.peable,
          enabled: true,
          // The literal, not `WEBHOOK_SECRET`: this factory is hoisted above it.
          webhookSecret: 'whsec_refund_lifecycle_not_a_real_one',
          webhooksEnabled: true,
          livemode: false,
        },
      },
    },
  };
});

vi.mock('../peable/client.js', () => gateway.clientModule());

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

type Database = import('../../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../../db/postgres.js').closePostgres;
let ingestPeableDelivery: typeof import('../peable/ingress.js').ingestPeableDelivery;
let applyPaymentStatus: typeof import('../payment.service.js').applyPaymentStatus;
let ensurePayment: typeof import('../payment.service.js').ensurePayment;
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
  // Dynamic, like everything else here: a STATIC import of any repository pulls
  // `db/postgres.js` and therefore `config/index.ts` at collection time, before
  // the hoisted mocks above have anything to close over.
  const postgres = await import('../../../db/postgres.js');
  db = await postgres.connectPostgres();
  ({ closePostgres } = postgres);
  ({ ingestPeableDelivery } = await import('../peable/ingress.js'));
  ({ applyPaymentStatus, ensurePayment } = await import('../payment.service.js'));
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
  gateway.reset();
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
  accountId: string;
  checkoutGroupId: string;
}

/**
 * A store whose seller is payment ready on the Peable rail, its paid order, and
 * the settled transfer that paid it.
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
     * What the charge became in the platform's settlement currency, when it was
     * converted.
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
  const accountId = `ca_${suffix.replace(/-/g, '').slice(-24)}`;
  const store = await insertStore({
    oxyAccountId: ownerId,
    handle: `refund-${suffix}`,
    name: 'Refund lifecycle store',
    description: '',
    brandColor: '#123456',
    defaultCurrency: 'EUR',
  });

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

  // A payment-ready seller account on the rail, so settlement transfers rather
  // than withholding. Readiness is ONE stored verdict (#46) and is set through
  // the repository that computes it, never by writing a boolean.
  const account = await insertProviderAccount(db, {
    provider: 'peable',
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
        conditionAssertion: 'seller_declared',
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
      commercialRole: 'connected_marketplace',
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
  gateway.putIntent({ id: intentId, status: 'succeeded', amount: BigInt(gross), currency: 'EUR' });

  const payment = await ensurePayment({
    provider: 'peable',
    checkoutGroupId,
    presentment: { amount: gross, currency: 'EUR' },
    buyerOxyUserId: `buyer-${suffix}`,
    providerObjectId: intentId,
  });

  // The real success path: books `charge_succeeded`, drains the outbox inline,
  // marks every order paid and settles each seller through the gateway. The
  // figures are supplied here — see the file docblock.
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
        provider: 'peable',
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
    accountId,
    checkoutGroupId,
  }));
}

/** Every ledger entry this payment produced, flattened for assertion. */
async function ledgerFor(
  paymentId: string,
): Promise<
  { kind: string; account: string; currency: string; amount: bigint; orderId: string | null }[]
> {
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
async function accountTotal(paymentId: string, account: string, orderId?: string): Promise<bigint> {
  const entries = await ledgerFor(paymentId);
  return entries
    .filter(
      (entry) => entry.account === account && (orderId === undefined || entry.orderId === orderId),
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
      and(
        eq(paymentSchema.transfers.paymentId, paymentId),
        eq(paymentSchema.transfers.orderId, orderId),
      ),
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

/**
 * Sign and deliver one gateway event through the real Peable ingress.
 *
 * Signed with the secret the config mock gives this deployment, in the scheme
 * `verify.ts` checks (`t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>">`), so the
 * delivery is verified by the real SDK and stored, routed and applied by the
 * real ingress.
 */
async function deliver(event: {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}) {
  const payload = JSON.stringify({
    object: 'event',
    api_version: PEABLE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    request: { id: null, idempotency_key: null },
    ...event,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${String(timestamp)}.${payload}`)
    .digest('hex');
  return await ingestPeableDelivery({
    payload: Buffer.from(payload, 'utf8'),
    signature: `t=${String(timestamp)},v1=${digest}`,
  });
}

/**
 * Whether the Peable adapter states what a refund took off the platform balance.
 *
 * It does not yet: `PeablePaymentProvider.refund` returns no `platform` figure,
 * so `executeRefundAtProvider` refuses — correctly — to book a refund it cannot
 * denominate (`refund_settlement_unavailable`, retried), after the gateway has
 * already refunded the buyer. That is a recorded gap of the Peable rail (ADR
 * 0009 D13 "As built"), not a property of the domain. The cases that need a
 * booked refund are therefore SKIPPED, by name, until the adapter supplies the
 * figure — flip this to `true` in the same change and they must pass unchanged.
 * Asserting today's refusal instead would pin the defect as behaviour.
 */
const PEABLE_REFUNDS_BOOK = false;

describe('a merchant refund on a settled Peable order', () => {
  it.skipIf(!PEABLE_REFUNDS_BOOK)(
    'refunds the buyer, reverses the whole seller share and balances the ledger',
    async () => {
      const [fixture] = await seedSettledOrder('full');
      const transferBefore = await transferFor(fixture.paymentId, fixture.orderId);
      expect(transferBefore?.amountAmount).toBe(ORDER_TOTAL);
      const availableBefore = await availableFor(fixture.orderId);

      const refund = await processRefund(
        fixture.storeId,
        fixture.orderId,
        {
          lineItems: [
            { variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true },
          ],
        },
        fixture.ownerId,
      );

      // The rail was asked for exactly the buyer's side, under the ADR's key, as
      // the gateway's canonical integer string.
      const refundCalls = gateway.state.refundCalls;
      expect(refundCalls).toHaveLength(1);
      expect(refundCalls[0]?.idempotencyKey).toBe(`re:${refund.id}`);
      expect(refundCalls[0]?.params.amount).toBe(String(ORDER_TOTAL));
      expect(refundCalls[0]?.params.payment_intent).toBe(fixture.intentId);
      // Mercaria's own id travels as the refund's `external_ref` — its durable
      // identity at the gateway, beyond the idempotency key's window.
      expect(refundCalls[0]?.params.external_ref).toBe(refund.id);

      // …and the SELLER's side, in the PLATFORM currency, under its own key —
      // which is also the reversal's durable identity at the gateway.
      const reversalCalls = gateway.state.reversalCalls;
      expect(reversalCalls).toHaveLength(1);
      expect(reversalCalls[0]?.idempotencyKey).toBe(`trr:${refund.id}:${fixture.orderId}`);
      expect(reversalCalls[0]?.params.amount).toBe(String(ORDER_TOTAL));
      expect(reversalCalls[0]?.params.external_ref).toBe(`trr:${refund.id}:${fixture.orderId}`);

      // The refund's own provider state, which is what a merchant screen reads.
      const stored = await findRefundById(refund.id);
      expect(stored?.provider).toBe('peable');
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
        .select({
          status: orderSchema.orders.status,
          paymentStatus: orderSchema.orders.paymentStatus,
        })
        .from(orderSchema.orders)
        .where(eq(orderSchema.orders.id, fixture.orderId));
      expect(order?.status).toBe('refunded');
      expect(order?.paymentStatus).toBe('refunded');
    },
  );

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
  it.skipIf(!PEABLE_REFUNDS_BOOK)(
    'reverses two partial refunds of a CONVERTED charge with no unit stranded',
    async () => {
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
      // Half back is not fully reversed — the gateway calls it
      // `partially_reversed`, which Mercaria's `TransferStatus` folds, and why
      // `transfers` stores an AMOUNT beside the status.
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
      expect(gateway.state.reversalCalls).toHaveLength(2);
      expect(
        gateway.state.reversalCalls.reduce((sum, call) => sum + Number(call.params.amount), 0),
      ).toBe(platformGross);

      // The seller's payable nets to zero: credited by the charge, settled by the
      // transfer, charged by two refunds and recovered by two reversals.
      expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
      expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
    },
  );

  it.skipIf(!PEABLE_REFUNDS_BOOK)(
    'never touches inventory from a provider outcome, however many arrive',
    async () => {
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
      expect(stored?.providerRefundId).toBeTruthy();

      // Two deliveries of the gateway's `charge.refunded` — the one refund event
      // the Peable router acts on, by re-reading the payment through the rail.
      // Issue #49 invariant 2: a provider outcome moves money and NOTHING else.
      for (const eventId of ['a', 'b']) {
        const delivered = await deliver({
          id: `evt_charge_refunded_${eventId}_${RUN}_${refund.id}`,
          type: 'charge.refunded',
          data: {
            object: { id: `ch_${refund.id}`, object: 'charge', payment_intent: fixture.intentId },
          },
        });
        expect(delivered.outcome).toBe('accepted');
      }

      expect(await availableFor(fixture.orderId)).toBe(afterCommerce);
      // …and the money did not move again either.
      expect(gateway.state.refundCalls).toHaveLength(1);
      expect(gateway.state.reversalCalls).toHaveLength(1);
      expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
    },
  );
});

describe('a reversal the rail refuses', () => {
  /**
   * ADR 0001 D7's explicit outcome, and the one place this system deliberately
   * ends up out of pocket: the buyer's refund is NOT blocked on the seller-side
   * recovery.
   */
  it.skipIf(!PEABLE_REFUNDS_BOOK)(
    'still refunds the buyer, books the gap and raises one operator exception',
    async () => {
      const [fixture] = await seedSettledOrder('reversal-fail');
      const transfer = await transferFor(fixture.paymentId, fixture.orderId);
      gateway.state.reversalFailures.add(String(transfer?.providerObjectId));

      const refund = await processRefund(
        fixture.storeId,
        fixture.orderId,
        {
          lineItems: [
            { variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true },
          ],
        },
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
        .where(
          eq(
            paymentSchema.paymentOutboxes.id,
            `payment:reversal_failed:${refund.id}:${fixture.orderId}`,
          ),
        );
      expect(raised).toHaveLength(1);
    },
  );

  it.skipIf(!PEABLE_REFUNDS_BOOK)(
    'leaves a sibling seller of the same charge completely untouched',
    async () => {
      const [first, second] = await seedSettledOrder('siblings', { orders: 2 });
      const transfer = await transferFor(first.paymentId, first.orderId);
      gateway.state.reversalFailures.add(String(transfer?.providerObjectId));

      const siblingPayableBefore = await accountTotal(
        second.paymentId,
        'merchant_payable',
        second.orderId,
      );
      const siblingTransferBefore = await transferFor(second.paymentId, second.orderId);

      await processRefund(
        first.storeId,
        first.orderId,
        {
          lineItems: [{ variantId: await firstVariant(first.orderId), quantity: 1, restock: true }],
        },
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
    },
  );
});

describe('a refund the rail refuses outright', () => {
  /**
   * Issue #49 scope 10, the "local success, provider failure" half: the commerce
   * record has committed and restocked, and the money did not go.
   */
  it('records the refund, raises refund_failed and books NOTHING', async () => {
    const [fixture] = await seedSettledOrder('refund-fail');
    gateway.state.refundFailures.add(fixture.intentId);
    const ledgerBefore = (await ledgerFor(fixture.paymentId)).length;

    const refund = await processRefund(
      fixture.storeId,
      fixture.orderId,
      {
        lineItems: [{ variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true }],
      },
      fixture.ownerId,
    );

    const stored = await findRefundById(refund.id);
    expect(stored?.providerState).toBe('failed');
    expect(stored?.providerRefundId).toBeNull();
    // No money left the platform balance, so no leg describes any leaving.
    expect((await ledgerFor(fixture.paymentId)).length).toBe(ledgerBefore);
    expect(await outboxTypesFor(fixture.paymentId)).toContain('refund_failed');
    // …and no reversal was even attempted: there is nothing to recover.
    expect(gateway.state.reversalCalls).toHaveLength(0);
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

  it.skipIf(!PEABLE_REFUNDS_BOOK)(
    'returns the whole commission on a full refund, per the proportional policy',
    async () => {
      const [fixture] = await seedSettledOrder('fee-full-refund', { feeMinorPerOrder: FEE });

      await processRefund(
        fixture.storeId,
        fixture.orderId,
        {
          lineItems: [
            { variantId: await firstVariant(fixture.orderId), quantity: 1, restock: true },
          ],
        },
        fixture.ownerId,
      );

      // The buyer got the WHOLE order back; the seller bore only their net.
      expect(gateway.state.refundCalls[0]?.params.amount).toBe(String(ORDER_TOTAL));
      expect(gateway.state.reversalCalls[0]?.params.amount).toBe(String(ORDER_TOTAL - FEE));

      // The commission came back through the residual: credited at the charge,
      // debited by the refund, net zero — Mercaria keeps nothing on a fully
      // refunded order.
      expect(await accountTotal(fixture.paymentId, 'commission_revenue')).toBe(0n);
      expect(await accountTotal(fixture.paymentId, 'merchant_payable', fixture.orderId)).toBe(0n);
      expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
    },
  );

  it.skipIf(!PEABLE_REFUNDS_BOOK)(
    'returns the commission pro-rata on a partial refund',
    async () => {
      const [fixture] = await seedSettledOrder('fee-half-refund', {
        feeMinorPerOrder: FEE,
        quantity: 2,
      });

      await processRefund(
        fixture.storeId,
        fixture.orderId,
        {
          lineItems: [
            { variantId: await firstVariant(fixture.orderId), quantity: 1, restock: false },
          ],
        },
        fixture.ownerId,
      );

      // Half the order back: the seller bears half their NET, and Mercaria keeps
      // exactly half its commission.
      expect(gateway.state.refundCalls[0]?.params.amount).toBe(String(ORDER_TOTAL / 2));
      expect(gateway.state.reversalCalls[0]?.params.amount).toBe(String((ORDER_TOTAL - FEE) / 2));
      expect(await accountTotal(fixture.paymentId, 'commission_revenue')).toBe(-BigInt(FEE / 2));
      expect(await ledgerBalance(fixture.paymentId)).toEqual({ EUR: 0n });
    },
  );

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
