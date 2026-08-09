/**
 * The four named operator repairs (#50), against a REAL Postgres and a fake Stripe.
 *
 * ## The two properties this file exists to pin
 *
 * **Acceptance 5** — no recovery action may mark a payment successful without
 * verified provider evidence. It is held structurally (nothing in
 * `repairs.service.ts` calls `applyPaymentStatus`) and again by a refusal, and a
 * structural property needs a test that would notice if the structure changed:
 * `refuses to settle a seller out of a charge that has not been funded` is that
 * test, and it drives a REAL repair against a REAL unpaid payment.
 *
 * **Acceptance 2** — every repair is idempotent, auditable and ledger-safe. The
 * audit half is asserted on every arm below (a `payment_repairs` row with the
 * actor and the reason, for refusals too); the idempotency half is asserted where
 * each action actually gets it — from the underlying service's provider key for
 * the retries, and from a partial unique index for the correcting entry.
 *
 * ## Why a real database
 *
 * `book_reconciling_entry`'s whole safety story is one partial unique index and
 * one transaction: the claim and the posting commit together, so a duplicate
 * loses the index race and rolls both back. A mocked `insert` accepts the second
 * one and returns whatever the test wired, which is precisely the shape of bug
 * that ends with a correction booked twice.
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL.
 * Every id here carries this run's own suffix and every assertion is scoped to
 * rows this file wrote.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** The order's grand total, in EUR cents. */
const ORDER_TOTAL = 4_000;
/** What Stripe keeps on the charge. Mercaria's cost (ADR 0001 D5). */
const CHARGE_FEE = 116;
/** The Oxy account every repair below is run as. */
const OPERATOR = `oxy-operator-${RUN}`;

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
    // it is presented. This is the property the retry repairs rely on instead of
    // recording a claim of their own, so the fake has to honour it or the
    // idempotency assertions below would be measuring the fake.
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);
    api.nextId += 1;
    const transfer = {
      id: `tr_repair_${String(api.nextId)}`,
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
let runRepair: typeof import('../repairs.service.js').runRepair;
let RepairRefusedError: typeof import('../repairs.service.js').RepairRefusedError;
let reportDiscrepancy: typeof import('../discrepancy.service.js').reportDiscrepancy;
let findPaymentById: typeof import('../../../../db/payments/paymentRepository.js').findPaymentById;
let findTransferForOrder: typeof import('../../../../db/payments/paymentRepository.js').findTransferForOrder;
let findDiscrepancyById: typeof import('../../../../db/payments/discrepancyRepository.js').findDiscrepancyById;
let insertStore: typeof import('../../../../db/stores/storeRepository.js').insertStore;
let insertLocation: typeof import('../../../../db/stores/locationRepository.js').insertLocation;
let insertVariants: typeof import('../../../../db/catalog/variantRepository.js').insertVariants;
let setAvailable: typeof import('../../../inventory.service.js').setAvailable;
let insertOrder: typeof import('../../../../db/orders/orderRepository.js').insertOrder;
let nextOrderNumber: typeof import('../../../../db/orders/orderRepository.js').nextOrderNumber;
let insertProviderAccount: typeof import('../../../../db/payments/providerAccountRepository.js').insertProviderAccount;
let applyProviderAccountState: typeof import('../../../../db/payments/providerAccountRepository.js').applyProviderAccountState;
let findProviderAccountByOwner: typeof import('../../../../db/payments/providerAccountRepository.js').findProviderAccountByOwner;
let reconciliationSchema: typeof import('../../../../db/schema/reconciliation.js');
let ledgerSchema: typeof import('../../../../db/schema/ledger.js');
let catalogSchema: typeof import('../../../../db/schema/catalog.js');

beforeAll(async () => {
  // Set BEFORE importing anything that reads config — `config/index.ts` reads
  // process.env once at module load and freezes the result, and vitest reuses a
  // worker PROCESS across files, so a sibling's write survives into this one.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_repairs_not_a_real_one';
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_repairs_connect';
  process.env.STRIPE_PLATFORM_CURRENCY = 'EUR';
  process.env.STRIPE_PRESENTMENT_CURRENCIES = 'EUR,USD';

  const postgres = await import('../../../../db/postgres.js');
  db = await postgres.connectPostgres();
  ({ closePostgres } = postgres);
  ({ ensurePayment, applyPaymentStatus } = await import('../../payment.service.js'));
  ({ runRepair, RepairRefusedError } = await import('../repairs.service.js'));
  ({ reportDiscrepancy } = await import('../discrepancy.service.js'));
  ({ findPaymentById, findTransferForOrder } = await import(
    '../../../../db/payments/paymentRepository.js'
  ));
  ({ findDiscrepancyById } = await import('../../../../db/payments/discrepancyRepository.js'));
  ({ insertStore } = await import('../../../../db/stores/storeRepository.js'));
  ({ insertLocation } = await import('../../../../db/stores/locationRepository.js'));
  ({ insertVariants } = await import('../../../../db/catalog/variantRepository.js'));
  ({ setAvailable } = await import('../../../inventory.service.js'));
  ({ insertOrder, nextOrderNumber } = await import('../../../../db/orders/orderRepository.js'));
  ({ insertProviderAccount, applyProviderAccountState, findProviderAccountByOwner } = await import(
    '../../../../db/payments/providerAccountRepository.js'
  ));
  reconciliationSchema = await import('../../../../db/schema/reconciliation.js');
  ledgerSchema = await import('../../../../db/schema/ledger.js');
  catalogSchema = await import('../../../../db/schema/catalog.js');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  api.intents.clear();
  api.charges.clear();
  api.transfers.clear();
  api.byKey.clear();
  api.accounts.clear();
  api.transferCalls.length = 0;
});

/** A EUR `DualMoney` whose two sides are equal — no conversion in play. */
function eur(amount: number) {
  return {
    shop: { amount, currency: 'EUR' as const },
    presentment: { amount, currency: 'EUR' as const },
  };
}

/** Every repair row written for one subject, newest first. */
async function repairsFor(subjectKey: string) {
  return await db
    .select()
    .from(reconciliationSchema.paymentRepairs)
    .where(eq(reconciliationSchema.paymentRepairs.subjectKey, subjectKey));
}

/**
 * A store, an order and a payment, with the seller's account in a chosen state.
 *
 * `ready: false` is what produces a WITHHELD transfer: readiness is checked
 * between the buyer paying and the transfer executing (ADR 0001 D4), so a seller
 * who is `restricted` at that moment has their share held back while the order
 * stays paid. That is the exact condition `retry_withheld_transfer` answers, and
 * it is produced by driving the real success path rather than by writing a
 * `pending` transfer row directly.
 */
async function seedScenario(label: string, options: { ready: boolean; settle?: boolean }) {
  const suffix = `${label}-${RUN}-${uuidv7()}`;
  const ownerId = `owner-${suffix}`;
  // From the uuid's TAIL, not the label's head: `acct_` ids are bounded, and
  // truncating a `<label>-<run>-<uuid>` suffix from the FRONT makes two
  // scenarios that share a label collide on `UNIQUE(provider, provider_account_id)`.
  const providerAccountId = `acct_${suffix.replace(/-/g, '').slice(-24)}`;
  const store = await insertStore(
    {
      handle: `repair-${suffix}`,
      name: 'Repair store',
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
      recipientName: 'Repair store',
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
  // What the rail will say when the repair re-reads the account. Distinct from
  // the stored row on purpose: the repair's whole point is that it does NOT
  // trust the local copy, which a six-hour sweep may have left stale.
  setRailAccount(providerAccountId, options.ready);

  const [listing] = await db
    .insert(catalogSchema.listings)
    .values({
      ownerType: 'store',
      storeId: store.id,
      title: 'Repairable',
      description: '',
      condition: 'new',
    })
    .returning({ id: catalogSchema.listings.id });
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: ORDER_TOTAL,
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
    storeId: store.id,
    items: [
      {
        listingId: listing.id,
        variantId: variant.id,
        title: 'Repairable',
        variantTitle: 'Default',
        optionValues: [],
        unitPrice: eur(ORDER_TOTAL),
        quantity: 1,
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
  });

  const intentId = `pi_${suffix.replace(/-/g, '')}`;
  const chargeId = `ch_${suffix.replace(/-/g, '')}`;
  api.intents.set(intentId, {
    id: intentId,
    object: 'payment_intent',
    status: 'succeeded',
    amount: ORDER_TOTAL,
    currency: 'eur',
    latest_charge: chargeId,
    metadata: {},
  });
  api.charges.set(chargeId, {
    id: chargeId,
    object: 'charge',
    amount: ORDER_TOTAL,
    currency: 'eur',
    amount_refunded: 0,
    balance_transaction: {
      id: `txn_${chargeId}`,
      object: 'balance_transaction',
      amount: ORDER_TOTAL,
      currency: 'eur',
      fee: CHARGE_FEE,
      exchange_rate: null,
      created: Math.floor(Date.now() / 1_000),
    },
  });

  const payment = await ensurePayment({
    provider: 'stripe',
    checkoutGroupId,
    presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
    buyerOxyUserId: `buyer-${suffix}`,
    providerObjectId: intentId,
  });

  if (options.settle !== false) {
    // The real success path: books `charge_succeeded`, drains the outbox inline,
    // marks the order paid and attempts settlement — which WITHHOLDS when the
    // account is not ready.
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: intentId,
      platform: {
        amount: { amount: ORDER_TOTAL, currency: 'EUR' },
        rate: {
          from: 'EUR',
          to: 'EUR',
          rate: 1,
          provider: 'stripe',
          asOf: new Date().toISOString(),
        },
      },
    });
  }

  return { suffix, store, orderId: order.id, paymentId: payment.id, providerAccountId };
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

describe('retry_withheld_transfer', () => {
  it('settles a withheld order once the seller is ready AT THE RAIL, and closes the payable', async () => {
    const scenario = await seedScenario('withheld', { ready: false });

    // The precondition: the buyer is paid, the order is paid, and the seller's
    // share is held back with the payable OPEN in their favour (ADR 0001 D4).
    const withheld = await findTransferForOrder(db, scenario.paymentId, scenario.orderId);
    expect(withheld?.status).toBe('pending');
    expect(withheld?.providerObjectId).toBeNull();
    expect(await payableBalance(scenario.orderId)).toBeLessThan(0n);

    const discrepancy = await reportDiscrepancy({
      kind: 'merchant_payable_unexplained',
      provider: 'stripe',
      correlationKey: `${scenario.orderId}:EUR`,
      orderId: scenario.orderId,
      detail: { currency: 'EUR' },
    });

    // The seller fixes their account. The STORED row still says `restricted` —
    // a six-hour sweep has not run — so a repair that trusted the local copy
    // would refuse a transfer the rail would now accept.
    setRailAccount(scenario.providerAccountId, true);

    const result = await runRepair({
      action: 'retry_withheld_transfer',
      actorOxyUserId: OPERATOR,
      reason: 'Seller completed their outstanding Stripe requirements.',
      discrepancyId: discrepancy.id,
      paymentId: scenario.paymentId,
      orderId: scenario.orderId,
    });

    expect(result.outcome).toBe('applied');

    // The transfer exists at the rail and the payable is closed — which is the
    // whole of "the money reached the seller" in this system.
    const settled = await findTransferForOrder(db, scenario.paymentId, scenario.orderId);
    expect(settled?.providerObjectId).toBeTruthy();
    expect(settled?.status).toBe('paid');
    expect(await payableBalance(scenario.orderId)).toBe(0n);

    // The local row was re-read from the rail, not trusted.
    const account = await findProviderAccountByOwner(db, {
      provider: 'stripe',
      ownerType: 'store',
      ownerId: scenario.store.id,
    });
    expect(account?.onboardingState).toBe('ready');

    // Audited: an actor, a reason and the outcome.
    const [audit] = await repairsFor(`${scenario.paymentId}:${scenario.orderId}`);
    expect(audit?.actorOxyUserId).toBe(OPERATOR);
    expect(audit?.outcome).toBe('applied');
    expect(audit?.reason).toContain('outstanding Stripe requirements');

    // …and the finding it answered was resolved by the person who ran it.
    const closed = await findDiscrepancyById(db, discrepancy.id);
    expect(closed?.status).toBe('resolved');
    expect(closed?.resolvedBy).toBe(OPERATOR);
  });

  it('is idempotent — a second run moves no more money', async () => {
    const scenario = await seedScenario('withheld-twice', { ready: false });
    setRailAccount(scenario.providerAccountId, true);

    const first = await runRepair({
      action: 'retry_withheld_transfer',
      actorOxyUserId: OPERATOR,
      reason: 'First attempt after the seller recovered their account.',
      paymentId: scenario.paymentId,
      orderId: scenario.orderId,
    });
    const transferCallsAfterFirst = api.transferCalls.length;

    const second = await runRepair({
      action: 'retry_withheld_transfer',
      actorOxyUserId: OPERATOR,
      reason: 'Second attempt, to prove this is safe to re-run.',
      paymentId: scenario.paymentId,
      orderId: scenario.orderId,
    });

    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('no_op');
    // The rail was not asked again: the local `transfers` row already carries a
    // provider object, so the repair short-circuits before the settlement runs.
    expect(api.transferCalls).toHaveLength(transferCallsAfterFirst);
    // ONE transfer, which is `UNIQUE(payment_id, order_id)` doing its job — the
    // constraint standing between a settlement retry and money leaving twice.
    const transfers = await db
      .select()
      .from((await import('../../../../db/schema/payments.js')).transfers)
      .where(
        eq(
          (await import('../../../../db/schema/payments.js')).transfers.orderId,
          scenario.orderId,
        ),
      );
    expect(transfers).toHaveLength(1);

    // Both attempts are on the record. One row per ATTEMPT is what makes this an
    // audit trail rather than a status column.
    expect(await repairsFor(`${scenario.paymentId}:${scenario.orderId}`)).toHaveLength(2);
  });

  it('refuses while the seller is still unready at the rail, and records the refusal', async () => {
    const scenario = await seedScenario('still-unready', { ready: false });
    // The rail still says `restricted`.

    await expect(
      runRepair({
        action: 'retry_withheld_transfer',
        actorOxyUserId: OPERATOR,
        reason: 'Trying before the seller has actually finished onboarding.',
        paymentId: scenario.paymentId,
        orderId: scenario.orderId,
      }),
    ).rejects.toThrow(RepairRefusedError);

    // Nothing moved…
    const transfer = await findTransferForOrder(db, scenario.paymentId, scenario.orderId);
    expect(transfer?.providerObjectId).toBeNull();
    expect(api.transferCalls).toHaveLength(0);

    // …and the refusal is on the record with its actor and reason. Declining to
    // act on somebody's money is an action (#50, repair invariant 9).
    const [audit] = await repairsFor(`${scenario.paymentId}:${scenario.orderId}`);
    expect(audit?.outcome).toBe('refused');
    expect(audit?.actorOxyUserId).toBe(OPERATOR);
    expect(String(audit?.detail)).toBeTruthy();
  });

  it('refuses to settle a seller out of a charge that has not been funded', async () => {
    // ACCEPTANCE 5, driven end to end. The payment is `created` — the buyer has
    // not paid — and the rail is not consulted at all, because no answer it
    // could give would make transferring a seller their share of money the
    // platform never received correct.
    const scenario = await seedScenario('unfunded', { ready: true, settle: false });
    const before = await findPaymentById(db, scenario.paymentId);
    expect(before?.status).toBe('created');

    await expect(
      runRepair({
        action: 'retry_withheld_transfer',
        actorOxyUserId: OPERATOR,
        reason: 'Attempting to settle a seller before the buyer has paid.',
        paymentId: scenario.paymentId,
        orderId: scenario.orderId,
      }),
    ).rejects.toThrow(/has not received/);

    // The payment's status is UNCHANGED — nothing here may mark one successful.
    const after = await findPaymentById(db, scenario.paymentId);
    expect(after?.status).toBe('created');
    expect(api.transferCalls).toHaveLength(0);

    const [audit] = await repairsFor(`${scenario.paymentId}:${scenario.orderId}`);
    expect(audit?.outcome).toBe('refused');
    expect(audit?.detail).toMatchObject({ status: 'created' });
  });
});

describe('book_reconciling_entry', () => {
  it('books a balanced correction, links it to the finding, and refuses a second one', async () => {
    const discrepancy = await reportDiscrepancy({
      kind: 'merchant_payable_unexplained',
      provider: 'stripe',
      correlationKey: `manual-${RUN}-${uuidv7()}`,
      detail: { currency: 'EUR' },
    });

    const first = await runRepair({
      action: 'book_reconciling_entry',
      actorOxyUserId: OPERATOR,
      reason: 'Writing off an unrecoverable seller balance after a failed reversal.',
      discrepancyId: discrepancy.id,
      currency: 'EUR',
      entries: [
        { account: 'merchant_payable', amountMinor: -500n, ownerType: 'store', ownerId: 'store-x' },
        { account: 'commission_revenue', amountMinor: 500n },
      ],
    });

    expect(first.outcome).toBe('applied');
    expect(first.ledgerTransactionId).toBeTruthy();

    // A NEW `adjustment` transaction — the only mechanism the ledger has for a
    // mistake. Nothing was edited; the append-only trigger would have refused it.
    const [transaction] = await db
      .select()
      .from(ledgerSchema.ledgerTransactions)
      .where(eq(ledgerSchema.ledgerTransactions.id, first.ledgerTransactionId ?? ''));
    expect(transaction?.kind).toBe('adjustment');
    expect(transaction?.description).toContain('unrecoverable seller balance');

    // A second identical correction is refused by the partial unique index, in
    // the same transaction as the posting — so the duplicate rolls BOTH back.
    const second = await runRepair({
      action: 'book_reconciling_entry',
      actorOxyUserId: OPERATOR,
      reason: 'Re-running the same correction, e.g. after a client timeout.',
      discrepancyId: discrepancy.id,
      currency: 'EUR',
      entries: [
        { account: 'merchant_payable', amountMinor: -500n, ownerType: 'store', ownerId: 'store-x' },
        { account: 'commission_revenue', amountMinor: 500n },
      ],
    });

    expect(second.outcome).toBe('no_op');
    // Still ONE transaction against this discrepancy — which is the property the
    // index exists for, since a correcting entry has no provider key to converge
    // on the way the three retry actions do.
    const applied = await db
      .select()
      .from(reconciliationSchema.paymentRepairs)
      .where(
        and(
          eq(reconciliationSchema.paymentRepairs.subjectKey, discrepancy.id),
          eq(reconciliationSchema.paymentRepairs.outcome, 'applied'),
        ),
      );
    expect(applied).toHaveLength(1);
  });

  it('refuses an UNBALANCED correction and writes nothing', async () => {
    const discrepancy = await reportDiscrepancy({
      kind: 'ledger_unbalanced',
      provider: 'stripe',
      correlationKey: `unbalanced-${RUN}-${uuidv7()}`,
      detail: { currency: 'EUR' },
    });

    await expect(
      runRepair({
        action: 'book_reconciling_entry',
        actorOxyUserId: OPERATOR,
        reason: 'An operator getting one leg wrong, which must not reach the book.',
        discrepancyId: discrepancy.id,
        currency: 'EUR',
        entries: [
          { account: 'merchant_payable', amountMinor: -500n },
          { account: 'commission_revenue', amountMinor: 499n },
        ],
      }),
    ).rejects.toThrow(RepairRefusedError);

    // The repository refuses before issuing any SQL, so there is nothing to
    // clean up — no transaction, and no `applied` claim on the discrepancy.
    const repairs = await repairsFor(discrepancy.id);
    expect(repairs.filter((row) => row.outcome === 'applied')).toEqual([]);
  });

  it('refuses a correction that names no discrepancy that exists', async () => {
    // An unexplained movement is the one thing the ledger may not contain, so a
    // correcting entry has to name the finding it answers. The database enforces
    // it too (a CHECK plus a foreign key); this is the surface refusing first,
    // with a message an operator can act on.
    await expect(
      runRepair({
        action: 'book_reconciling_entry',
        actorOxyUserId: OPERATOR,
        reason: 'Booking a correction against a finding that does not exist.',
        discrepancyId: `missing-${RUN}`,
        currency: 'EUR',
        entries: [
          { account: 'merchant_payable', amountMinor: -100n },
          { account: 'commission_revenue', amountMinor: 100n },
        ],
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('the retry repairs that guard a terminal state', () => {
  it('retry_provider_refund refuses a refund whose money is still moving', async () => {
    // `pending` means the outbox is still going to move it, so re-issuing now
    // would race that. The guard is what makes this an operator DECISION about a
    // refusal that has already happened, rather than a second retry loop.
    const refund = await seedRefundRow('pending');

    await expect(
      runRepair({
        action: 'retry_provider_refund',
        actorOxyUserId: OPERATOR,
        reason: 'Re-issuing a refund the rail has not actually refused yet.',
        refundId: refund.id,
      }),
    ).rejects.toThrow(/has not been refused/);

    const [audit] = await repairsFor(refund.id);
    expect(audit?.outcome).toBe('refused');
    expect(audit?.actorOxyUserId).toBe(OPERATOR);
  });

  it('retry_transfer_reversal refuses a refund whose buyer has not been paid', async () => {
    // There is no seller share to recover until the buyer actually has their
    // money — ADR 0001 D7 orders the two movements, and reversing first would
    // take a seller's money for a refund that never happened.
    const refund = await seedRefundRow('pending');

    await expect(
      runRepair({
        action: 'retry_transfer_reversal',
        actorOxyUserId: OPERATOR,
        reason: 'Recovering from a seller before the buyer has been refunded.',
        subjectKind: 'refund',
        subjectId: refund.id,
      }),
    ).rejects.toThrow(/not 'succeeded'/);

    const [audit] = await repairsFor(`refund:${refund.id}`);
    expect(audit?.outcome).toBe('refused');
  });

  it('refuses every action that names a subject which does not exist', async () => {
    // Four arms, one property: a repair that cannot see what it is repairing
    // must not report success. The `book_reconciling_entry` arm is covered
    // above, since its subject is a discrepancy rather than a payment object.
    await expect(
      runRepair({
        action: 'retry_provider_refund',
        actorOxyUserId: OPERATOR,
        reason: 'Naming a refund that was never created.',
        refundId: `no-such-refund-${RUN}`,
      }),
    ).rejects.toThrow(/does not exist/);

    await expect(
      runRepair({
        action: 'retry_transfer_reversal',
        actorOxyUserId: OPERATOR,
        reason: 'Naming a dispute that was never opened.',
        subjectKind: 'dispute',
        subjectId: `no-such-dispute-${RUN}`,
      }),
    ).rejects.toThrow(/does not exist/);

    await expect(
      runRepair({
        action: 'retry_withheld_transfer',
        actorOxyUserId: OPERATOR,
        reason: 'Naming a payment that was never opened.',
        paymentId: `no-such-payment-${RUN}`,
        orderId: `no-such-order-${RUN}`,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

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

/**
 * A committed refund row in a chosen provider state, with no rail behind it.
 *
 * Enough for the GUARD tests above and deliberately no more: what they assert is
 * that a repair refuses before touching anything, which is decided from the
 * refund row alone. The money-moving arms of these two actions belong to #49's
 * `refund-lifecycle.realdb.test.ts`, which already builds the full charge,
 * transfer and reversal fixture they need.
 */
async function seedRefundRow(providerState: 'pending' | 'failed') {
  const scenario = await seedScenario(`refund-${providerState}`, { ready: true });
  const orderSchema = await import('../../../../db/schema/orders.js');
  const [row] = await db
    .insert(orderSchema.refunds)
    .values({
      orderId: scenario.orderId,
      storeId: scenario.store.id,
      rmaNumber: `RMA-${RUN}-${String(api.nextId++)}`,
      reason: 'other',
      status: 'refunded',
      totalRefundedShopAmount: ORDER_TOTAL,
      totalRefundedShopCurrency: 'EUR',
      totalRefundedPresentmentAmount: ORDER_TOTAL,
      totalRefundedPresentmentCurrency: 'EUR',
      provider: 'stripe',
      providerState,
      paymentId: scenario.paymentId,
    })
    .returning();
  if (!row) throw new Error('the refund fixture was not written');
  return row;
}
