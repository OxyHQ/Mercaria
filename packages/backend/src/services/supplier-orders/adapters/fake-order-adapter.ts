/**
 * The fake supplier ORDER adapter — the conformance suite's provider and the
 * rehearsal tool for the fourteen failures #124's test list names.
 *
 * ## It lives under `adapters/`, which is a WALL
 *
 * `supplier-order-isolation.test.ts` scans this DIRECTORY and fails the build
 * if anything in it imports a repository, a service, the database or the
 * config's operator lists. So the write boundary holds for adapters nobody has
 * written yet (#125's), and this one is subject to exactly the constraints a
 * real provider integration is — which is what makes it a useful rehearsal
 * rather than a mock that proves the mock works.
 *
 * ## Two independent gates, and the second is the load-bearing one
 *
 *  1. `PROCUREMENT_FAKE_ADAPTER_ENABLED` must be on for it to be registrable at
 *     all. Default false, so a production deployment that never sets it has no
 *     fake adapter in its registry.
 *  2. It REFUSES a `live` supplier account at call time, whatever the flag
 *     says. A staging flag copied into production still cannot fabricate an
 *     acceptance for a real supplier account — and the consequence there is
 *     worse than the preflight's: a fabricated acceptance tells a customer
 *     goods are coming that nobody ordered.
 *
 * A flag is exactly the thing that gets copied between environments, which is
 * why the second gate exists and why it is not conditional on the first.
 *
 * ## Injection is process-local, and that is stated rather than hidden
 *
 * The scenario map lives in this module, so it applies to ONE task. That is
 * correct for a test or a single-task staging environment, and it is why this
 * is not exposed on the operator surface: an operator flipping a scenario in
 * production would affect whichever task served their request.
 */

import { randomUUID } from 'node:crypto';
import type {
  SupplierAdapterCapability,
  SupplierCancellation,
  SupplierCredit,
  SupplierInvoice,
  SupplierOrderNormalizedState,
  SupplierOrderState,
  SupplierOrderSubmission,
  SupplierPreflightAnswer,
  SupplierReturn,
  SupplierShipment,
} from '@mercaria/shared-types';
import type {
  SupplierAdapterQuoteInput,
  SupplierAdapterReleaseInput,
} from '../../supplier-preflight/adapter.js';
import type {
  SupplierOrderAdapter,
  SupplierOrderCancelInput,
  SupplierOrderLookupInput,
  SupplierOrderPollInput,
  SupplierOrderReadInput,
  SupplierOrderSubmitInput,
  SupplierReturnInput,
  SupplierWebhookInput,
  SupplierWebhookVerification,
} from '../adapter.js';
import { SupplierProviderError } from '../provider-error.js';

/** The slug a `supplier_accounts.provider` must carry to reach this adapter. */
export const FAKE_ORDER_PROVIDER = 'mercaria-fake-order';

/** This adapter's mapping version. Bumping it is how a mapping change is dated. */
export const FAKE_ORDER_STATE_MAPPING_VERSION = 1;

/** The failures the conformance suite drives. */
export type FakeOrderScenario =
  | 'healthy'
  /** The response never came back and NOTHING was written — safe to retry. */
  | 'timeout_before_write'
  /** The response never came back and the order MAY exist — ambiguous. */
  | 'timeout_after_write'
  | 'rejected'
  /** Accepts nothing yet — the provider HAS the order and has not decided. */
  | 'received_only'
  | 'partial_acceptance'
  | 'partial_shipment'
  | 'cancel_accepted'
  | 'cancel_rejected'
  | 'cancel_ambiguous'
  | 'credential_expired'
  | 'rate_limited'
  | 'malformed_payload'
  /** Claims a state the mapping does not know — the unmapped-state probe. */
  | 'unmapped_state'
  /** Answers with line outcomes WITHOUT the capability — the honesty probe. */
  | 'undeclared_partial'
  /** Reports a state BEHIND what it already reported — the regression probe. */
  | 'state_regression';

/** SKU or client reference → the scenario it produces. Process-local. */
const scenarios = new Map<string, FakeOrderScenario>();

/** Orders this adapter believes it has, keyed on Mercaria's client reference. */
const placedOrders = new Map<string, SupplierOrderState>();

/** Whether the provider claims to deduplicate on the idempotency key. */
let honoursIdempotencyKeys = true;

/** Make one client reference produce one failure. */
export function injectFakeOrderScenario(clientReference: string, scenario: FakeOrderScenario): void {
  scenarios.set(clientReference, scenario);
}

/** Rehearse a provider WITHOUT idempotency support (#124 tests 2). */
export function setFakeOrderIdempotencySupport(honours: boolean): void {
  honoursIdempotencyKeys = honours;
}

/** What this adapter currently believes it holds — the conformance suite's oracle. */
export function fakeOrderStore(): ReadonlyMap<string, SupplierOrderState> {
  return placedOrders;
}

/** Forget every scenario and every placed order. */
export function clearFakeOrderState(): void {
  scenarios.clear();
  placedOrders.clear();
  honoursIdempotencyKeys = true;
}

/**
 * Every capability, deliberately.
 *
 * The point of a rehearsal adapter is to exercise the paths a fully-capable
 * supplier takes; the OTHER direction — an adapter claiming more than it
 * declared — is exercised by the `undeclared_partial` scenario, which answers
 * with line outcomes while the suite passes a narrowed capability list, so the
 * capability boundary has something real to refuse.
 */
const FAKE_ORDER_CAPABILITIES: readonly SupplierAdapterCapability[] = [
  'live_product_lookup',
  'live_stock_lookup',
  'destination_shipping_quote',
  'order_draft_validation',
  'inventory_reservation',
  'quote_expiry',
  'price_guarantee',
  'address_validation',
  'delivery_estimate',
  'tax_duty_estimate',
  'cancellation_before_submission',
  'update_notifications',
  'order_draft_submission',
  'order_state_read',
  'order_reference_lookup',
  'order_cancellation',
  'order_partial_acceptance',
  'shipment_read',
  'tracking_events',
  'invoice_retrieval',
  'credit_note_retrieval',
  'return_authorization',
  'order_webhooks',
  'order_polling',
];

/** The provider's own status vocabulary — deliberately not Mercaria's. */
const PROVIDER_STATES: Readonly<Record<string, SupplierOrderNormalizedState>> = {
  NEW: 'received',
  CONFIRMED: 'accepted',
  PART_CONFIRMED: 'partially_accepted',
  PICKING: 'processing',
  PART_DISPATCHED: 'partially_shipped',
  DISPATCHED: 'shipped',
  ARRIVED: 'delivered',
  REFUSED: 'rejected',
  VOIDED: 'cancelled',
};

const fakeOrderAdapter: SupplierOrderAdapter = {
  provider: FAKE_ORDER_PROVIDER,
  capabilities: FAKE_ORDER_CAPABILITIES,
  stateMappingVersion: FAKE_ORDER_STATE_MAPPING_VERSION,

  mapProviderState(providerState: string): SupplierOrderNormalizedState {
    // An unrecognized value answers `unknown` — never a guess. The
    // orchestration then records `unmapped_provider_state` and moves nothing,
    // which is how a provider adding a status is discovered.
    return PROVIDER_STATES[providerState] ?? 'unknown';
  },

  async quote(input: SupplierAdapterQuoteInput): Promise<SupplierPreflightAnswer> {
    assertNotLive(input.environment);
    // The order adapter's preflight half is deliberately minimal: #122's own
    // fake adapter is the one that rehearses quoting, and duplicating it here
    // would give two answers to one question.
    throw new SupplierProviderError({
      message: 'the fake ORDER adapter does not quote; use the fake preflight adapter',
      errorClass: 'terminal',
      afterWrite: false,
    });
  },

  async releaseReservation(input: SupplierAdapterReleaseInput): Promise<void> {
    assertNotLive(input.environment);
  },

  async validateDraft(input: SupplierOrderSubmitInput): Promise<SupplierOrderSubmission> {
    assertNotLive(input.environment);
    return acknowledgement('NEW', input.draft.clientReference, []);
  },

  async submitOrder(input: SupplierOrderSubmitInput): Promise<SupplierOrderSubmission> {
    assertNotLive(input.environment);
    const reference = input.draft.clientReference;
    const scenario = scenarios.get(reference) ?? 'healthy';

    if (scenario === 'credential_expired') {
      throw new SupplierProviderError({
        message: 'credential rejected',
        errorClass: 'auth',
        afterWrite: false,
      });
    }
    if (scenario === 'rate_limited') {
      throw new SupplierProviderError({
        message: 'too many requests',
        errorClass: 'quota',
        afterWrite: false,
        retryAfterMs: 30_000,
      });
    }
    if (scenario === 'malformed_payload') {
      throw new SupplierProviderError({
        message: 'unparseable response body',
        errorClass: 'unknown',
        afterWrite: false,
      });
    }
    if (scenario === 'timeout_before_write') {
      throw new SupplierProviderError({
        message: 'connection refused',
        errorClass: 'retryable',
        afterWrite: false,
      });
    }
    if (scenario === 'timeout_after_write') {
      // The order IS created, and the caller never learns it. This is the case
      // the whole convergence path exists for: a later lookup by client
      // reference finds it.
      placedOrders.set(reference, state('CONFIRMED', reference, []));
      throw new SupplierProviderError({
        message: 'socket hang up after request',
        errorClass: 'retryable',
        afterWrite: true,
      });
    }

    const existing = placedOrders.get(reference);
    if (existing && honoursIdempotencyKeys) {
      return { ...toSubmission(existing), duplicateOfExistingOrder: true };
    }
    if (existing && !honoursIdempotencyKeys) {
      // A provider WITHOUT idempotency would place a second order. The
      // orchestration must never reach here — the attempt log and the
      // convergence lookup are what stop it — so reaching it is a real failure
      // the conformance suite asserts against.
      throw new SupplierProviderError({
        message: 'a second order would have been created for this client reference',
        errorClass: 'validation',
        afterWrite: false,
      });
    }

    if (scenario === 'rejected') {
      return {
        ...acknowledgement('REFUSED', reference, []),
        reasonCode: 'out_of_stock',
        providerMessage: 'no stock for the requested item',
      };
    }
    if (scenario === 'unmapped_state') {
      return acknowledgement('SOMETHING_NEW', reference, []);
    }
    if (scenario === 'received_only') {
      // The order EXISTS at the provider and is not yet accepted, so the
      // purchase order stays `submitted` — the state a submission that is still
      // owed is also in. That collision is what the attempt log exists to tell
      // apart, and no other scenario produces it.
      const held = state('NEW', reference, []);
      placedOrders.set(reference, held);
      return toSubmission(held);
    }

    const lineOutcomes =
      scenario === 'partial_acceptance' || scenario === 'undeclared_partial'
        ? input.draft.lines.map((line, index) => ({
            clientLineReference: line.clientLineReference,
            kind: index === 0 ? ('accepted' as const) : ('rejected' as const),
            quantity: line.quantity,
            reasonCode: index === 0 ? null : ('out_of_stock' as const),
          }))
        : [];
    const providerState =
      scenario === 'partial_acceptance' || scenario === 'undeclared_partial'
        ? 'PART_CONFIRMED'
        : 'CONFIRMED';

    const placed = state(providerState, reference, lineOutcomes);
    placedOrders.set(reference, placed);
    return toSubmission(placed);
  },

  async findOrderByClientReference(
    input: SupplierOrderLookupInput,
  ): Promise<SupplierOrderState | null> {
    assertNotLive(input.environment);
    return placedOrders.get(input.clientReference) ?? null;
  },

  async readOrder(input: SupplierOrderReadInput): Promise<SupplierOrderState> {
    assertNotLive(input.environment);
    const order = [...placedOrders.values()].find(
      (candidate) => candidate.externalOrderId === input.externalOrderId,
    );
    if (!order) {
      throw new SupplierProviderError({
        message: 'no such order',
        errorClass: 'terminal',
        afterWrite: false,
      });
    }
    return order;
  },

  async cancelOrder(input: SupplierOrderCancelInput): Promise<SupplierCancellation> {
    assertNotLive(input.environment);
    const scenario = scenarios.get(input.clientReference) ?? 'cancel_accepted';
    if (scenario === 'cancel_ambiguous') {
      throw new SupplierProviderError({
        message: 'cancellation request timed out after send',
        errorClass: 'retryable',
        afterWrite: true,
      });
    }
    if (scenario === 'cancel_rejected') {
      return {
        state: 'rejected',
        reasonCode: 'supplier_cancelled',
        providerMessage: 'already dispatched',
        observedAt: new Date().toISOString(),
        lineOutcomes: [],
      };
    }
    const existing = placedOrders.get(input.clientReference);
    if (existing) {
      placedOrders.set(input.clientReference, {
        ...existing,
        state: 'cancelled',
        providerState: 'VOIDED',
        observedAt: new Date().toISOString(),
      });
    }
    return {
      state: 'accepted',
      reasonCode: 'operator_cancelled',
      providerMessage: null,
      observedAt: new Date().toISOString(),
      lineOutcomes: [],
    };
  },

  async readShipments(input: SupplierOrderReadInput): Promise<readonly SupplierShipment[]> {
    assertNotLive(input.environment);
    const order = [...placedOrders.values()].find(
      (candidate) => candidate.externalOrderId === input.externalOrderId,
    );
    return order?.shipments ?? [];
  },

  async readInvoice(input: SupplierOrderReadInput): Promise<SupplierInvoice | null> {
    assertNotLive(input.environment);
    return {
      documentReference: `fake-inv-${input.externalOrderId}`,
      documentNumber: 'INV-1',
      currency: 'EUR',
      totalAmount: 1_000,
      taxAmount: 210,
      issuedAt: new Date().toISOString(),
    };
  },

  async readCreditNotes(input: SupplierOrderReadInput): Promise<readonly SupplierCredit[]> {
    assertNotLive(input.environment);
    return [];
  },

  async createReturn(input: SupplierReturnInput): Promise<SupplierReturn> {
    assertNotLive(input.environment);
    return {
      returnReference: `fake-rma-${randomUUID()}`,
      state: 'requested',
      providerReason: input.reason ?? null,
      observedAt: new Date().toISOString(),
      lineOutcomes: [],
      returnLabelProvided: false,
    };
  },

  async readReturn(input: SupplierReturnInput): Promise<SupplierReturn> {
    assertNotLive(input.environment);
    return {
      returnReference: input.returnReference ?? 'fake-rma',
      state: 'authorized',
      providerReason: null,
      observedAt: new Date().toISOString(),
      lineOutcomes: [],
      returnLabelProvided: true,
    };
  },

  verifyWebhook(input: SupplierWebhookInput): SupplierWebhookVerification {
    // A shared-secret scheme over the RAW bytes. Deliberately not a
    // constant-time comparison stand-in: the conformance suite asserts that a
    // wrong secret is REFUSED, and a real adapter's own scheme is #125's.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { verified: false, reason: 'unparseable body' };
    }
    if (typeof parsed['secret'] !== 'string' || parsed['secret'] !== input.secret) {
      return { verified: false, reason: 'shared secret mismatch' };
    }
    const providerState = typeof parsed['status'] === 'string' ? parsed['status'] : '';
    const clientReference =
      typeof parsed['clientReference'] === 'string' ? parsed['clientReference'] : null;
    const externalOrderId =
      typeof parsed['externalOrderId'] === 'string' ? parsed['externalOrderId'] : null;
    const eventId = typeof parsed['eventId'] === 'string' ? parsed['eventId'] : randomUUID();
    const observedAt =
      typeof parsed['observedAt'] === 'string' ? new Date(parsed['observedAt']) : new Date();
    return {
      verified: true,
      verification: 'shared_secret',
      providerEventId: eventId,
      eventType: `order.${providerState.toLowerCase()}`,
      externalOrderId,
      clientReference,
      state: PROVIDER_STATES[providerState] ?? 'unknown',
      providerState,
      observedAt,
      payload: { orderStatus: providerState, externalOrderId, clientReference },
      shipments: [],
    };
  },

  async pollChanges(input: SupplierOrderPollInput): Promise<readonly SupplierOrderState[]> {
    assertNotLive(input.environment);
    return [...placedOrders.values()]
      .filter((order) => new Date(order.observedAt).getTime() >= input.since.getTime())
      .slice(0, input.limit);
  },
};

/** One order as this adapter holds it. */
function state(
  providerState: string,
  clientReference: string,
  lineOutcomes: SupplierOrderState['lineOutcomes'],
): SupplierOrderState {
  return {
    externalOrderId: `fake-ord-${clientReference}`,
    state: PROVIDER_STATES[providerState] ?? 'unknown',
    providerState,
    stateMappingVersion: FAKE_ORDER_STATE_MAPPING_VERSION,
    observedAt: new Date().toISOString(),
    reasonCode: null,
    providerMessage: null,
    total: null,
    lineOutcomes,
    duplicateOfExistingOrder: false,
    shipments: [],
    cancellable: true,
  };
}

/** The submission view of one held order. */
function toSubmission(order: SupplierOrderState): SupplierOrderSubmission {
  return {
    externalOrderId: order.externalOrderId,
    state: order.state,
    providerState: order.providerState,
    stateMappingVersion: order.stateMappingVersion,
    observedAt: order.observedAt,
    reasonCode: order.reasonCode,
    providerMessage: order.providerMessage,
    total: order.total,
    lineOutcomes: order.lineOutcomes,
    duplicateOfExistingOrder: order.duplicateOfExistingOrder,
  };
}

/** A bare acknowledgement with no stored order behind it. */
function acknowledgement(
  providerState: string,
  clientReference: string,
  lineOutcomes: SupplierOrderSubmission['lineOutcomes'],
): SupplierOrderSubmission {
  return toSubmission(state(providerState, clientReference, lineOutcomes));
}

/**
 * The gate a flag cannot defeat.
 *
 * A `live` supplier account is never served a fabricated answer, whatever
 * `PROCUREMENT_FAKE_ADAPTER_ENABLED` says. The consequence of getting this
 * wrong is worse than the preflight's: a fabricated ACCEPTANCE tells a customer
 * that goods nobody ordered are on their way.
 */
function assertNotLive(environment: 'test' | 'live'): void {
  if (environment === 'live') {
    throw new SupplierProviderError({
      message:
        'the fake supplier order adapter refuses a `live` supplier account: it fabricates ' +
        'acceptances, and a fabricated acceptance against a live account is a customer told ' +
        'that goods nobody ordered are coming',
      errorClass: 'terminal',
      afterWrite: false,
    });
  }
}

/** The adapter itself, for a suite that drives it without the registry. */
export function fakeOrderAdapterInstance(): SupplierOrderAdapter {
  return fakeOrderAdapter;
}
