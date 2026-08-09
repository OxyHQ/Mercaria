/**
 * The conformance suite, run against the fake order adapter and a REAL
 * Postgres server.
 *
 * This file is deliberately thin: everything it asserts lives in
 * `adapter-conformance-suite.ts`, so #125's adapter gets byte-identical
 * coverage by writing a file exactly this size. What lives HERE is the harness
 * — the translation between the suite's fourteen scenarios and one adapter's
 * own transport — and nothing else.
 *
 * A real server, not a mock: the properties under test are a unique index
 * refusing a second external order id, an append-only trigger, a partial
 * unique deduplicating a webhook and a `FOR UPDATE SKIP LOCKED` claim. None of
 * them exists without one, and a mocked `insert` accepts every statement a real
 * server rejects.
 */

import {
  runSupplierAdapterConformanceSuite,
  type ConformanceScenario,
  type SupplierAdapterConformanceHarness,
} from './adapter-conformance-suite.js';
import {
  clearFakeOrderState,
  fakeOrderAdapterInstance,
  fakeOrderStore,
  injectFakeOrderScenario,
  setFakeOrderIdempotencySupport,
  FAKE_ORDER_PROVIDER,
  type FakeOrderScenario,
} from '../adapters/fake-order-adapter.js';

/** The secret the fake adapter's webhook verification expects. */
const CREDENTIAL = 'conformance-shared-secret';

/**
 * The suite's vocabulary → this adapter's.
 *
 * A `Record` rather than a `switch`, so a scenario added to the suite fails
 * `tsc` here rather than silently mapping to `healthy` — which would make a new
 * case pass by testing nothing.
 */
const SCENARIOS: Record<ConformanceScenario, FakeOrderScenario> = {
  healthy: 'healthy',
  timeout_before_write: 'timeout_before_write',
  timeout_after_write: 'timeout_after_write',
  rejected: 'rejected',
  received_only: 'received_only',
  partial_shipment: 'partial_shipment',
  cancel_accepted: 'cancel_accepted',
  cancel_rejected: 'cancel_rejected',
  credential_expired: 'credential_expired',
  rate_limited: 'rate_limited',
  malformed_payload: 'malformed_payload',
};

const harness: SupplierAdapterConformanceHarness = {
  provider: FAKE_ORDER_PROVIDER,
  adapter: fakeOrderAdapterInstance(),
  credential: CREDENTIAL,
  inject(clientReference, scenario) {
    injectFakeOrderScenario(clientReference, SCENARIOS[scenario]);
  },
  setIdempotencySupport(honours) {
    setFakeOrderIdempotencySupport(honours);
  },
  reset() {
    clearFakeOrderState();
  },
  hasOrder(clientReference) {
    return fakeOrderStore().has(clientReference);
  },
  webhookDelivery(input) {
    return {
      body: Buffer.from(
        JSON.stringify({
          secret: CREDENTIAL,
          eventId: input.eventId,
          clientReference: input.clientReference,
          externalOrderId: input.externalOrderId,
          status: input.providerState,
          observedAt: input.observedAt.toISOString(),
        }),
        'utf8',
      ),
      headers: { 'content-type': 'application/json' },
    };
  },
};

runSupplierAdapterConformanceSuite(harness);
