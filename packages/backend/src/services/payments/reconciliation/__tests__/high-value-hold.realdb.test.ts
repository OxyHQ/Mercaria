/**
 * The high-value transfer HOLD and the sweep that releases it (#988), against a
 * REAL Postgres and a fake Stripe.
 *
 * ## The three properties this file exists to pin
 *
 * **A hold is DECIDED ONCE.** `settleOneOrder` consults the policy only when
 * `createOrGetTransfer` reports `created: true`, and reads `transfers.held_until`
 * on every re-entry. Re-deciding would be the same computation with a moving
 * `now` and a possibly-moved configuration, and it would make a review's
 * decision impossible to act on — an operator clearing a hold would have it
 * silently re-imposed by the very settlement they ran to release it. `a widened
 * window does not extend a hold already in force` is the case with teeth here:
 * with the window UNCHANGED a recompute produces the identical instant, so a
 * re-run alone cannot tell the two implementations apart.
 *
 * **A hold ALWAYS ends.** Nothing else in this system re-drives a settlement —
 * `handleTransferWithheld` records and `handleProviderAccountChanged` only logs —
 * so the sweep and the operator repair are the only two exits. A hold with no
 * releaser is a payout that never arrives.
 *
 * **The sweep TERMINATES.** `clearTransferHold` spends the hold whether or not
 * the release actually paid the seller, so a transfer whose window passed and
 * whose seller has since lapsed leaves the sweep's population instead of being
 * retried once per pass forever. That is the whole reason `held_until` is a
 * column rather than a re-derivation from the amount, and
 * `spends the hold on a permanent failure` is the case it exists for.
 *
 * ## Why a real database
 *
 * Every one of those is a property of SQL. `created` is `DO NOTHING … RETURNING`
 * returning no row on conflict; the release population is a partial index
 * predicate over `held_until IS NOT NULL AND provider_object_id IS NULL`; the
 * hold is spent by a compare-and-swap guarded on the hold's own VALUE, so a
 * settlement that re-held or paid it in between makes the clear a no-op. A
 * mocked update accepts every one of those and returns whatever the test wired.
 *
 * ## It does NOT hold the reconciliation sweep slot, and that is checked
 *
 * `reconciliation-sweep-slot.ts` serialises the files that touch
 * `payment_discrepancies`, and `reconciliation-sweep-slot.test.ts` asserts the
 * toucher set is EXACTLY the holder set — so holding it without touching the
 * table fails the build just as loudly as the reverse. This file touches it in
 * neither direction, measured rather than assumed:
 *
 *  - `releaseWithheldTransfersPage` writes no discrepancy row at all (its
 *    docblock states why: the `transfer_withheld` exception already carries the
 *    fact, and the runner's `discrepancies` count is a count of ROWS WRITTEN).
 *  - `runRepair` reaches `closeDiscrepancy` only through `maybeResolveDiscrepancy`,
 *    which returns immediately when `request.discrepancyId === undefined`. No
 *    call below passes one.
 *  - Nothing here reads a discrepancy, so a sibling's global sweep reopening a
 *    resolved row cannot make an assertion in this file fail.
 *
 * The converse hazard — this file's own globally-scoped query — is real and
 * bounded instead. `findReleasableTransfers` selects across the whole
 * `transfers` table, so `scanned` is asserted as a FLOOR and never an equality,
 * and every other assertion names a row this run owns.
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL.
 * Every id here carries this run's own suffix. `STRIPE_HIGH_VALUE_HOLD_THRESHOLDS`
 * is deleted in `afterAll` because vitest reuses a worker PROCESS across files:
 * left set, it would make a LATER file in this process hold its own transfers
 * and fail for a reason nothing in it names. The threshold is also two orders of
 * magnitude above any sibling's fixture, so the leak could not bite even if the
 * deletion were dropped.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * The EUR bar, in minor units — 50,000.00 €.
 *
 * Absurd for a marketplace fixture on purpose. It travels through the REAL
 * `STRIPE_HIGH_VALUE_HOLD_THRESHOLDS` grammar and `resolveHighValueHoldThresholds`,
 * so this file also proves the env → config → settlement chain is connected; and
 * being far above anything a sibling settles means a leaked variable could not
 * hold another file's transfer.
 */
const THRESHOLD_EUR = 5_000_000;
/** A seller share ABOVE the bar. */
const HELD_TOTAL = 10_000_000;
/** A seller share BELOW it — the control that proves the rail is reachable. */
const SETTLED_TOTAL = 1_000_000;
/** The EUR→USD ratio the rail is pretended to have applied on the USD case. */
const USD_RATE = 1.1;
/** The Oxy account every repair below is run as. */
const OPERATOR = `oxy-operator-${RUN}`;

/**
 * The fake Stripe API's state. Hoisted so the `vi.mock` factory can close over
 * it — a factory is hoisted above every `const` in this file.
 */
const api = vi.hoisted(() => ({
  intents: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, Record<string, unknown>>(),
  transfers: new Map<string, Record<string, unknown>>(),
  /** Idempotency key → the object that key already produced (Stripe's own rule). */
  byKey: new Map<string, Record<string, unknown>>(),
  /** Connected accounts, keyed by `acct_…`, as `accounts.retrieve` would return them. */
  accounts: new Map<string, Record<string, unknown>>(),
  transferCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  nextId: 0,
}));

/**
 * The hold WINDOW this deployment is configured with, made mutable.
 *
 * `config` reads `process.env` once at module load and freezes the result, so a
 * window that changes between two settlement runs — the deployment raising
 * `STRIPE_HIGH_VALUE_HOLD_WINDOW_MS` while a hold is already in force — cannot
 * be produced through the environment at all. The mock below replaces exactly
 * one leaf with a getter over this holder and spreads the rest of the real
 * config through unchanged, so every other reader (the connection string, the
 * outbox, the rail) is the genuine article.
 *
 * Deliberately NOT the 72h production default: if the mock ever stopped
 * applying, `stamps when the share becomes releasable` would fail on the exact
 * arithmetic rather than passing against a value nobody chose.
 */
const hold = vi.hoisted(() => ({ windowMs: 6 * 60 * 60 * 1_000 }));

/** The configured window, as the tests below name it. */
const WINDOW_MS = 6 * 60 * 60 * 1_000;

vi.mock('../../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      payments: {
        ...actual.config.payments,
        stripe: {
          ...actual.config.payments.stripe,
          get highValueHoldWindowMs() {
            return hold.windowMs;
          },
        },
      },
    },
  };
});

vi.mock('../../stripe/client.js', () => ({
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
  createStripeTransfer: (params: Record<string, unknown>, idempotencyKey: string) => {
    api.transferCalls.push({ params, idempotencyKey });
    // Stripe's own idempotency: one key produces one object, however many times
    // it is presented. Honoured here because a released hold re-enters the SAME
    // settlement with the same `tr:<paymentId>:<orderId>` key, and a fake that
    // minted a second transfer would hide the one mistake this domain cannot
    // recover from.
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);
    api.nextId += 1;
    const transfer = {
      id: `tr_hold_${String(api.nextId)}`,
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
  retrieveStripeAccount: (id: string) => {
    const account = api.accounts.get(id);
    if (!account) throw new Error(`No fake account registered for ${id}`);
    return Promise.resolve(account);
  },
  createStripeRefund: () => {
    throw new Error('This suite does not exercise the refund rail.');
  },
  retrieveStripeRefund: () => {
    throw new Error('This suite does not exercise the refund rail.');
  },
  createStripeTransferReversal: () => {
    throw new Error('This suite does not exercise the reversal rail.');
  },
}));

type Database = import('../../../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../../../db/postgres.js').closePostgres;
let ensurePayment: typeof import('../../payment.service.js').ensurePayment;
let applyPaymentStatus: typeof import('../../payment.service.js').applyPaymentStatus;
let settlePaymentTransfers: typeof import('../../settlement.service.js').settlePaymentTransfers;
let releaseWithheldTransfersPage: typeof import('../withheld-transfers.job.js').releaseWithheldTransfersPage;
let runRepair: typeof import('../repairs.service.js').runRepair;
let RepairRefusedError: typeof import('../repairs.service.js').RepairRefusedError;
let findTransferForOrder: typeof import('../../../../db/payments/paymentRepository.js').findTransferForOrder;
let findReleasableTransfers: typeof import('../../../../db/payments/paymentRepository.js').findReleasableTransfers;
let insertStore: typeof import('../../../../db/stores/storeRepository.js').insertStore;
let insertLocation: typeof import('../../../../db/stores/locationRepository.js').insertLocation;
let insertVariants: typeof import('../../../../db/catalog/variantRepository.js').insertVariants;
let setAvailable: typeof import('../../../inventory.service.js').setAvailable;
let insertOrder: typeof import('../../../../db/orders/orderRepository.js').insertOrder;
let nextOrderNumber: typeof import('../../../../db/orders/orderRepository.js').nextOrderNumber;
let insertProviderAccount: typeof import('../../../../db/payments/providerAccountRepository.js').insertProviderAccount;
let applyProviderAccountState: typeof import('../../../../db/payments/providerAccountRepository.js').applyProviderAccountState;
let paymentSchema: typeof import('../../../../db/schema/payments.js');
let ledgerSchema: typeof import('../../../../db/schema/ledger.js');
let catalogSchema: typeof import('../../../../db/schema/catalog.js');
let reconciliationSchema: typeof import('../../../../db/schema/reconciliation.js');

beforeAll(async () => {
  // Set BEFORE importing anything that reads config — `config/index.ts` reads
  // process.env once at module load and freezes the result, and vitest reuses a
  // worker PROCESS across files while giving each its own module registry, so a
  // sibling's write survives into this one.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_high_value_hold_not_a_real_one';
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_high_value_hold_connect';
  process.env.STRIPE_PLATFORM_CURRENCY = 'EUR';
  process.env.STRIPE_PRESENTMENT_CURRENCIES = 'EUR,USD';
  // EUR only. USD is deliberately ABSENT — an unconfigured currency settles, and
  // `settles a currency with no configured threshold` is what proves it.
  process.env.STRIPE_HIGH_VALUE_HOLD_THRESHOLDS = `EUR:${String(THRESHOLD_EUR)}`;

  const postgres = await import('../../../../db/postgres.js');
  db = await postgres.connectPostgres();
  ({ closePostgres } = postgres);
  ({ ensurePayment, applyPaymentStatus } = await import('../../payment.service.js'));
  ({ settlePaymentTransfers } = await import('../../settlement.service.js'));
  ({ releaseWithheldTransfersPage } = await import('../withheld-transfers.job.js'));
  ({ runRepair, RepairRefusedError } = await import('../repairs.service.js'));
  ({ findTransferForOrder, findReleasableTransfers } = await import(
    '../../../../db/payments/paymentRepository.js'
  ));
  ({ insertStore } = await import('../../../../db/stores/storeRepository.js'));
  ({ insertLocation } = await import('../../../../db/stores/locationRepository.js'));
  ({ insertVariants } = await import('../../../../db/catalog/variantRepository.js'));
  ({ setAvailable } = await import('../../../inventory.service.js'));
  ({ insertOrder, nextOrderNumber } = await import('../../../../db/orders/orderRepository.js'));
  ({ insertProviderAccount, applyProviderAccountState } = await import(
    '../../../../db/payments/providerAccountRepository.js'
  ));
  paymentSchema = await import('../../../../db/schema/payments.js');
  ledgerSchema = await import('../../../../db/schema/ledger.js');
  catalogSchema = await import('../../../../db/schema/catalog.js');
  reconciliationSchema = await import('../../../../db/schema/reconciliation.js');
}, 120_000);

afterAll(async () => {
  // See the file docblock: left set, this makes a LATER file in this worker
  // process hold its own transfers.
  delete process.env.STRIPE_HIGH_VALUE_HOLD_THRESHOLDS;
  await closePostgres();
});

beforeEach(() => {
  api.intents.clear();
  api.charges.clear();
  api.transfers.clear();
  api.byKey.clear();
  api.accounts.clear();
  api.transferCalls.length = 0;
  hold.windowMs = WINDOW_MS;
});

/** A EUR `DualMoney` whose two sides are equal — no conversion in play. */
function eur(amount: number) {
  return {
    shop: { amount, currency: 'EUR' as const },
    presentment: { amount, currency: 'EUR' as const },
  };
}

/**
 * A store, an order and a FUNDED payment whose settlement has already run once.
 *
 * The settlement is not called here: `applyPaymentStatus('succeeded')` books the
 * charge, drains the `payment_succeeded` outbox row inline and that handler
 * settles — which is the production path, and the only one on which
 * `createOrGetTransfer` reports `created: true`. Driving the hold through it is
 * what makes these cases about the real decision rather than about a `transfers`
 * row a test wrote by hand.
 *
 * @param options.totalMinor The order's EUR grand total, and the buyer's
 *   presentment amount.
 * @param options.settled What LANDED on Mercaria's balance, when the rail
 *   converted. `settlementBasis` sizes the transfer from this, so it is what
 *   decides which currency's threshold the hold policy looks up.
 */
async function seedScenario(
  label: string,
  options: {
    totalMinor: number;
    ready: boolean;
    settled?: { amountMinor: number; currency: CurrencyCode };
  },
) {
  const suffix = `${label}-${RUN}-${uuidv7()}`;
  const ownerId = `owner-${suffix}`;
  // From the uuid's TAIL, not the label's head: `acct_` ids are bounded, and
  // truncating a `<label>-<run>-<uuid>` suffix from the FRONT makes two
  // scenarios that share a label collide on `UNIQUE(provider, provider_account_id)`.
  const providerAccountId = `acct_${suffix.replace(/-/g, '').slice(-24)}`;
  const settled = options.settled ?? { amountMinor: options.totalMinor, currency: 'EUR' as const };

  const store = await insertStore(
    {
      handle: `hold-${suffix}`,
      name: 'High-value store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'EUR',
    },
    [{ oxyUserId: ownerId, role: 'owner', permissions: ['store:manage'] }],
  );
  const location = await insertLocation(store.id, {
    name: 'Warehouse',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
    address: {
      recipientName: 'High-value store',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
  });

  const account = await insertProviderAccount(db, {
    provider: 'stripe',
    ownerType: 'store',
    ownerId: store.id,
    providerAccountId,
    country: 'ES',
  });
  await setAccountState(account.id, options.ready);
  setRailAccount(providerAccountId, options.ready);

  const [listing] = await db
    .insert(catalogSchema.listings)
    .values({
      ownerType: 'store',
      storeId: store.id,
      title: 'Something expensive',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
    })
    .returning({ id: catalogSchema.listings.id });
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: options.totalMinor,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 10,
      position: 0,
      optionValues: [],
    },
  ]);
  await setAvailable(variant.id, listing.id, location.id, 10);

  const checkoutGroupId = `group-${suffix}`;
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
        title: 'Something expensive',
        variantTitle: 'Default',
        optionValues: [],
        unitPrice: eur(options.totalMinor),
        quantity: 1,
        lineTotal: eur(options.totalMinor),
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
      subtotal: eur(options.totalMinor),
      discountTotal: eur(0),
      shipping: eur(0),
      tax: eur(0),
      grandTotal: eur(options.totalMinor),
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    checkoutGroupId,
    statusHistory: [{ status: 'pending_payment', at: new Date(), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
  });

  const intentId = `pi_${suffix.replace(/-/g, '')}`;
  const chargeId = `ch_${suffix.replace(/-/g, '')}`;
  api.intents.set(intentId, {
    id: intentId,
    object: 'payment_intent',
    status: 'succeeded',
    amount: options.totalMinor,
    currency: 'eur',
    latest_charge: chargeId,
    metadata: {},
  });
  api.charges.set(chargeId, {
    id: chargeId,
    object: 'charge',
    amount: options.totalMinor,
    currency: 'eur',
    amount_refunded: 0,
    balance_transaction: {
      id: `txn_${chargeId}`,
      object: 'balance_transaction',
      amount: settled.amountMinor,
      currency: settled.currency.toLowerCase(),
      fee: 0,
      exchange_rate: settled.currency === 'EUR' ? null : USD_RATE,
      created: Math.floor(Date.now() / 1_000),
    },
  });

  const payment = await ensurePayment({
    provider: 'stripe',
    checkoutGroupId,
    presentment: { amount: options.totalMinor, currency: 'EUR' },
    buyerOxyUserId: `buyer-${suffix}`,
    providerObjectId: intentId,
  });

  // The real success path: books `charge_succeeded`, drains the outbox inline,
  // marks the orders paid and settles — which is where the hold is decided.
  await applyPaymentStatus({
    paymentId: payment.id,
    next: 'succeeded',
    providerObjectId: intentId,
    platform: {
      amount: { amount: settled.amountMinor, currency: settled.currency },
      rate: {
        from: 'EUR',
        to: settled.currency,
        rate: settled.amountMinor / options.totalMinor,
        provider: 'stripe',
        asOf: new Date().toISOString(),
      },
    },
  });

  return {
    suffix,
    store,
    accountRowId: account.id,
    orderId: order.id,
    paymentId: payment.id,
    providerAccountId,
  };
}

/** Set the STORED readiness verdict, through the repository that computes it. */
async function setAccountState(accountRowId: string, ready: boolean): Promise<void> {
  await applyProviderAccountState(db, {
    id: accountRowId,
    state: {
      onboardingState: ready ? 'ready' : 'restricted',
      chargesEnabled: ready,
      payoutsEnabled: ready,
      transfersCapability: ready ? 'active' : 'inactive',
      requirementsCurrentlyDue: 0,
      requirementsEventuallyDue: 0,
      requirementsPastDue: ready ? 0 : 2,
      requirementsPendingVerification: 0,
      disabledReasonCodes: [],
      syncedAt: new Date(),
    },
  });
}

/** What `accounts.retrieve` will report for this connected account. */
function setRailAccount(providerAccountId: string, ready: boolean): void {
  api.accounts.set(providerAccountId, {
    id: providerAccountId,
    object: 'account',
    country: 'ES',
    default_currency: 'eur',
    charges_enabled: ready,
    payouts_enabled: ready,
    capabilities: { transfers: ready ? 'active' : 'inactive' },
    requirements: {
      currently_due: [],
      eventually_due: [],
      past_due: ready ? [] : ['individual.verification.document'],
      pending_verification: [],
      disabled_reason: ready ? null : 'requirements.past_due',
      current_deadline: null,
    },
    settings: { payouts: { schedule: { interval: 'daily', delay_days: 2 } } },
  });
}

/** The transfer row for one seller order, which every case below reads. */
async function transferFor(scenario: { paymentId: string; orderId: string }) {
  const row = await findTransferForOrder(db, scenario.paymentId, scenario.orderId);
  if (!row) throw new Error('the settlement wrote no transfer row for this scenario');
  return row;
}

/**
 * Move a hold into the past.
 *
 * A direct UPDATE of a row this file owns, and the one hand-write here: it
 * simulates the PASSAGE OF TIME, not a policy decision. Waiting six real hours
 * is not a test anybody runs, and the alternative — a configured window of a few
 * milliseconds — would make every case race the clock instead of asserting on
 * it.
 */
async function expireHold(transferId: string): Promise<Date> {
  const past = new Date(Date.now() - 60_000);
  await db
    .update(paymentSchema.transfers)
    .set({ heldUntil: past })
    .where(eq(paymentSchema.transfers.id, transferId));
  return past;
}

/** Every `transfer_withheld` exception open against one payment. */
async function withheldExceptionsFor(paymentId: string) {
  return await db
    .select()
    .from(paymentSchema.paymentOutboxes)
    .where(
      and(
        eq(paymentSchema.paymentOutboxes.eventType, 'transfer_withheld'),
        sql`${paymentSchema.paymentOutboxes.payload}->>'paymentId' = ${paymentId}`,
      ),
    );
}

/** What one order's `merchant_payable` currently nets to. */
async function payableBalance(orderId: string): Promise<bigint> {
  const rows = await db
    .select({ amount: ledgerSchema.ledgerEntries.amountMinor })
    .from(ledgerSchema.ledgerEntries)
    .where(
      and(
        eq(ledgerSchema.ledgerEntries.account, 'merchant_payable'),
        eq(ledgerSchema.ledgerEntries.orderId, orderId),
      ),
    );
  return rows.reduce((total, row) => total + row.amount, 0n);
}

/** The `transfer_created` postings booked for one order. */
async function transferPostings(orderId: string) {
  return await db
    .select()
    .from(ledgerSchema.ledgerTransactions)
    .where(
      and(
        eq(ledgerSchema.ledgerTransactions.orderId, orderId),
        eq(ledgerSchema.ledgerTransactions.kind, 'transfer_created'),
      ),
    );
}

/** Every repair row written for one subject. */
async function repairsFor(subjectKey: string) {
  return await db
    .select()
    .from(reconciliationSchema.paymentRepairs)
    .where(eq(reconciliationSchema.paymentRepairs.subjectKey, subjectKey));
}

/** Whether the sweep's OWN selection query still returns this transfer. */
async function isReleasable(transferId: string): Promise<boolean> {
  const page = await findReleasableTransfers(db, {
    // Far enough ahead that no configured window could still be open — this asks
    // "is it in the population at all", not "is it due yet".
    now: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
    limit: 500,
  });
  return page.some((row) => row.id === transferId);
}

describe('a high-value seller share', () => {
  it('is HELD, and the transfer is stamped with when it becomes releasable', async () => {
    const scenario = await seedScenario('held', { ready: true, totalMinor: HELD_TOTAL });
    const transfer = await transferFor(scenario);

    // The premise, asserted rather than assumed: the share really is above the
    // bar. Without this the case would still pass if a fee deduction had put the
    // net BELOW the threshold and something else had held it.
    expect(transfer.amountCurrency).toBe('EUR');
    expect(transfer.amountAmount).toBeGreaterThanOrEqual(THRESHOLD_EUR);

    // The money did not leave. Absent the hold, `provider_object_id` would carry
    // a `tr_hold_…` and `status` would be `paid` — which is exactly what the
    // control below reports for a smaller share in this same configuration.
    expect(transfer.providerObjectId).toBeNull();
    expect(transfer.status).toBe('pending');

    // The rail was never asked. This is the assertion that would report 1
    // instead of 0 if the hold were removed, and 0 either way if the fixture
    // could not reach the rail at all — which is why the control matters.
    expect(api.transferCalls).toHaveLength(0);

    // EXACT, not approximate: `highValueHoldFor` anchors on the transfer row's
    // own `created_at`, so the stamp is a pure function of a stored value and
    // the configured window. An anchor on the payment's `updatedAt` — the
    // tempting alternative, and a hold that never expires — would drift from
    // this by however long the settlement took.
    expect(transfer.heldUntil).not.toBeNull();
    expect(transfer.heldUntil?.getTime()).toBe(transfer.createdAt.getTime() + WINDOW_MS);

    // Re-entering settlement reports the wait rather than a failure: `withheld`
    // is the settlement's word for "this seller is not paid YET".
    const outcome = await settlePaymentTransfers(scenario.paymentId);
    expect(outcome).toEqual({ created: 0, alreadySettled: 0, withheld: 1 });

    // ONE exception, naming the instant an operator can act on. The reason is
    // what a person reads; without the ISO instant in it they would have to
    // guess whether the payout is late or merely waiting.
    const exceptions = await withheldExceptionsFor(scenario.paymentId);
    expect(exceptions).toHaveLength(1);
    expect(String(exceptions[0]?.payload.reason)).toContain(
      transfer.heldUntil?.toISOString() ?? 'no hold was stamped',
    );
    expect(String(exceptions[0]?.payload.reason)).toContain('high-value');
  });

  it('BELOW the threshold settles normally in the same configuration', async () => {
    // The control for the case above. If it fails, the zero rail calls up there
    // mean "the fixture cannot reach the rail", not "the threshold fired".
    const scenario = await seedScenario('settles', { ready: true, totalMinor: SETTLED_TOTAL });
    const transfer = await transferFor(scenario);

    expect(transfer.amountAmount).toBeLessThan(THRESHOLD_EUR);
    expect(transfer.providerObjectId).toBeTruthy();
    expect(transfer.status).toBe('paid');
    // Never held: `held_until` is NULL, so this row is not in the release
    // sweep's population at all.
    expect(transfer.heldUntil).toBeNull();
    expect(api.transferCalls).toHaveLength(1);
    // The seller's receivable is settled — the whole of "the money reached the
    // seller" in this system.
    expect(await payableBalance(scenario.orderId)).toBe(0n);
  });

  it('settles a currency with NO configured threshold, however large', async () => {
    // The rail converted to USD, so `settlementBasis` sizes the transfer in USD
    // and the policy looks USD up — and finds nothing, because only EUR is
    // configured. An absent threshold SETTLES; that default is the deliberate
    // opposite of `three-d-secure.ts`, where an unconfigured currency gets the
    // protective branch.
    const scenario = await seedScenario('no-threshold', {
      ready: true,
      totalMinor: HELD_TOTAL,
      settled: { amountMinor: Math.round(HELD_TOTAL * USD_RATE), currency: 'USD' },
    });
    const transfer = await transferFor(scenario);

    expect(transfer.amountCurrency).toBe('USD');
    // Larger than the EUR bar, so what spared it is the CURRENCY and not the
    // size. Absent the `threshold === undefined` branch — if a missing entry
    // fell back to another currency's bar, or to zero — this would be held and
    // `provider_object_id` would be NULL.
    expect(transfer.amountAmount).toBeGreaterThanOrEqual(THRESHOLD_EUR);
    expect(transfer.heldUntil).toBeNull();
    expect(transfer.providerObjectId).toBeTruthy();
    expect(api.transferCalls).toHaveLength(1);
    expect(await payableBalance(scenario.orderId)).toBe(0n);
  });
});

describe('the hold is decided once', () => {
  it('re-entering settlement neither moves the stamp nor opens a second exception', async () => {
    const scenario = await seedScenario('re-entry', { ready: true, totalMinor: HELD_TOTAL });
    const held = await transferFor(scenario);
    expect(held.heldUntil).not.toBeNull();

    await settlePaymentTransfers(scenario.paymentId);
    await settlePaymentTransfers(scenario.paymentId);

    const after = await transferFor(scenario);
    // Honest about what this measures: with the window UNCHANGED a recompute
    // would produce the IDENTICAL instant, so this assertion passes whether or
    // not the decision is gated on `created`. It pins that nothing else moved
    // the stamp — a `markTransferHeld` keyed on `now` rather than on the row's
    // `created_at` would push it forward by a run each time, which is a hold
    // that never expires. The gate itself is measured two cases below.
    expect(after.heldUntil?.getTime()).toBe(held.heldUntil?.getTime());
    expect(after.providerObjectId).toBeNull();
    expect(api.transferCalls).toHaveLength(0);

    // ONE exception after three settlements. `transferWithheldEventId` is
    // derived from (payment, order), so the outbox insert conflicts with itself;
    // were it derived from anything per-attempt, an operator would find the same
    // stuck payout in their queue once per outbox retry.
    expect(await withheldExceptionsFor(scenario.paymentId)).toHaveLength(1);

    // Now time passes. The stored decision is what expires — the policy is not
    // consulted again — and the same settlement that withheld it three times
    // now lets it go.
    await expireHold(held.id);
    const outcome = await settlePaymentTransfers(scenario.paymentId);

    // `created: 1` for a transfer ROW that was created three settlements ago:
    // `SettlementOutcome.created` counts movements made AT THE RAIL by this run,
    // which is a different "created" from `createOrGetTransfer`'s row-insert
    // flag — the one that gates the hold decision. Pinned here so the two stay
    // distinguishable.
    expect(outcome).toEqual({ created: 1, alreadySettled: 0, withheld: 0 });
    const settled = await transferFor(scenario);
    expect(settled.providerObjectId).toBeTruthy();
    expect(settled.status).toBe('paid');
    expect(api.transferCalls).toHaveLength(1);
    expect(await payableBalance(scenario.orderId)).toBe(0n);
    // The spent stamp is left behind rather than cleared, and that is harmless
    // BECAUSE the sweep's predicate also requires `provider_object_id IS NULL`.
    // Asserted so that a change to either half has to face the other.
    expect(settled.heldUntil).not.toBeNull();
    expect(await isReleasable(settled.id)).toBe(false);
  });

  it('a WIDENED window does not extend a hold already in force', async () => {
    const scenario = await seedScenario('widened', { ready: true, totalMinor: HELD_TOTAL });
    const held = await transferFor(scenario);
    const stamped = held.heldUntil?.getTime();
    expect(stamped).toBe(held.createdAt.getTime() + WINDOW_MS);

    // The deployment raises `STRIPE_HIGH_VALUE_HOLD_WINDOW_MS` tenfold while
    // this hold is in force, and settlement runs again — an outbox retry, a
    // sibling seller settling in the same group, the release sweep.
    hold.windowMs = WINDOW_MS * 10;
    const outcome = await settlePaymentTransfers(scenario.paymentId);
    expect(outcome).toEqual({ created: 0, alreadySettled: 0, withheld: 1 });

    const after = await transferFor(scenario);
    // THE discriminator for `decided once`. Ungate the recompute from
    // `created: true` and this reports `created_at + 60h` instead of
    // `created_at + 6h` — a seller's payout silently pushed 54 hours further
    // out by a configuration change that was never meant to be retroactive.
    expect(after.heldUntil?.getTime()).toBe(stamped);
    expect(after.heldUntil?.getTime()).not.toBe(held.createdAt.getTime() + WINDOW_MS * 10);
  });
});

describe('the release sweep', () => {
  it('settles a held transfer whose window has passed', async () => {
    const scenario = await seedScenario('sweep', { ready: true, totalMinor: HELD_TOTAL });
    const held = await transferFor(scenario);
    await expireHold(held.id);
    // The vacuity control for the absence check further down, and the sweep's
    // precondition: this row IS in the population before the pass.
    expect(await isReleasable(held.id)).toBe(true);

    const page = await releaseWithheldTransfersPage({ cursor: null, limit: 25 });

    // A FLOOR, never an equality: `findReleasableTransfers` is global over
    // `transfers` and this file cannot claim what a sibling holds.
    expect(page.scanned).toBeGreaterThanOrEqual(1);
    // Nothing was left behind. Scoped in practice — this file's other rows are
    // either paid (excluded by `provider_object_id`) or already cleared — and it
    // is the job's own account of whether the release worked.
    expect(page.stillWithheld).toBe(0);

    const settled = await transferFor(scenario);
    // Absent the sweep there is no automatic exit from a hold at all: this would
    // still be NULL, and would stay NULL until an operator ran a repair.
    expect(settled.providerObjectId).toBeTruthy();
    expect(settled.status).toBe('paid');
    expect(api.transferCalls).toHaveLength(1);
    // The release re-entered SETTLEMENT rather than transferring by itself, so
    // the ledger leg is booked by the same code path that books it on the
    // ordinary path. A second money-moving path would be the thing that drifts.
    expect(await transferPostings(scenario.orderId)).toHaveLength(1);
    expect(await payableBalance(scenario.orderId)).toBe(0n);
  });

  it('SPENDS the hold on a permanent failure, so the pass does not repeat it forever', async () => {
    const scenario = await seedScenario('permanent', { ready: true, totalMinor: HELD_TOTAL });
    const held = await transferFor(scenario);

    // The seller's account lapses while the transfer waits. Only the STORED
    // verdict is moved, because that is what settlement reads on this path — the
    // rail is consulted by the operator repair, not by the sweep.
    await setAccountState(scenario.accountRowId, false);
    await expireHold(held.id);
    expect(await isReleasable(held.id)).toBe(true);

    const first = await releaseWithheldTransfersPage({ cursor: null, limit: 25 });
    expect(first.scanned).toBeGreaterThanOrEqual(1);
    // The job's own count of holds it released that did not result in a payment.
    expect(first.stillWithheld).toBeGreaterThanOrEqual(1);

    const after = await transferFor(scenario);
    // The money did not move — readiness is still required, and a released hold
    // is not permission to skip that gate.
    expect(after.providerObjectId).toBeNull();
    expect(api.transferCalls).toHaveLength(0);
    // …and the hold is SPENT. Delete `clearTransferHold` from the job and this
    // reports the same past instant it had before the pass, which is the
    // retry-forever the column exists to prevent: one settlement attempt against
    // a permanently unpayable seller on every pass, for the life of the row.
    expect(after.heldUntil).toBeNull();
    expect(await isReleasable(after.id)).toBe(false);

    // The observable consequence, stated as the sweep sees it: a second pass
    // does not touch this transfer.
    const second = await releaseWithheldTransfersPage({ cursor: null, limit: 25 });
    expect(second.stillWithheld).toBe(0);
    const unchanged = await transferFor(scenario);
    expect(unchanged.providerObjectId).toBeNull();
    expect(unchanged.heldUntil).toBeNull();
    expect(api.transferCalls).toHaveLength(0);

    // The exception an operator reads is still the one settlement wrote when the
    // hold was imposed — one case per withheld seller, not one per pass.
    expect(await withheldExceptionsFor(scenario.paymentId)).toHaveLength(1);
  });
});

describe('the operator repair', () => {
  it('releases a hold EARLY, because the operator running it is the review', async () => {
    const scenario = await seedScenario('repair-release', { ready: true, totalMinor: HELD_TOTAL });
    const held = await transferFor(scenario);
    // The window has NOT passed: the sweep would not select this row, and the
    // repair is the only way out at this moment.
    expect(held.heldUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(await isReleasable(held.id)).toBe(true);

    const result = await runRepair({
      action: 'retry_withheld_transfer',
      actorOxyUserId: OPERATOR,
      reason: 'Reviewed the buyer and the seller; this payout is good to go now.',
      paymentId: scenario.paymentId,
      orderId: scenario.orderId,
    });

    // Absent `clearTransferHold` in the repair, settlement would read
    // `held_until` straight back and withhold the transfer again: this would be
    // `no_op`, `providerObjectId` would be NULL, and the reviewer's decision
    // would have no effect until the window ran out on its own.
    expect(result.outcome).toBe('applied');
    const settled = await transferFor(scenario);
    expect(settled.providerObjectId).toBeTruthy();
    expect(settled.status).toBe('paid');
    expect(settled.heldUntil).toBeNull();
    expect(api.transferCalls).toHaveLength(1);
    expect(await payableBalance(scenario.orderId)).toBe(0n);

    const [audit] = await repairsFor(`${scenario.paymentId}:${scenario.orderId}`);
    expect(audit?.outcome).toBe('applied');
    expect(audit?.actorOxyUserId).toBe(OPERATOR);
  });

  it('REFUSES on an unready seller and leaves the hold in force', async () => {
    const scenario = await seedScenario('repair-refused', { ready: true, totalMinor: HELD_TOTAL });
    const held = await transferFor(scenario);
    expect(held.heldUntil).not.toBeNull();

    // The seller lapses at the RAIL. The stored row still says `ready`, so a
    // repair that trusted the local copy would send money at an account Stripe
    // will refuse.
    setRailAccount(scenario.providerAccountId, false);

    await expect(
      runRepair({
        action: 'retry_withheld_transfer',
        actorOxyUserId: OPERATOR,
        reason: 'Releasing the hold early on a seller whose account has since lapsed.',
        paymentId: scenario.paymentId,
        orderId: scenario.orderId,
      }),
    ).rejects.toThrow(RepairRefusedError);

    const after = await transferFor(scenario);
    expect(after.providerObjectId).toBeNull();
    expect(api.transferCalls).toHaveLength(0);
    // The hold survives the refusal, because `clearTransferHold` sits AFTER the
    // readiness gate. Move it above and this reports NULL: the transfer would
    // leave the sweep's population without ever having been paid, so the one
    // exit that does not need an operator would be gone — money stranded by the
    // very action taken to release it.
    expect(after.heldUntil?.getTime()).toBe(held.heldUntil?.getTime());
    expect(await isReleasable(after.id)).toBe(true);

    // Declining to act on somebody's money is an action, and it is audited.
    const [audit] = await repairsFor(`${scenario.paymentId}:${scenario.orderId}`);
    expect(audit?.outcome).toBe('refused');
    expect(audit?.actorOxyUserId).toBe(OPERATOR);
  });
});
