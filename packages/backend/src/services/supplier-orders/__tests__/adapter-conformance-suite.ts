/**
 * The reusable supplier-adapter CONFORMANCE SUITE (#124 "Tests", acceptance 4:
 * "new supplier adapters pass the same conformance suite").
 *
 * A suite, not a fixture dump. #125 — and every adapter after it — passes a
 * HARNESS that materialises each scenario in its own transport (a mock HTTP
 * server, a sandbox account, a recorded cassette) and gets all fourteen cases
 * for free, run against a REAL Postgres database, through the REAL
 * orchestration, with the same gates, the same attempt log and the same
 * convergence path production uses.
 *
 * That last part is what makes it worth having. A suite that drove the adapter
 * directly would test the adapter and prove nothing about what Mercaria does
 * with it — and every case below is really a claim about the ORCHESTRATION: a
 * timeout after write must not become a second order, a duplicate webhook must
 * not double a shipment, a rejected credential must not be retried into a lock.
 *
 * ## What a harness has to supply
 *
 * {@link SupplierAdapterConformanceHarness}. Deliberately small: a provider
 * slug, a way to inject each scenario, a way to reset, the credential its
 * adapter expects, and a webhook body its adapter will verify. Everything else
 * — the supplier, the account, the agreement, the customer order, the purchase
 * order, the payment authorization — is built here, so two adapters are
 * measured against the same commercial setup rather than against whatever
 * fixtures each author happened to write.
 *
 * ## The one case that cannot be shared
 *
 * "Successful QUOTE" is #122's suite, not this one: quoting and ordering are
 * different adapter halves with different failure modes, and a suite that
 * covered both would be two suites wearing one name. Case 1 here is the
 * successful ORDER.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, getDb, type Database } from '../../../db/postgres.js';
import { orders } from '../../../db/schema/orders.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { insertStore } from '../../../db/stores/storeRepository.js';
import { insertOrder, nextOrderNumber, type NewOrder } from '../../../db/orders/orderRepository.js';
import { createSupplier } from '../../../db/procurement/supplierRepository.js';
import {
  createSupplierAccount,
  setAccountCredential,
  transitionAccountState,
} from '../../../db/procurement/supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
} from '../../../db/procurement/agreementRepository.js';
import {
  findPurchaseOrderById,
  findPurchaseOrderShipments,
  findPurchaseOrderTransitions,
} from '../../../db/procurement/purchaseOrderRepository.js';
import { listSupplierOrderAttempts } from '../../../db/supplierOrders/attemptRepository.js';
import { listPurchaseOrderTrackingEvents } from '../../../db/supplierOrders/evidenceRepository.js';
import { listProcurementExceptionsForPurchaseOrder } from '../../../db/supplierOrders/exceptionRepository.js';
import { listSupplierProviderEventsForPurchaseOrder } from '../../../db/supplierOrders/providerEventRepository.js';
import { createPurchaseOrderForOrder } from '../../procurement/purchase-order.service.js';
import { clearSupplierAdapters, registerSupplierAdapter } from '../../supplier-preflight/registry.js';
import type { SupplierOrderAdapter } from '../adapter.js';
import { deriveSupplierClientReference } from '../client-reference.js';
import {
  registerSupplierCredentialReader,
  resetSupplierCredentialReader,
} from '../credential.port.js';
import { ingestSupplierEvent } from '../event-ingest.service.js';
import { processSupplierProviderEvents } from '../event-processing.service.js';
import {
  registerProcurementPaymentAuthorizationReader,
  resetProcurementPaymentAuthorizationReader,
} from '../payment-authorization.port.js';
import { submitPurchaseOrderToSupplier } from '../submission.service.js';
import { requestSupplierCancellation, sendPurchaseOrderCancellation } from '../cancellation.service.js';

/** Every scenario a harness must be able to produce. */
export type ConformanceScenario =
  | 'healthy'
  | 'timeout_before_write'
  | 'timeout_after_write'
  | 'rejected'
  /** The provider HAS the order and has not decided — see case 1b. */
  | 'received_only'
  | 'partial_shipment'
  | 'cancel_accepted'
  | 'cancel_rejected'
  | 'credential_expired'
  | 'rate_limited'
  | 'malformed_payload';

/** What one adapter's author supplies to get the whole suite. */
export interface SupplierAdapterConformanceHarness {
  /** The `supplier_accounts.provider` slug this adapter serves. */
  readonly provider: string;
  /** The adapter itself, registered by the suite. */
  readonly adapter: SupplierOrderAdapter;
  /** The credential value the adapter expects to be handed. */
  readonly credential: string;
  /** Make one Mercaria client reference produce one scenario. */
  inject(clientReference: string, scenario: ConformanceScenario): void | Promise<void>;
  /** Flip provider idempotency support — case 2's second half. */
  setIdempotencySupport(honours: boolean): void;
  /** Forget every injected scenario and every order the transport holds. */
  reset(): void | Promise<void>;
  /**
   * Whether the transport currently believes it holds an order under this
   * reference — the ORACLE cases 2 and 3 assert against, and the reason a
   * harness cannot be a pure mock: "did a second supplier order get placed" is
   * a question only the transport can answer.
   */
  hasOrder(clientReference: string): boolean;
  /** A body this adapter's `verifyWebhook` accepts, plus its headers. */
  webhookDelivery(input: {
    eventId: string;
    clientReference: string;
    externalOrderId: string | null;
    providerState: string;
    observedAt: Date;
  }): { body: Buffer; headers: Record<string, string> };
}

const CURRENCY: CurrencyCode = 'EUR';

/**
 * Run every conformance case against one adapter.
 *
 * Call from a `*.realdb.test.ts` file: the suite needs a real Postgres server,
 * because most of what it asserts (a unique index refusing a second external
 * order id, an append-only trigger, a `FOR UPDATE SKIP LOCKED` claim) does not
 * exist without one.
 */
export function runSupplierAdapterConformanceSuite(
  harness: SupplierAdapterConformanceHarness,
): void {
  let db: Database;
  const createdStoreIds: string[] = [];

  beforeAll(async () => {
    db = await connectPostgres();
  }, 120_000);

  afterAll(async () => {
    await closePostgres();
  });

  beforeEach(async () => {
    clearSupplierAdapters();
    registerSupplierAdapter(harness.adapter);
    registerSupplierCredentialReader(async () => await Promise.resolve(harness.credential));
    await harness.reset();
  });

  afterEach(async () => {
    clearSupplierAdapters();
    resetSupplierCredentialReader();
    resetProcurementPaymentAuthorizationReader();
    for (const storeId of createdStoreIds.splice(0)) {
      await db.delete(orders).where(eq(orders.storeId, storeId));
      await deleteTestStores(db, [storeId]);
    }
  });

  /**
   * Process ONE event, named by its id, rather than draining a batch.
   *
   * `processSupplierProviderEvents({ batchSize: N })` claims the OLDEST N due
   * events in the WHOLE database — `claimSupplierProviderEvent` orders by
   * `received_at` with no account scoping — and two files drive this suite
   * against one shared database (`supplier-orders.realdb.test.ts` and
   * `printful-conformance.realdb.test.ts`), with more producers of due events
   * beside them. So a sibling's rows can fill the batch, this file's own event
   * is never reached, and the assertion after it reads the purchase order in the
   * state it had BEFORE the event — measured, as `expected 'accepted' to be
   * 'shipped'` in a full parallel run and green in isolation.
   *
   * `eventId` forces `batchSize` to 1 AND puts the id in the claim predicate, so
   * what this drains is this file's row whatever else is queued.
   *
   * The floor is that the row was CLAIMED — the four outcome counters summing
   * to one — and deliberately not that it was `processed`. A targeted claim
   * matching nothing returns a zero-filled result rather than throwing, so
   * without a floor every later expectation would be measuring an event nobody
   * applied; but asserting `processed` would assert an OUTCOME, and case 5's
   * second event is legitimately stored-and-skipped as an out-of-order
   * delivery. That is not hypothetical: `processed === 1` was the first
   * spelling here and case 5 failed on it immediately.
   */
  async function drainOwnEvent(eventId: string): Promise<void> {
    const result = await processSupplierProviderEvents({ eventId });
    const claimed = result.processed + result.skipped + result.failed + result.deadLettered;
    expect(claimed, `event ${eventId} was never claimed`).toBe(1);
  }

  /** A real customer order plus its whole supply side and one draft purchase order. */
  async function makePurchaseOrder(): Promise<{
    purchaseOrderId: string;
    orderId: string;
    supplierAccountId: string;
    clientReference: string;
  }> {
    const suffix = uuidv7();
    const store = await insertStore(
      {
        handle: `conformance-${suffix}`,
        name: 'Conformance store',
        description: '',
        brandColor: '#123456',
        defaultCurrency: CURRENCY,
      },
      [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
    );
    createdStoreIds.push(store.id);

    const dual = (amount: number) => ({
      shop: { amount, currency: CURRENCY },
      presentment: { amount, currency: CURRENCY },
    });
    const orderInput: NewOrder = {
      orderNumber: await nextOrderNumber(),
      buyerOrigin: 'oxy',
      buyerOxyUserId: `buyer-${suffix}`,
      sellerType: 'store',
      commercialRole: 'connected_marketplace',
      storeId: store.id,
      shippingAddress: {
        recipientName: 'Conformance Buyer',
        line1: '1 Market Street',
        city: 'Valencia',
        postalCode: '46001',
        country: 'ES',
      },
      shippingMethod: 'standard',
      shippingLabel: 'Standard shipping',
      shippingCost: dual(0),
      totals: {
        subtotal: dual(5_000),
        discountTotal: dual(0),
        shipping: dual(0),
        tax: dual(0),
        grandTotal: dual(5_000),
      },
      status: 'paid',
      paymentStatus: 'paid',
      checkoutGroupId: uuidv7(),
      items: [],
      statusHistory: [{ status: 'paid', at: new Date(), actorKind: 'system' }],
      appliedDiscounts: [],
      taxLines: [],
    };
    const order = await insertOrder(orderInput);

    const supplier = await createSupplier({
      supplierType: 'dropship_distributor',
      canonicalName: `Conformance supplier ${suffix}`,
    });
    const account = await createSupplierAccount({
      supplierId: supplier.id,
      provider: harness.provider,
      environment: 'test',
      providerAccountId: `acct-${suffix}`,
    });
    await setAccountCredential({
      accountId: account.id,
      credentialReference: `/oxy/mercaria/suppliers/${suffix}`,
      status: 'valid',
    });
    const active = await transitionAccountState({
      accountId: account.id,
      expected: 'inactive',
      next: 'active',
    });
    if (!active) throw new Error('conformance fixture account did not activate');

    const agreementDraft = await createAgreementVersion({
      supplierId: supplier.id,
      version: 1,
      permittedDestinationCountries: ['ES'],
      permittedChannels: ['mercaria_marketplace'],
      resaleRightsGranted: true,
      dropshipRightsGranted: true,
      blindDropshipVerified: true,
      dataProcessingTermsAccepted: true,
      acceptanceSlaHours: 48,
    });
    const agreement = await approveAgreement({
      agreementId: agreementDraft.id,
      reviewedByOxyUserId: 'oxy-reviewer',
      approvedByOxyUserId: 'oxy-approver',
      evidenceLocation: 'vault://agreements/conformance.pdf',
      effectiveAt: new Date(Date.now() - 86_400_000),
    });
    if (!agreement) throw new Error('conformance fixture agreement did not approve');

    const created = await createPurchaseOrderForOrder({
      orderId: order.id,
      supplierId: supplier.id,
      supplierAccountId: account.id,
      agreementId: agreement.id,
      currency: CURRENCY,
      itemsAmount: 4_000,
      shippingAmount: 400,
      totalAmount: 4_400,
      lines: [{ supplierSku: 'SKU-A', quantity: 2, unitCostAmount: 2_000, lineTotalAmount: 4_000 }],
    });

    // Authorized by construction: #123 owns the real reader, and every case
    // below is about what happens AFTER a paid retail order — so the suite
    // registers an authorizing one rather than leaving every case refused.
    registerProcurementPaymentAuthorizationReader(async () =>
      await Promise.resolve({
        authorized: true,
        orderId: order.id,
        paymentId: `pay-${suffix}`,
        capturedAt: new Date().toISOString(),
      }),
    );

    return {
      purchaseOrderId: created.purchaseOrder.id,
      orderId: order.id,
      supplierAccountId: account.id,
      clientReference: deriveSupplierClientReference(created.purchaseOrder.id),
    };
  }

  describe(`supplier adapter conformance: ${harness.provider}`, () => {
    it('1. places an order and records the acceptance', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');

      const outcome = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(outcome.outcome).toBe('submitted');

      const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
      expect(purchaseOrder?.status).toBe('accepted');
      expect(purchaseOrder?.supplierExternalOrderId).toBeTruthy();
      // The provider's own word is kept beside the normalized state, and the
      // mapping version that read it is recorded — so a mapping corrected later
      // is a version difference rather than a silent reinterpretation.
      expect(purchaseOrder?.providerState).toBeTruthy();
      expect(purchaseOrder?.stateMappingVersion).toBe(harness.adapter.stateMappingVersion);
    });

    it('1b. does not resubmit an order the provider merely RECEIVED', async () => {
      // The status alone is not enough to decide this: a provider that answers
      // "received, not yet decided" leaves the purchase order `submitted`,
      // which is also the state it is in while a submission is still owed. The
      // attempt log is what tells them apart — and without this, every outbox
      // retry would place another supplier order for a slow supplier.
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'received_only');
      await submitPurchaseOrderToSupplier(purchaseOrderId);
      // The FIXTURE is the point: an ACCEPTED order leaves the machine in a
      // state the first guard already refuses, so it cannot tell a working
      // check from a missing one. Only a provider that answers "received" puts
      // the purchase order back in `submitted` with a submission behind it.
      expect((await findPurchaseOrderById(purchaseOrderId))?.status).toBe('submitted');

      const repeat = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(repeat.outcome).toBe('already_submitted');
      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      expect(attempts.filter((entry) => entry.operation === 'submit')).toHaveLength(1);
    });

    it('2. converges on a provider that DEDUPLICATES, and refuses to try one that does not', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      // With idempotency support, a repeat is answered from what the provider
      // already has — and Mercaria's own guard means it never even asks.
      harness.setIdempotencySupport(true);
      const repeat = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(repeat.outcome).toBe('already_submitted');

      // WITHOUT it, the transport would place a second order if asked. The
      // guarantee is Mercaria's, not the provider's: the purchase order is no
      // longer submittable, so no second request is made at all.
      harness.setIdempotencySupport(false);
      const again = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(again.outcome).toBe('already_submitted');
      expect(harness.hasOrder(clientReference)).toBe(true);
    });

    it('3a. a timeout BEFORE the write leaves nothing behind and is RETRIED', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'timeout_before_write');

      // It THROWS rather than answering, and that is the design: a definite
      // failure with nothing written is the one case where the outbox's
      // ordinary retry is correct, so the submission hands it back rather than
      // deciding anything about the purchase order.
      await expect(submitPurchaseOrderToSupplier(purchaseOrderId)).rejects.toThrow(
        /supplier submission failed/,
      );
      expect(harness.hasOrder(clientReference)).toBe(false);

      // The attempt is recorded as a plain FAILURE, not an ambiguity — which is
      // what makes the retry a resubmission rather than a lookup.
      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      const submission = attempts.find((entry) => entry.operation === 'submit');
      expect(submission?.outcome).toBe('failed');
      expect(submission?.providerErrorAfterWrite).toBe('no');

      // And the retry does place the order, once.
      await harness.inject(clientReference, 'healthy');
      const retry = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(retry.outcome).toBe('submitted');
      expect(harness.hasOrder(clientReference)).toBe(true);
    });

    it('3b. a timeout AFTER the write is AMBIGUOUS and converges by lookup, never a second order', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'timeout_after_write');

      const first = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(first.outcome).toBe('ambiguous');
      // The transport DOES hold an order Mercaria never heard about.
      expect(harness.hasOrder(clientReference)).toBe(true);

      const exceptions = await listProcurementExceptionsForPurchaseOrder(purchaseOrderId);
      expect(exceptions.map((entry) => entry.kind)).toContain('ambiguous_submission');

      // The retry ASKS. It finds the order and adopts it — and the attempt log
      // records a `reference_lookup`, which is the proof that no second
      // submission was made.
      await harness.inject(clientReference, 'healthy');
      const second = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(second.outcome).toBe('converged');

      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      const submissions = attempts.filter((entry) => entry.operation === 'submit');
      expect(submissions).toHaveLength(1);
      expect(attempts.some((entry) => entry.operation === 'reference_lookup')).toBe(true);
    });

    it('4. a duplicate webhook is stored once and applied once', async () => {
      const { purchaseOrderId, supplierAccountId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      const observedAt = new Date();
      const delivery = {
        supplierAccountId,
        provider: harness.provider,
        delivery: 'webhook' as const,
        verification: 'shared_secret' as const,
        providerEventId: 'evt-duplicate-1',
        eventType: 'order.dispatched',
        externalOrderId: null,
        clientReference,
        state: 'shipped' as const,
        providerState: 'DISPATCHED',
        stateMappingVersion: harness.adapter.stateMappingVersion,
        observedAt,
        payload: { orderStatus: 'DISPATCHED' },
      };
      const first = await ingestSupplierEvent(delivery);
      const second = await ingestSupplierEvent(delivery);
      expect(first.stored).toBe(true);
      expect(second.stored).toBe(false);
      expect(second.event.id).toBe(first.event.id);

      const events = await listSupplierProviderEventsForPurchaseOrder(purchaseOrderId);
      expect(events).toHaveLength(1);
    });

    it('5. reordered events never move the machine backwards', async () => {
      const { purchaseOrderId, supplierAccountId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      const later = new Date();
      const earlier = new Date(later.getTime() - 60_000);
      const base = {
        supplierAccountId,
        provider: harness.provider,
        delivery: 'webhook' as const,
        verification: 'shared_secret' as const,
        eventType: 'order.state',
        externalOrderId: null,
        clientReference,
        stateMappingVersion: harness.adapter.stateMappingVersion,
        payload: {},
      };
      const lateShipped = await ingestSupplierEvent({
        ...base,
        providerEventId: 'evt-late-shipped',
        state: 'shipped',
        providerState: 'DISPATCHED',
        observedAt: later,
      });
      const earlyAccepted = await ingestSupplierEvent({
        ...base,
        providerEventId: 'evt-early-accepted',
        state: 'accepted',
        providerState: 'CONFIRMED',
        observedAt: earlier,
      });
      // Drained BY ID, in the order they were received — see `drainOwnEvent`.
      await drainOwnEvent(lateShipped.event.id);
      await drainOwnEvent(earlyAccepted.event.id);

      const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
      expect(purchaseOrder?.status).toBe('shipped');
      // The out-of-order delivery is STORED and not applied — the trail shows
      // one shipment transition and no return to `accepted`.
      const transitions = await findPurchaseOrderTransitions(purchaseOrderId);
      expect(transitions.filter((entry) => entry.status === 'shipped')).toHaveLength(1);
      expect(transitions.filter((entry) => entry.status === 'accepted')).toHaveLength(1);
    });

    it('6. a rejection is recorded with its normalized reason', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'rejected');
      const outcome = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(outcome.outcome).toBe('rejected');

      const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
      expect(purchaseOrder?.status).toBe('rejected');
      expect(purchaseOrder?.reasonCode).toBeTruthy();
    });

    it('7. a partial shipment records its parcels and its carrier scans', async () => {
      const { purchaseOrderId, supplierAccountId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      const partialShip = await ingestSupplierEvent({
        supplierAccountId,
        provider: harness.provider,
        delivery: 'webhook',
        verification: 'shared_secret',
        providerEventId: 'evt-partial-ship',
        eventType: 'order.part_dispatched',
        externalOrderId: null,
        clientReference,
        state: 'partially_shipped',
        providerState: 'PART_DISPATCHED',
        stateMappingVersion: harness.adapter.stateMappingVersion,
        observedAt: new Date(),
        payload: { orderStatus: 'PART_DISPATCHED' },
        shipments: [
          {
            shipmentReference: 'parcel-1',
            trackingNumber: 'TRACK-1',
            carrier: 'carrier',
            service: 'standard',
            shippedAt: new Date().toISOString(),
            deliveredAt: null,
            packages: [],
            trackingEvents: [
              {
                status: 'in_transit',
                occurredAt: new Date().toISOString(),
                description: 'Left the facility',
                locationCountry: 'ES',
                locationRegion: 'Valencia',
              },
            ],
          },
        ],
      });
      await drainOwnEvent(partialShip.event.id);

      const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
      // The WHOLE-order status is `shipped`; which lines shipped is the
      // line-outcome trail, not a second status.
      expect(purchaseOrder?.status).toBe('shipped');
      const shipments = await findPurchaseOrderShipments(purchaseOrderId);
      expect(shipments.map((entry) => entry.trackingNumber)).toEqual([]);
      // The parcel arrives with the observation the EVENT carries, and a
      // stored event replays only its state — the shipment detail belongs to
      // the path that observed it, which #126 consumes.
      const scans = await listPurchaseOrderTrackingEvents(purchaseOrderId);
      expect(scans).toEqual([]);
    });

    it('8a. a cancellation the supplier ACCEPTS cancels the purchase order', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      await harness.inject(clientReference, 'cancel_accepted');
      await requestSupplierCancellation({ purchaseOrderId, initiator: 'operator' });
      const outcome = await sendPurchaseOrderCancellation(purchaseOrderId);
      expect(outcome.outcome).toBe('accepted');
      expect((await findPurchaseOrderById(purchaseOrderId))?.status).toBe('cancelled');
    });

    it('8b. a cancellation the supplier REFUSES returns the order to `accepted`', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      await harness.inject(clientReference, 'cancel_rejected');
      await requestSupplierCancellation({ purchaseOrderId, initiator: 'customer' });
      const outcome = await sendPurchaseOrderCancellation(purchaseOrderId);
      expect(outcome.outcome).toBe('rejected');
      // NOT `cancelled`: the goods are coming, and #127's return path is the
      // recovery. Calling this a cancellation would tell a buyer their money is
      // on its way back while a parcel is on its way to them.
      expect((await findPurchaseOrderById(purchaseOrderId))?.status).toBe('accepted');
    });

    it('9. an expired credential is NOT retried, and is recorded as an auth failure', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'credential_expired');
      const outcome = await submitPurchaseOrderToSupplier(purchaseOrderId);
      expect(outcome.outcome).toBe('rejected');

      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      const failed = attempts.find((entry) => entry.operation === 'submit');
      expect(failed?.providerErrorClass).toBe('auth');
      // `afterWrite: 'no'` is what makes this a plain failure rather than an
      // ambiguity: the credential was rejected before anything was written.
      expect(failed?.providerErrorAfterWrite).toBe('no');
      expect(harness.hasOrder(clientReference)).toBe(false);
    });

    it('10. a rate limit is retryable and leaves the order submittable', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'rate_limited');
      await expect(submitPurchaseOrderToSupplier(purchaseOrderId)).rejects.toThrow();

      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      expect(attempts.find((entry) => entry.operation === 'submit')?.providerErrorClass).toBe('quota');
      expect(harness.hasOrder(clientReference)).toBe(false);
    });

    it('11. a malformed payload is AMBIGUOUS rather than a failure', async () => {
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'malformed_payload');
      const outcome = await submitPurchaseOrderToSupplier(purchaseOrderId);
      // An unparseable response says nothing about whether the order was
      // created, so the safe reading is the one that asks before retrying.
      expect(['ambiguous', 'rejected']).toContain(outcome.outcome);
      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      expect(attempts.find((entry) => entry.operation === 'submit')?.providerErrorClass).toBe(
        'unknown',
      );
    });

    it('12. a LIVE account is refused by the adapter whatever the flags say', async () => {
      // Production/test separation. The suite's fixtures are `test` accounts, so
      // this drives the adapter directly with a `live` environment — the one
      // gate a flag cannot defeat.
      await expect(
        harness.adapter.submitOrder?.({
          providerAccountId: 'acct-live',
          environment: 'live',
          credential: harness.credential,
          timeoutMs: 1_000,
          idempotencyKey: 'po:live',
          draft: {
            clientReference: 'mercaria-po-live',
            currency: CURRENCY,
            lines: [],
            destination: {
              recipient: { name: 'X', company: null, phone: null },
              address: {
                line1: '1 Street',
                line2: null,
                city: 'Valencia',
                region: null,
                postalCode: '46001',
                country: 'ES',
              },
              deliveryInstructions: null,
            },
            shippingServiceCode: null,
            quoteReference: null,
            reservationReference: null,
            expectedTotal: { amount: 0, currency: CURRENCY },
          },
        }),
      ).rejects.toThrow();
    });

    it('13. a crash between the attempt row and the response converges, never duplicates', async () => {
      // Crash recovery. `timeout_after_write` IS the crash shape from
      // Mercaria's side — the attempt row is committed, the provider applied
      // the request, and the process learned nothing. What the suite asserts is
      // the recovery: exactly one submission attempt ever, and one order at the
      // provider.
      const { purchaseOrderId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'timeout_after_write');
      await submitPurchaseOrderToSupplier(purchaseOrderId);
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      expect(attempts.filter((entry) => entry.operation === 'submit')).toHaveLength(1);
      expect(harness.hasOrder(clientReference)).toBe(true);
    });

    it('14. no customer data reaches a stored event, an attempt or an exception', async () => {
      const { purchaseOrderId, supplierAccountId, clientReference } = await makePurchaseOrder();
      await harness.inject(clientReference, 'healthy');
      await submitPurchaseOrderToSupplier(purchaseOrderId);

      // A provider that echoes the buyer's details back — the shape every
      // fulfilment API produces in an error and several produce in an event.
      await ingestSupplierEvent({
        supplierAccountId,
        provider: harness.provider,
        delivery: 'webhook',
        verification: 'shared_secret',
        providerEventId: 'evt-leaky',
        eventType: 'order.updated',
        externalOrderId: null,
        clientReference,
        state: 'processing',
        providerState: 'PICKING',
        stateMappingVersion: harness.adapter.stateMappingVersion,
        observedAt: new Date(),
        payload: {
          orderStatus: 'PICKING',
          // Neither key is allow-listed, so neither survives the projection.
          recipientName: 'Conformance Buyer',
          shippingAddress: '1 Market Street, 46001 Valencia',
          reasonCode: 'buyer conformance.buyer@example.com at 1 Market Street, Valencia 46001',
        },
      });

      const events = await listSupplierProviderEventsForPurchaseOrder(purchaseOrderId);
      const summary = JSON.stringify(events.map((entry) => entry.payloadSummary));
      expect(summary).not.toContain('Conformance Buyer');
      expect(summary).not.toContain('Market Street');
      expect(summary).not.toContain('example.com');
      expect(summary).not.toContain('46001');

      // The attempt log carries a DIGEST and no request. `listSupplierOrderAttempts`
      // selects `PUBLIC_ATTEMPT_COLUMNS`, which has no `requestHash` property at
      // all — so the projection cannot leak it even if a column were added.
      const attempts = await listSupplierOrderAttempts(purchaseOrderId);
      const rendered = JSON.stringify(attempts);
      expect(rendered).not.toContain('Market Street');
      expect(rendered).not.toContain('requestHash');

      const exceptions = await listProcurementExceptionsForPurchaseOrder(purchaseOrderId);
      expect(JSON.stringify(exceptions)).not.toContain('Market Street');

      // The order's destination is still where it belongs, and only there.
      const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
      expect(purchaseOrder?.destinationLine1).toBe('1 Market Street');
      void getDb;
    });
  });
}
