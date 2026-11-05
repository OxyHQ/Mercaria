/**
 * Reconciliation detection and convergence (#50), against a REAL Postgres and a
 * fake Peable gateway (`payments/__tests__/helpers/fake-peable-gateway.ts`).
 *
 * ## Why none of it can be mocked
 *
 * Every property asserted here is a property of the DATABASE. A repeated finding
 * is one row because a unique index on `(kind, correlation_key)` made the second
 * insert an update; a convergence books its ledger entries because
 * `applyPaymentStatus` ran inside a real transaction; an interrupted pass
 * resumes because a cursor row survived. A mocked `insert` accepts every one of
 * those and returns whatever the test wired — the blind spot `AGENTS.md` records
 * for the moderation writes, and the money here is larger.
 *
 * ## What IS mocked, and only that
 *
 * `peable/client.js`, the single module that talks to the gateway, and the one
 * config flag that switches the rail on. Everything above it — the Peable
 * adapter, the sweeps, the discrepancy recorder, the payment state machine, the
 * ledger and the outbox — is the real code. The open-payment sweep reads the
 * rail through the PORT (ADR 0009 D16), and the port reports a status and no
 * amounts, so statuses are all this file can compare.
 *
 * ## Fixtures are scoped, never truncated, and the sweeps are aimed
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL, so
 * nothing here truncates a table another file uses. That constrains how the
 * SWEEPS are driven, not just how the assertions are written: `reconcileOnePayment`
 * is called directly wherever the subject is one payment, because the paging
 * variant scans every open Peable payment in the database and would sweep
 * whatever a sibling file happened to have in flight. Where a page IS the
 * subject — the cursor test — it does sweep them, and it is safe because the
 * fake gateway knows only this file's intents: a sibling's payment reads as
 * `resource_missing`, which the sweep treats as an unreadable rail and records
 * nothing for. What that case asserts is about READS — every payment read at
 * most once in a pass — never a count of rows somebody else owns.
 *
 * The LEDGER AUDIT was the gap in that rule (#260). `auditLedgerPage` runs two
 * GLOBAL checks whenever its cursor is null, and the only thing bounding the
 * worse of them — `auditOpenPayables`, an aggregate over the whole of
 * `ledger_entries` — is the age buffer this file sets to ZERO below. So one
 * `cursor: null` reported `merchant_payable_unexplained` for every unexplained
 * open payable in the database and, because the recorder upserts and reopens,
 * DESTROYED resolutions `repairs.realdb.test.ts` had just asserted. The payment
 * scan is now aimed from a cursor floor so those checks do not run at all, and
 * the one case whose subject IS the global sweep's silence holds the
 * reconciliation-sweep slot for the file's whole run.
 *
 * Every assertion is scoped to rows this file wrote, which is the stronger form
 * anyway: a count over a whole table passes for the wrong reason the moment a
 * fixture is added elsewhere.
 *
 * ## An unscoped METRIC is held to a scoped LOWER BOUND (#276)
 *
 * `collectPaymentMetrics` is an aggregate over whole tables by design — that is
 * what the operator endpoint is for — so the metrics case cannot scope what it
 * reads. It scopes what it CLAIMS instead: the count it asserts is a floor
 * computed from the payments this run owns, never a difference between two
 * readings. A difference is a claim about every other file's rows too, and one
 * of them deleting a fixture between the two readings nets this file's own
 * insert to zero.
 *
 * The one deliberate exception is `findGlobalLedgerImbalances`, whose subject IS
 * the whole book: scoping it to this file's rows would leave it unable to
 * report the imbalance it exists for. It is safe unscoped for a reason no other
 * aggregate here has — no concurrent writer can produce one, because the
 * repository refuses an unbalanced set before issuing SQL and a trigger refuses
 * an edit afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, like, lt, max } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { PaymentDiscrepancyKind } from '@mercaria/shared-types';
import {
  acquireReconciliationSweepSlot,
  type ReconciliationSweepSlot,
} from './reconciliation-sweep-slot.js';

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** The order's grand total, in EUR cents. */
const ORDER_TOTAL = 4_000;

/**
 * The fake gateway. Hoisted so the `vi.mock` factory below can close over it —
 * a factory is hoisted above every `const` in this file.
 */
const gateway = await vi.hoisted(async () =>
  (await import('../../__tests__/helpers/fake-peable-gateway.js')).createFakePeableGateway(),
);

/**
 * The Peable rail switched on, and nothing else changed. `PEABLE_ENABLED` also
 * needs an Oxy identity this suite does not have, and the client is faked
 * below anyway, so the flag is set on the frozen config rather than the
 * environment. Every other leaf — the zeroed age buffer below included — is the
 * real config, read from the environment.
 */
vi.mock('../../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      payments: {
        ...actual.config.payments,
        peable: { ...actual.config.payments.peable, enabled: true },
      },
    },
  };
});

vi.mock('../../peable/client.js', () => gateway.clientModule());

type Database = import('../../../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../../../db/postgres.js').closePostgres;
let ensurePayment: typeof import('../../payment.service.js').ensurePayment;
let applyPaymentStatus: typeof import('../../payment.service.js').applyPaymentStatus;
let reconcileOnePayment: typeof import('../open-payments.job.js').reconcileOnePayment;
let auditLedgerPage: typeof import('../ledger-audit.job.js').auditLedgerPage;
let runReconciliationJob: typeof import('../runner.js').runReconciliationJob;
let collectPaymentMetrics: typeof import('../metrics.service.js').collectPaymentMetrics;
let ledgerImbalanceAttempts: typeof import('../../../../db/payments/ledgerRepository.js').ledgerImbalanceAttempts;
let findGlobalLedgerImbalances: typeof import('../../../../db/payments/ledgerRepository.js').findGlobalLedgerImbalances;
let insertLedgerTransaction: typeof import('../../../../db/payments/ledgerRepository.js').insertLedgerTransaction;
let findOpenMerchantPayables: typeof import('../../../../db/payments/ledgerRepository.js').findOpenMerchantPayables;
let claimReconciliationRun: typeof import('../../../../db/payments/reconciliationCursorRepository.js').claimReconciliationRun;
let releaseReconciliationRun: typeof import('../../../../db/payments/reconciliationCursorRepository.js').releaseReconciliationRun;
let findPaymentById: typeof import('../../../../db/payments/paymentRepository.js').findPaymentById;
let deleteReconciliationCursor: typeof import('../../../../db/payments/reconciliationCursorRepository.js').deleteReconciliationCursor;
let listReconciliationCursors: typeof import('../../../../db/payments/reconciliationCursorRepository.js').listReconciliationCursors;
let insertStore: typeof import('../../../../db/stores/storeRepository.js').insertStore;
let insertLocation: typeof import('../../../../db/stores/locationRepository.js').insertLocation;
let insertVariants: typeof import('../../../../db/catalog/variantRepository.js').insertVariants;
let setAvailable: typeof import('../../../inventory.service.js').setAvailable;
let insertOrder: typeof import('../../../../db/orders/orderRepository.js').insertOrder;
let nextOrderNumber: typeof import('../../../../db/orders/orderRepository.js').nextOrderNumber;
let insertProviderAccount: typeof import('../../../../db/payments/providerAccountRepository.js').insertProviderAccount;
let findProviderAccountByOwner: typeof import('../../../../db/payments/providerAccountRepository.js').findProviderAccountByOwner;
let explainOpenPayable: typeof import('../payable-explanations.js').explainOpenPayable;
let applyProviderAccountState: typeof import('../../../../db/payments/providerAccountRepository.js').applyProviderAccountState;
let sweepSlot: ReconciliationSweepSlot | null = null;
let reconciliationSchema: typeof import('../../../../db/schema/reconciliation.js');
let paymentSchema: typeof import('../../../../db/schema/payments.js');
let catalogSchema: typeof import('../../../../db/schema/catalog.js');
let orderSchema: typeof import('../../../../db/schema/orders.js');
let ledgerSchema: typeof import('../../../../db/schema/ledger.js');

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result. Set EXPLICITLY and
  // not inherited — vitest reuses a worker PROCESS across files while giving
  // each its own module registry, so a sibling file's write survives into this
  // one's `config`.
  //
  // Zero, so a payment created a moment ago is already old enough to sweep.
  // The buffer exists to keep buyers who are still paying out of the queue, and
  // a test that waited ten real minutes for it would be a test nobody runs.
  process.env.PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS = '0';

  const postgres = await import('../../../../db/postgres.js');
  db = await postgres.connectPostgres();
  ({ closePostgres } = postgres);
  ({ ensurePayment, applyPaymentStatus } = await import('../../payment.service.js'));
  ({ reconcileOnePayment } = await import('../open-payments.job.js'));
  ({ auditLedgerPage } = await import('../ledger-audit.job.js'));
  ({ runReconciliationJob } = await import('../runner.js'));
  ({ collectPaymentMetrics } = await import('../metrics.service.js'));
  ({
    ledgerImbalanceAttempts,
    findGlobalLedgerImbalances,
    insertLedgerTransaction,
    findOpenMerchantPayables,
  } = await import('../../../../db/payments/ledgerRepository.js'));
  ({ findPaymentById } = await import('../../../../db/payments/paymentRepository.js'));
  ({ claimReconciliationRun, releaseReconciliationRun } = await import(
    '../../../../db/payments/reconciliationCursorRepository.js'
  ));
  ({ deleteReconciliationCursor, listReconciliationCursors } = await import(
    '../../../../db/payments/reconciliationCursorRepository.js'
  ));
  ({ insertStore } = await import('../../../../db/stores/storeRepository.js'));
  ({ insertLocation } = await import('../../../../db/stores/locationRepository.js'));
  ({ insertVariants } = await import('../../../../db/catalog/variantRepository.js'));
  ({ setAvailable } = await import('../../../inventory.service.js'));
  ({ insertOrder, nextOrderNumber } = await import('../../../../db/orders/orderRepository.js'));
  ({ insertProviderAccount, applyProviderAccountState, findProviderAccountByOwner } = await import(
    '../../../../db/payments/providerAccountRepository.js'
  ));
  ({ explainOpenPayable } = await import('../payable-explanations.js'));
  reconciliationSchema = await import('../../../../db/schema/reconciliation.js');
  paymentSchema = await import('../../../../db/schema/payments.js');
  catalogSchema = await import('../../../../db/schema/catalog.js');
  orderSchema = await import('../../../../db/schema/orders.js');
  ledgerSchema = await import('../../../../db/schema/ledger.js');

  // Held for this file's WHOLE run, after the pool exists. The zeroed age buffer
  // above is what makes the ledger audit's payable check reach every open
  // payable in the shared database, so for as long as this file may drive it,
  // `payment_discrepancies` is exclusively ours — see
  // `reconciliation-sweep-slot.ts` for the collision it prevents.
  sweepSlot = await acquireReconciliationSweepSlot(db);
}, 120_000);

afterAll(async () => {
  /**
   * Release BEFORE closing the pool: the lock is held on a connection reserved
   * out of that pool, and ending the pool first would make the unlock the last
   * thing to run against a closed client.
   *
   * NESTED, because `release()` can throw and `closePostgres` is what actually
   * ends the hold. `reserved.release()` inside the mutex returns the connection
   * to the pool and does NOT end the session — measured (#272): the advisory
   * lock is still held after a check-in and gone only after `sql.end()`. So an
   * unlock that threw would abort this hook one line short of the only
   * statement that frees the slot, and the sibling waiting on it would block
   * its whole `beforeAll` budget and fail having done nothing wrong.
   */
  try {
    if (sweepSlot) await sweepSlot.release();
  } finally {
    await closePostgres();
  }
});

beforeEach(() => {
  // Only the in-memory rail is reset. Nothing in Postgres is deleted — see the
  // file docblock on why a realdb file may not truncate.
  gateway.reset();
});

/**
 * The largest payment id STRICTLY BELOW `paymentId`, as a cursor to aim the
 * ledger audit's payment scan at this file's own fixture.
 *
 * Computed against the fixture's own id rather than as a `max(id)` taken before
 * it, because `@oxy.so/db`'s uuid v7 keys are NOT monotonic within a millisecond
 * (~50% inversion measured): a floor minted moments earlier can sort ABOVE the
 * row it is supposed to sit below, which would silently scan nothing. Comparing
 * against the id that exists is exact and needs no monotonicity.
 *
 * `null` when the fixture is the smallest payment in the database — which is
 * only reachable when this file runs alone, and then there is nothing older for
 * the global checks to reach either.
 */
async function paymentFloorBelow(paymentId: string): Promise<string | null> {
  const [row] = await db
    .select({ floor: max(paymentSchema.payments.id) })
    .from(paymentSchema.payments)
    .where(lt(paymentSchema.payments.id, paymentId));
  return row?.floor ?? null;
}

/** A EUR `DualMoney` whose two sides are equal — no conversion in play. */
function eur(amount: number) {
  return {
    shop: { amount, currency: 'EUR' as const },
    presentment: { amount, currency: 'EUR' as const },
  };
}

/** Every discrepancy this file wrote for one kind and key — including none. */
async function discrepancyRows(kind: PaymentDiscrepancyKind, correlationKey: string) {
  return await db
    .select()
    .from(reconciliationSchema.paymentDiscrepancies)
    .where(
      and(
        eq(reconciliationSchema.paymentDiscrepancies.kind, kind),
        eq(reconciliationSchema.paymentDiscrepancies.correlationKey, correlationKey),
      ),
    );
}

/**
 * How many `peable`/`EUR`/`succeeded` payments THIS RUN owns.
 *
 * Every checkout group this file mints carries `RUN` — through `seedSeller`'s
 * suffix or written in directly — so this is exactly the rows it created and
 * nothing a sibling file wrote. It is the lower bound the metrics case holds
 * `paymentCountsByStatus` to; see the comment there for why a lower bound and
 * not a difference (#276).
 *
 * Deliberately a row read rather than a `count(*)`: the scoped set is a handful
 * of rows, and reading them avoids the int8-comes-back-as-a-string trap that
 * `CONVENTIONS.md` records for aggregates.
 */
async function ownSucceededPeableEurPayments(): Promise<number> {
  const rows = await db
    .select({ id: paymentSchema.payments.id })
    .from(paymentSchema.payments)
    .where(
      and(
        eq(paymentSchema.payments.provider, 'peable'),
        eq(paymentSchema.payments.presentmentCurrency, 'EUR'),
        eq(paymentSchema.payments.status, 'succeeded'),
        like(paymentSchema.payments.checkoutGroupId, `%${RUN}%`),
      ),
    );
  return rows.length;
}

/** Exactly one discrepancy for that kind and key, or a failure naming what was found. */
async function oneDiscrepancy(kind: PaymentDiscrepancyKind, correlationKey: string) {
  const rows = await db
    .select()
    .from(reconciliationSchema.paymentDiscrepancies)
    .where(
      and(
        eq(reconciliationSchema.paymentDiscrepancies.kind, kind),
        eq(reconciliationSchema.paymentDiscrepancies.correlationKey, correlationKey),
      ),
    );
  expect(rows, `expected exactly one '${kind}' for '${correlationKey}'`).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error('unreachable — the expectation above would have failed');
  return row;
}

/** A store with a payment-ready Peable seller account, and one sellable variant. */
async function seedSeller(label: string) {
  const suffix = `${label}-${RUN}-${uuidv7()}`;
  const ownerId = `owner-${suffix}`;
  const store = await insertStore({
    oxyAccountId: ownerId,
    handle: `recon-${suffix}`,
    name: 'Reconciliation store',
    description: '',
    brandColor: '#123456',
    defaultCurrency: 'EUR',
  });
  const location = await insertLocation(store.id, {
    name: 'Warehouse',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
    address: {
      recipientName: 'Reconciliation store',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
  });

  const account = await insertProviderAccount(db, {
    provider: 'peable',
    ownerType: 'store',
    ownerId: store.id,
    providerAccountId: `ca_${suffix.replace(/-/g, '').slice(-24)}`,
    country: 'ES',
  });
  // Readiness is ONE stored verdict (#46), set through the repository that
  // computes it rather than by writing a boolean.
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

  return { suffix, store, location, ownerId };
}

/** One pending-payment order for a seeded seller, in a fresh checkout group. */
async function seedOrder(
  seller: Awaited<ReturnType<typeof seedSeller>>,
  checkoutGroupId: string,
): Promise<string> {
  const [listing] = await db
    .insert(catalogSchema.listings)
    .values({
      ownerType: 'store',
      storeId: seller.store.id,
      title: 'Reconcilable',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
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
  await setAvailable(variant.id, listing.id, seller.location.id, 10);

  const order = await insertOrder({
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${seller.suffix}`,
    sellerType: 'store',
    commercialRole: 'connected_marketplace',
    storeId: seller.store.id,
    items: [
      {
        listingId: listing.id,
        variantId: variant.id,
        title: 'Reconcilable',
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
  return order.id;
}

/** Register an intent the gateway reports as `succeeded`, nothing refunded. */
function seedSucceededIntent(intentId: string): void {
  gateway.putIntent({
    id: intentId,
    status: 'succeeded',
    amount: BigInt(ORDER_TOTAL),
    currency: 'EUR',
  });
}

/** The settlement figure a succeeded charge is booked with in these fixtures. */
function sameCurrencyPlatform() {
  return {
    amount: { amount: ORDER_TOTAL, currency: 'EUR' as const },
    rate: {
      from: 'EUR' as const,
      to: 'EUR' as const,
      rate: 1,
      provider: 'peable' as const,
      asOf: new Date().toISOString(),
    },
  };
}

describe('the open-payment sweep', () => {
  it('converges a paid PaymentIntent onto an unpaid local payment, through applyPaymentStatus', async () => {
    // Acceptance 1, the case ADR 0001's sequence 6 promises: a
    // `payment_intent.succeeded` that was never delivered. Nothing in Mercaria
    // knows about an event it was not sent, so only a sweep that does not depend
    // on having been told can notice.
    const seller = await seedSeller('converge');
    const checkoutGroupId = `group-converge-${seller.suffix}`;
    const orderId = await seedOrder(seller, checkoutGroupId);
    const intentId = `pi_converge_${seller.suffix.replace(/-/g, '')}`;
    seedSucceededIntent(intentId);

    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      buyerOxyUserId: `buyer-${seller.suffix}`,
      providerObjectId: intentId,
      // The webhook never arrived, so Mercaria is still where checkout left it.
      status: 'processing',
    });

    const outcome = await reconcileOnePayment(payment);

    expect(outcome.converged).toBe(true);
    expect(outcome.providerStatus).toBe('succeeded');

    // The payment moved — and it moved through the WHOLE path, not just its own
    // status column. The ledger transaction and the paid order are what say the
    // sweep used `applyPaymentStatus` rather than writing a status directly; a
    // parallel state writer would have produced neither.
    const after = await findPaymentById(db, payment.id);
    expect(after?.status).toBe('succeeded');
    // Read through the port, which reports a STATUS and no amounts (ADR 0009
    // D16): no settlement figure is invented, and the charge is booked against
    // the presentment amount, exactly as a Peable event would book it.
    expect(after?.platformAmount).toBeNull();
    const charge = await db
      .select({ kind: ledgerSchema.ledgerTransactions.kind })
      .from(ledgerSchema.ledgerTransactions)
      .where(
        and(
          eq(ledgerSchema.ledgerTransactions.paymentId, payment.id),
          eq(ledgerSchema.ledgerTransactions.kind, 'charge_succeeded'),
        ),
      );
    expect(charge).toHaveLength(1);

    const ledger = await db
      .select()
      .from(reconciliationSchema.paymentDiscrepancies)
      .where(eq(reconciliationSchema.paymentDiscrepancies.paymentId, payment.id));
    // The finding was RECORDED and then resolved by the convergence that
    // answered it — an operator should be able to see that a webhook was lost,
    // without being asked to close a row the system already fixed.
    const drift = ledger.find((row) => row.kind === 'payment_provider_paid_local_unpaid');
    expect(drift?.status).toBe('resolved');
    expect(drift?.resolvedBy).toBe('system:reconciliation');
    expect(drift?.resolvedReason).toBe('converged_from_provider');

    const orders = await db
      .select({ status: orderSchema.orders.status })
      .from(orderSchema.orders)
      .where(eq(orderSchema.orders.id, orderId));
    expect(orders[0]?.status).toBe('paid');
  });

  it('records a local-paid / provider-unpaid mismatch and changes NOTHING', async () => {
    // The dangerous direction. Orders have been marked paid, inventory has been
    // committed and a seller may already have been transferred — un-paying that
    // would be a second wrong on top of the first, so it is recorded and left.
    const seller = await seedSeller('reverse');
    const checkoutGroupId = `group-reverse-${seller.suffix}`;
    await seedOrder(seller, checkoutGroupId);
    const intentId = `pi_reverse_${seller.suffix.replace(/-/g, '')}`;
    const intent = gateway.putIntent({
      id: intentId,
      status: 'succeeded',
      amount: BigInt(ORDER_TOTAL),
      currency: 'EUR',
    });

    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      providerObjectId: intentId,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: intentId,
      platform: sameCurrencyPlatform(),
    });

    // …and now the rail says the money never arrived.
    intent.status = 'requires_payment_method';

    const settled = await findPaymentById(db, payment.id);
    if (!settled) throw new Error('the fixture payment vanished');
    const outcome = await reconcileOnePayment(settled);

    expect(outcome.converged).toBe(false);
    const row = await oneDiscrepancy('payment_local_paid_provider_unpaid', payment.id);
    expect(row.severity).toBe('critical');
    expect(row.status).toBe('open');

    // Nothing moved. This is the assertion the whole branch exists for.
    const after = await findPaymentById(db, payment.id);
    expect(after?.status).toBe('succeeded');
  });

  it('bumps one row rather than opening a second when a finding is still true', async () => {
    // The dedupe index IS the queue. Without it a periodic sweep is a row
    // generator, and the loudest discrepancy becomes the oldest rather than the
    // worst. Driven with the one finding a sweep never resolves by itself —
    // local paid, rail unpaid — so the second pass re-confirms rather than
    // converges.
    const seller = await seedSeller('dedupe');
    const checkoutGroupId = `group-dedupe-${seller.suffix}`;
    await seedOrder(seller, checkoutGroupId);
    const intentId = `pi_dedupe_${seller.suffix.replace(/-/g, '')}`;
    const intent = gateway.putIntent({
      id: intentId,
      status: 'succeeded',
      amount: BigInt(ORDER_TOTAL),
      currency: 'EUR',
    });

    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      providerObjectId: intentId,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: intentId,
      platform: sameCurrencyPlatform(),
    });
    intent.status = 'canceled';

    const settled = await findPaymentById(db, payment.id);
    if (!settled) throw new Error('the fixture payment vanished');

    await reconcileOnePayment(settled);
    const first = await oneDiscrepancy('payment_local_paid_provider_unpaid', payment.id);

    await reconcileOnePayment(settled);
    const second = await oneDiscrepancy('payment_local_paid_provider_unpaid', payment.id);

    expect(second.id).toBe(first.id);
    expect(second.occurrences).toBe(2);
    expect(second.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
    // `first_seen_at` never moves — it is how long the problem has run, which is
    // what the operator queue orders and alerts on.
    expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
  });

  it('reports nothing for a refunded payment whose intent still says succeeded', async () => {
    // The false positive the operator surface would otherwise generate on every
    // refunded payment somebody re-fetched: the gateway's PaymentIntent STAYS
    // `succeeded` for life (ADR 0019), refunds being separate objects counted
    // in `amount_refunded` — and a refund the gateway has not counted yet
    // leaves it reading plain `succeeded`. Both sides agree the charge settled;
    // only Mercaria's own refund lifecycle has moved on.
    //
    // The paging sweep cannot reach this (its query excludes terminal statuses),
    // which is exactly why it needs a test — `refetch` is pointed at whatever
    // payment an operator names.
    const seller = await seedSeller('refunded');
    const checkoutGroupId = `group-refunded-${seller.suffix}`;
    await seedOrder(seller, checkoutGroupId);
    const intentId = `pi_refunded_${seller.suffix.replace(/-/g, '')}`;
    seedSucceededIntent(intentId);

    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      providerObjectId: intentId,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: intentId,
      platform: sameCurrencyPlatform(),
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'refunded',
      providerObjectId: intentId,
    });

    const refunded = await findPaymentById(db, payment.id);
    if (!refunded) throw new Error('the fixture payment vanished');
    expect(refunded.status).toBe('refunded');

    const outcome = await reconcileOnePayment(refunded);

    expect(outcome.converged).toBe(false);
    expect(outcome.findings).toBe(0);
    // The premise, asserted: the rail really was read, and really said
    // `succeeded` — a sweep that never asked would report nothing too.
    expect(outcome.providerStatus).toBe('succeeded');
    const rows = await db
      .select()
      .from(reconciliationSchema.paymentDiscrepancies)
      .where(eq(reconciliationSchema.paymentDiscrepancies.paymentId, payment.id));
    expect(rows).toEqual([]);
  });

  it('reports nothing when the rail cannot be read', async () => {
    // A gateway outage is not a finding about a payment. Recording one would fill
    // the queue with rows about the rail's availability during exactly the
    // incident where a real discrepancy is hardest to see.
    const seller = await seedSeller('unreadable');
    const checkoutGroupId = `group-unreadable-${seller.suffix}`;
    const intentId = `pi_unreadable_${seller.suffix.replace(/-/g, '')}`;
    gateway.putIntent({
      id: intentId,
      status: 'succeeded',
      amount: BigInt(ORDER_TOTAL),
      currency: 'EUR',
    });
    gateway.state.unreadableIntents.add(intentId);

    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      providerObjectId: intentId,
      status: 'processing',
      linkOrders: false,
    });

    const outcome = await reconcileOnePayment(payment);

    expect(outcome.converged).toBe(false);
    expect(outcome.findings).toBe(0);
    // The read was attempted — the silence is the outage's, not a skipped call.
    expect(gateway.state.retrieves).toContain(intentId);
    const rows = await db
      .select()
      .from(reconciliationSchema.paymentDiscrepancies)
      .where(eq(reconciliationSchema.paymentDiscrepancies.paymentId, payment.id));
    expect(rows).toEqual([]);
    // …and nothing moved: the payment is still where checkout left it.
    expect((await findPaymentById(db, payment.id))?.status).toBe('processing');
  });
});

describe('the cursor', () => {
  it('resumes an interrupted pass from where it stopped, processing nothing twice', async () => {
    // Issue #50's jobs 7. The property is not "the cursor is stored" but "a
    // second run does not redo the first run's page" — which is why the fake
    // records every intent it was asked to read.
    //
    // The `open_payments` pass reads EVERY open Peable payment in the shared
    // database, so this case claims nothing about how many there are. It claims
    // that each one is read AT MOST once in a pass — a cursor that did not
    // advance, or advanced to the wrong id, re-reads a page — and that this
    // file's own three are each read EXACTLY once, which is the floor that keeps
    // "at most once" from being satisfied by reading nothing.
    await deleteReconciliationCursor(db, 'open_payments');

    const intentIds: string[] = [];
    for (const index of [0, 1, 2]) {
      const intentId = `pi_page_${RUN}_${String(index)}`;
      // The rail AGREES (`processing` on both sides), so the pass converges
      // nothing and writes nothing — the payments stay open, and stay in every
      // later page's population, which is what makes a re-read possible at all.
      gateway.putIntent({
        id: intentId,
        status: 'processing',
        amount: BigInt(ORDER_TOTAL),
        currency: 'EUR',
      });
      await ensurePayment({
        provider: 'peable',
        checkoutGroupId: `group-page-${RUN}-${uuidv7()}`,
        presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
        providerObjectId: intentId,
        status: 'processing',
        linkOrders: false,
      });
      intentIds.push(intentId);
    }

    const first = await runReconciliationJob('open_payments', { limit: 2 });
    expect(first?.scanned).toBe(2);
    const resumeFrom = first?.nextCursor;
    expect(resumeFrom).toBeTruthy();

    // The cursor is DURABLE between runs — that is what makes the pass resumable
    // across a task that died rather than merely across a loop iteration.
    const stored = (await listReconciliationCursors(db)).find((row) => row.id === 'open_payments');
    expect(stored?.cursor).toBe(resumeFrom);
    // …and the lease was released, so another task may take the next page.
    expect(stored?.leaseOwner).toBeNull();

    // Drive the rest of the pass. Bounded, because a cursor that never reached
    // the end is one of the defects this exists to catch, and an unbounded loop
    // would report it as a timeout naming nothing.
    let last = first;
    for (let page = 0; page < 1_000 && last?.nextCursor; page += 1) {
      last = await runReconciliationJob('open_payments', { limit: 2 });
      // `undefined` would be another task holding the lease — nothing in this
      // suite or any sibling drives this job, so it is a defect, not a race.
      expect(last).toBeDefined();
    }
    expect(last?.nextCursor).toBeNull();

    // Nothing was read twice in the pass…
    const reads = gateway.state.retrieves;
    expect(new Set(reads).size).toBe(reads.length);
    // …and this file's own payments were each read exactly once.
    for (const intentId of intentIds) {
      expect(reads.filter((read) => read === intentId)).toHaveLength(1);
    }

    // A completed pass clears the cursor, so the next pass starts from the
    // beginning rather than from wherever the last one stopped.
    const completed = (await listReconciliationCursors(db)).find(
      (row) => row.id === 'open_payments',
    );
    expect(completed?.cursor).toBeNull();
    expect(completed?.lastCompletedAt).not.toBeNull();
  });

  it('refuses a second concurrent claim on the same job', async () => {
    // Two tasks advancing one cursor would each skip the pages the other
    // consumed — a gap that produces no error and is invisible until the
    // discrepancy nobody detected turns up in a month-end.
    await deleteReconciliationCursor(db, 'ledger_audit');

    const first = await claimReconciliationRun(db, {
      job: 'ledger_audit',
      leaseOwner: `first-${RUN}`,
      leaseMs: 60_000,
    });
    const second = await claimReconciliationRun(db, {
      job: 'ledger_audit',
      leaseOwner: `second-${RUN}`,
      leaseMs: 60_000,
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();

    await releaseReconciliationRun(db, {
      job: 'ledger_audit',
      leaseOwner: `first-${RUN}`,
      completed: true,
    });
  });
});

describe('the ledger audit', () => {
  it('detects a succeeded payment with no charge_succeeded transaction', async () => {
    // The ABSENCE case, and it is constructed rather than faked: a payment whose
    // checkout group has NO orders books nothing, because `bookChargeSucceeded`
    // has nobody to split the charge across. That is a real correlation failure
    // — and under ADR 0001 D3 it is revenue that exists nowhere, since the
    // ledger is the only place commission lives.
    //
    // Nothing is DELETED to produce it. The append-only trigger would refuse
    // that anyway, which is the point: this check exists for the gap a trigger
    // cannot cover.
    const checkoutGroupId = `group-orphan-${RUN}-${uuidv7()}`;
    const intentId = `pi_orphan_${RUN}_${uuidv7()}`;
    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      providerObjectId: intentId,
      linkOrders: false,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: intentId,
    });

    const booked = await db
      .select()
      .from(ledgerSchema.ledgerTransactions)
      .where(eq(ledgerSchema.ledgerTransactions.paymentId, payment.id));
    expect(booked).toEqual([]);

    // AIMED, not driven from the beginning. `cursor: null` is what makes
    // `auditLedgerPage` also run its two GLOBAL checks — the balance aggregate
    // and, far worse, `auditOpenPayables`, which with the age buffer zeroed
    // reports `merchant_payable_unexplained` for every unexplained open payable
    // in the shared database and REOPENS any that another file has resolved. A
    // cursor skips both and narrows the payment scan to payments newer than the
    // floor, which is all this case is about.
    const page = await auditLedgerPage({ cursor: await paymentFloorBelow(payment.id), limit: 500 });
    // Without this the aim could be the vacuity: a floor at or above the fixture
    // scans nothing and reports nothing, which is what a working suppression
    // looks like from outside.
    expect(
      page.scanned,
      'the audit scanned no payment, so it proved nothing',
    ).toBeGreaterThanOrEqual(1);

    const row = await oneDiscrepancy(
      'ledger_transaction_missing',
      `${payment.id}:charge_succeeded`,
    );
    expect(row.severity).toBe('critical');
    expect(row.detail).toMatchObject({
      expectedKind: 'charge_succeeded',
      paymentStatus: 'succeeded',
    });
  });

  it('does not report an open payable that a WITHHELD TRANSFER explains', async () => {
    // An open `merchant_payable` is what a withheld transfer MEANS in accounts
    // (ADR 0001 D4): the seller was not paid, so Mercaria still owes them. The
    // condition is correct, and reporting it would put a row in the queue that
    // nobody can close.
    //
    // The explanation is read from the LIVE transfer row rather than from the
    // `transfer_withheld` outbox row that announced it — an outbox row is never
    // deleted when the condition is fixed and is swept at 14 days, so the
    // announcement version would both suppress a LATER unrelated problem on the
    // same order and stop suppressing this one after a fortnight.
    const seller = await seedSeller('withheld-payable');
    const checkoutGroupId = `group-withheld-${seller.suffix}`;
    const orderId = await seedOrder(seller, checkoutGroupId);

    // Take the account out of `ready` BEFORE the charge settles, so settlement
    // withholds rather than transfers.
    const account = await findProviderAccountByOwner(db, {
      provider: 'peable',
      ownerType: 'store',
      ownerId: seller.store.id,
    });
    if (!account) throw new Error('the fixture account vanished');
    await applyProviderAccountState(db, {
      id: account.id,
      state: {
        onboardingState: 'restricted',
        chargesEnabled: false,
        payoutsEnabled: false,
        transfersCapability: 'inactive',
        requirementsCurrentlyDue: 0,
        requirementsEventuallyDue: 0,
        requirementsPastDue: 2,
        requirementsPendingVerification: 0,
        disabledReasonCodes: [],
        syncedAt: new Date(),
      },
    });

    const intentId = `pi_withheldpay_${seller.suffix.replace(/-/g, '')}`;
    seedSucceededIntent(intentId);
    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      providerObjectId: intentId,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: intentId,
      platform: sameCurrencyPlatform(),
    });

    // The precondition: a transfer row with no rail object, and an open payable.
    const transfers = await db
      .select()
      .from(paymentSchema.transfers)
      .where(eq(paymentSchema.transfers.orderId, orderId));
    expect(transfers[0]?.providerObjectId).toBeNull();

    const explanation = await explainOpenPayable(db, orderId);
    expect(explanation).toContain('withheld');

    // The positive control for the assertion below, and it is not optional: the
    // claim is about what the audit does NOT write, so an audit that never saw
    // this payable would satisfy it for entirely the wrong reason. This is the
    // sweep's OWN candidate query, so the control and the measurement can fail
    // for the same reasons.
    const candidates = await findOpenMerchantPayables(db, {
      settledBefore: new Date(),
      limit: 500,
    });
    expect(
      candidates.some((candidate) => candidate.orderId === orderId),
      'the payable is not even a candidate, so "nothing reported" proves nothing',
    ).toBe(true);

    // …so the audit says nothing about it. This is the ONE case that must drive
    // the global payable check rather than aim it — the subject IS the whole
    // sweep's silence — which is why this file holds the reconciliation-sweep
    // slot for its entire run. See `reconciliation-sweep-slot.ts`.
    await auditLedgerPage({ cursor: null, limit: 500 });
    const reported = await discrepancyRows('merchant_payable_unexplained', `${orderId}:EUR`);
    expect(reported).toEqual([]);
  });

  it('finds no global imbalance, which is the only healthy answer', async () => {
    // The repository refuses an unbalanced transaction before issuing SQL and a
    // trigger refuses an edit afterwards, so this should be structurally
    // impossible. It is checked because "impossible" and "nobody has looked" are
    // indistinguishable from outside the code.
    expect(await findGlobalLedgerImbalances(db)).toEqual([]);
  });
});

describe('metrics', () => {
  it('reports at least the payments this run owns, and keeps the imbalance counter at zero', async () => {
    const before = await collectPaymentMetrics();
    // Metric 8's expected value is a CONSTANT. A non-zero reading is a posting
    // builder producing entries that do not balance, which means a money
    // movement has no accounting at all.
    expect(before.ledgerImbalanceAttempts).toBe(0);
    const ownBefore = await ownSucceededPeableEurPayments();

    const seller = await seedSeller('metrics');
    const checkoutGroupId = `group-metrics-${seller.suffix}`;
    await seedOrder(seller, checkoutGroupId);
    const intentId = `pi_metrics_${seller.suffix.replace(/-/g, '')}`;
    seedSucceededIntent(intentId);
    const payment = await ensurePayment({
      provider: 'peable',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      providerObjectId: intentId,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: intentId,
      platform: sameCurrencyPlatform(),
    });

    const after = await collectPaymentMetrics();
    const ownAfter = await ownSucceededPeableEurPayments();

    // The subject moved, measured where it CAN be measured — over the rows this
    // run owns, which nobody else writes and nobody else deletes.
    expect(ownAfter).toBe(ownBefore + 1);
    // The non-zero floor for the two bounds below, stated rather than inferred:
    // `metric >= 0` would hold against a metric that counts nothing at all.
    expect(ownAfter).toBeGreaterThanOrEqual(1);

    const succeededBefore =
      before.payments.find(
        (row) => row.provider === 'peable' && row.currency === 'EUR' && row.status === 'succeeded',
      )?.count ?? 0;
    const succeededAfter =
      after.payments.find(
        (row) => row.provider === 'peable' && row.currency === 'EUR' && row.status === 'succeeded',
      )?.count ?? 0;

    // A LOWER BOUND against this run's own rows, and NOT `succeededAfter >
    // succeededBefore` — which is #276. `paymentCountsByStatus` is an unscoped
    // aggregate over the whole `payments` table: correct for the operator
    // endpoint it serves, and on the one database every realdb file writes in
    // parallel a strict increase is a claim about THEIR rows as much as this
    // file's. A sibling deleting a peable/EUR/succeeded fixture between the two
    // reads nets this file's own insert to zero, and it fails as
    // `expected 6 to be greater than 6` — naming nothing about the cause.
    //
    // Nobody deletes rows keyed on this RUN, so foreign inserts and foreign
    // deletions can move the global count in either direction and neither can
    // take it below what this file is holding it to.
    //
    // What that gives up is STRICTNESS, and the reason it is still worth
    // asserting is that the failure it exists to catch survives: a metric that
    // cannot move is indistinguishable from one wired to nothing, and a metric
    // wired to nothing reports no row for this triple, or one whose count is
    // zero, or one grouped by something else — every one of which is short of
    // `ownAfter` and fails here. Mutation-measured, all three. What it does NOT
    // catch is a metric frozen at a constant at or above `ownAfter`, which is
    // the price of the whole table being somebody else's as well as ours.
    expect(succeededBefore).toBeGreaterThanOrEqual(ownBefore);
    expect(succeededAfter).toBeGreaterThanOrEqual(ownAfter);

    // Still zero after a real charge, a real ledger transaction and a real
    // settlement have gone through.
    expect(after.ledgerImbalanceAttempts).toBe(0);
    expect(ledgerImbalanceAttempts()).toBe(0);

    // The cursors are reported so a stale sweep is visible without a log dive.
    // `ledger_audit`'s row exists because the claim case above wrote it, so this
    // is a claim about the report, not about which sweeps happen to have run.
    expect(after.reconciliation.cursors.map((row) => row.job)).toEqual(
      expect.arrayContaining(['ledger_audit']),
    );
  });

  it('counts an unbalanced posting attempt without writing anything', async () => {
    // Mutation-proofing the counter itself: a metric that cannot move is
    // indistinguishable from one that is wired to nothing, and this is the only
    // number in the payload whose healthy value is a constant.
    const { UnbalancedLedgerTransactionError } = await import(
      '../../../../db/payments/ledgerRepository.js'
    );
    const before = ledgerImbalanceAttempts();

    await expect(
      insertLedgerTransaction(
        db,
        { kind: 'adjustment', description: `deliberately unbalanced ${RUN}` },
        [
          { account: 'provider_clearing', currency: 'EUR', amountMinor: 100n },
          { account: 'commission_revenue', currency: 'EUR', amountMinor: -99n },
        ],
      ),
    ).rejects.toThrow(UnbalancedLedgerTransactionError);

    expect(ledgerImbalanceAttempts()).toBe(before + 1);

    // Refused BEFORE any SQL: the description this test used appears nowhere.
    const written = await db
      .select()
      .from(ledgerSchema.ledgerTransactions)
      .where(eq(ledgerSchema.ledgerTransactions.description, `deliberately unbalanced ${RUN}`));
    expect(written).toEqual([]);
  });
});
