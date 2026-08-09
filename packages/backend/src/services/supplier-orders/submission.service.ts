/**
 * Placing a supplier order, and never placing it twice (#124 submission
 * orchestration, idempotency and ambiguous outcomes).
 *
 * ## The sequence, and why each step is where it is
 *
 *  1. **Load the immutable intent** — the purchase order and its frozen lines
 *     (#118). Nothing is recomputed: the lines ARE the quote snapshot, and a
 *     source refresh cannot reach them.
 *  2. **Revalidate the payment authorization** through the #123 port. Every
 *     time, not once at creation: a refund, a cancellation or a moderation hold
 *     can land between the job being enqueued and the job running, and the only
 *     moment that matters is the one just before the supplier is called.
 *  3. **Refuse a HALTED order.** A duplicate supplier order or a detected
 *     substitution stops fulfilment while a person looks (#124 idempotency 7).
 *  4. **Converge an unresolved earlier attempt BEFORE anything else.** This is
 *     the step the whole issue is about, and it is why there is no plain
 *     "retry" path in this module at all: if the last submission attempt is
 *     `ambiguous` or still `in_flight`, the provider is ASKED whether it has an
 *     order under Mercaria's client reference, and a second submission is
 *     reachable only after that question has been answered "no".
 *  5. **Refuse a CHANGED request.** A resubmission whose canonical request
 *     differs from one that may already have been applied is not a retry, it is
 *     a second and different order.
 *  6. **Submit**, through the one chokepoint that logs the attempt before the
 *     call and normalizes the failure after it.
 *  7. **Apply the answer** — the external order id, the state, the line
 *     outcomes — and announce it.
 *
 * ## What makes a duplicate impossible rather than unlikely
 *
 * Four mechanisms, none of them a convention:
 *
 *  - `purchase_orders.idempotency_key` is `po:<orderId>:<supplierId>` and
 *    UNIQUE (#118), so there is one purchase order to submit however many times
 *    the fact is derived.
 *  - The outbox row's id is derived from the purchase order, so an operator
 *    retry and a redelivered payment consequence claim the SAME row rather than
 *    queueing a second submission.
 *  - The attempt row commits `in_flight` before the call, so a crash leaves
 *    evidence that a request may have landed.
 *  - `purchase_orders.supplier_external_order_id` is UNIQUE per account, so
 *    even if all of the above failed, two purchase orders could not both claim
 *    one supplier order — the database refuses it, and the refusal becomes a
 *    `duplicate_external_order` exception.
 */

import type {
  Money,
  SupplierAdapterCapability,
  SupplierOrderDraft,
  SupplierOrderLine,
  SupplierOrderState,
  SupplierOrderSubmission,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  attachSupplierExternalOrderId,
  findPurchaseOrderById,
  findPurchaseOrderLines,
  type PurchaseOrderLineRecord,
  type PurchaseOrderRecord,
} from '../../db/procurement/purchaseOrderRepository.js';
import {
  findLatestSupplierOrderAttempt,
  supplierOrderRequestDiffersFromPrior,
} from '../../db/supplierOrders/attemptRepository.js';
import { purchaseOrderHasHaltingException } from '../../db/supplierOrders/exceptionRepository.js';
import {
  applySupplierAcceptance,
  applySupplierRejection,
  submitPurchaseOrder,
} from '../procurement/purchase-order.service.js';
import { applyDeclaredOrderCapabilities } from './adapter.js';
import {
  deriveSubmissionIdempotencyKey,
  deriveSupplierClientReference,
  digestSupplierOrderRequest,
} from './client-reference.js';
import { raiseProcurementExceptionFor } from './exception.service.js';
import { readProcurementPaymentAuthorization } from './payment-authorization.port.js';
import { callSupplierProvider } from './provider-call.js';
import {
  enqueueProcurementEvent,
  purchaseOrderAcceptedEventId,
  purchaseOrderRejectedEventId,
  purchaseOrderStatusPollEventId,
} from './procurement-outbox.service.js';
import { applyProviderObservation } from './observation.service.js';

/** What one submission attempt concluded. */
export type SubmissionOutcome =
  | { outcome: 'submitted'; purchaseOrderId: string; externalOrderId: string | null }
  | { outcome: 'converged'; purchaseOrderId: string; externalOrderId: string | null }
  | { outcome: 'rejected'; purchaseOrderId: string; reason: string }
  | { outcome: 'ambiguous'; purchaseOrderId: string }
  | { outcome: 'refused'; purchaseOrderId: string; reason: string }
  | { outcome: 'already_submitted'; purchaseOrderId: string };

/**
 * Submit one purchase order to its supplier, converging on anything already
 * done.
 *
 * Idempotent by construction: calling it twice on a purchase order that reached
 * `submitted` answers `already_submitted` without touching the provider, and
 * calling it twice on one whose first attempt was ambiguous converges through
 * the lookup rather than submitting again.
 */
export async function submitPurchaseOrderToSupplier(
  purchaseOrderId: string,
): Promise<SubmissionOutcome> {
  const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
  if (!purchaseOrder) {
    throw new Error(`submitPurchaseOrderToSupplier: purchase order ${purchaseOrderId} not found`);
  }
  if (purchaseOrder.status !== 'draft' && purchaseOrder.status !== 'submitted') {
    return { outcome: 'already_submitted', purchaseOrderId };
  }

  const authorization = await readProcurementPaymentAuthorization(purchaseOrder.orderId);
  // `=== false` rather than `!`: this package compiles with `strict: false`, and
  // truthiness narrowing of a BOOLEAN discriminant is disabled without
  // `strictNullChecks`. An equality comparison narrows either way, so it is what
  // every boolean-discriminated union in this domain is read with.
  if (authorization.authorized === false) {
    await raiseProcurementExceptionFor({
      kind: 'stuck_purchase_order',
      purchaseOrder,
      detail: `submission refused: payment authorization answered \`${authorization.reason}\``,
    });
    return { outcome: 'refused', purchaseOrderId, reason: authorization.reason };
  }

  if (await purchaseOrderHasHaltingException(purchaseOrderId)) {
    return { outcome: 'refused', purchaseOrderId, reason: 'purchase_order_halted' };
  }

  const lines = await findPurchaseOrderLines(purchaseOrderId);
  if (lines.length === 0) {
    throw new Error(`submitPurchaseOrderToSupplier: purchase order ${purchaseOrderId} has no lines`);
  }
  const draft = composeSupplierOrderDraft(purchaseOrder, lines);
  const requestHash = digestSupplierOrderRequest(draft);

  // Step 4 — the one that matters. An unresolved earlier attempt is asked
  // about, never retried past.
  const previous = await findLatestSupplierOrderAttempt({
    purchaseOrderId,
    operation: 'submit',
  });
  // A submission that SUCCEEDED is the end of it, whatever the purchase order's
  // status says. The status alone is not enough: a provider that answers
  // `received` leaves the order `submitted`, which is also the state it is in
  // while a submission is owed — so keying on it would resubmit an order the
  // supplier already has, every time the outbox retried.
  if (previous && (previous.outcome === 'succeeded' || previous.outcome === 'converged')) {
    return { outcome: 'already_submitted', purchaseOrderId };
  }
  if (previous && (previous.outcome === 'ambiguous' || previous.outcome === 'in_flight')) {
    const converged = await convergeAmbiguousSubmission(purchaseOrder, draft);
    if (converged.outcome !== 'not_found') return converged.result;
  }

  // Step 5. The comparison happens in SQL against the digest of what was
  // actually sent, so "differs" is a fact rather than a claim.
  if (
    await supplierOrderRequestDiffersFromPrior({ purchaseOrderId, operation: 'submit', requestHash })
  ) {
    await raiseProcurementExceptionFor({
      kind: 'cost_mismatch',
      purchaseOrder,
      detail:
        'a submission was attempted with a request that differs from one already sent for this ' +
        'purchase order; the earlier request may have been applied, so this one is not a retry',
    });
    return { outcome: 'refused', purchaseOrderId, reason: 'request_changed' };
  }

  const call = await callSupplierProvider<SupplierOrderSubmission>({
    purchaseOrderId,
    supplierAccountId: purchaseOrder.supplierAccountId,
    supplierId: purchaseOrder.supplierId,
    operation: 'submit',
    requestHash,
    providerObjectIdOf: (answer) => answer.externalOrderId,
    invoke: async ({ adapter, providerAccountId, environment, credential, timeoutMs }) => {
      if (!adapter.submitOrder) {
        throw new Error(`adapter ${adapter.provider} declares order_draft_submission with no method`);
      }
      return await adapter.submitOrder({
        providerAccountId,
        environment,
        credential,
        timeoutMs,
        draft,
        idempotencyKey: deriveSubmissionIdempotencyKey(purchaseOrderId),
      });
    },
  });

  // The purchase order moves to `submitted` whatever the provider answered,
  // INCLUDING an ambiguous outcome — Mercaria did submit it, and leaving it
  // `draft` would let the acceptance-deadline sweep believe nothing was ever
  // sent while a supplier holds an order under this client reference.
  if (purchaseOrder.status === 'draft') await submitPurchaseOrder(purchaseOrderId);

  if (call.outcome === 'refused') {
    return { outcome: 'refused', purchaseOrderId, reason: call.reason };
  }
  if (call.outcome === 'ambiguous') {
    await raiseProcurementExceptionFor({
      kind: 'ambiguous_submission',
      purchaseOrder,
      detail: `submission outcome unknown: ${call.message}`,
    });
    return { outcome: 'ambiguous', purchaseOrderId };
  }
  if (call.outcome === 'failed') {
    // A definite failure with nothing written. The outbox retries it, and the
    // attempt log shows the class it failed with.
    if (call.retryable) throw new Error(`supplier submission failed: ${call.message}`);
    await applySupplierRejection({
      purchaseOrderId,
      reasonCode: 'supplier_error',
      supplierNote: call.message,
    });
    await announceRejected(purchaseOrderId);
    return { outcome: 'rejected', purchaseOrderId, reason: call.message };
  }

  return await applySubmissionAnswer(purchaseOrder, call.answer, call.adapter.capabilities);
}

/** What a convergence lookup concluded. */
type ConvergenceOutcome =
  | { outcome: 'resolved'; result: SubmissionOutcome }
  | { outcome: 'not_found' };

/**
 * Ask the provider whether it already has an order under Mercaria's client
 * reference (#124 idempotency 3, acceptance 2).
 *
 * A provider that did not declare `order_reference_lookup` cannot be asked, and
 * that is where an ambiguity becomes an operator's row rather than another
 * attempt: `unconverged_submission`, with the purchase order flagged for
 * intervention. Retrying blind would place the second order, and refusing
 * forever would strand a paid customer — so the honest third answer is to stop
 * and say so.
 */
async function convergeAmbiguousSubmission(
  purchaseOrder: PurchaseOrderRecord,
  draft: SupplierOrderDraft,
): Promise<ConvergenceOutcome> {
  const requestHash = digestSupplierOrderRequest(draft);
  const call = await callSupplierProvider<SupplierOrderState | null>({
    purchaseOrderId: purchaseOrder.id,
    supplierAccountId: purchaseOrder.supplierAccountId,
    supplierId: purchaseOrder.supplierId,
    operation: 'reference_lookup',
    requestHash,
    providerObjectIdOf: (answer) => answer?.externalOrderId ?? null,
    invoke: async ({ adapter, providerAccountId, environment, credential, timeoutMs }) => {
      if (!adapter.findOrderByClientReference) {
        throw new Error(
          `adapter ${adapter.provider} declares order_reference_lookup with no method`,
        );
      }
      return await adapter.findOrderByClientReference({
        providerAccountId,
        environment,
        credential,
        timeoutMs,
        clientReference: deriveSupplierClientReference(purchaseOrder.id),
      });
    },
  });

  if (call.outcome === 'refused' && call.reason === 'capability_not_declared') {
    await raiseProcurementExceptionFor({
      kind: 'unconverged_submission',
      purchaseOrder,
      detail:
        'a submission outcome is unknown and this provider declares no lookup by client ' +
        'reference, so it cannot be resolved automatically; retrying would risk a second ' +
        'supplier order',
      flagOperator: true,
    });
    return { outcome: 'resolved', result: { outcome: 'refused', purchaseOrderId: purchaseOrder.id, reason: 'unconverged' } };
  }
  if (call.outcome !== 'succeeded') {
    // The lookup itself failed. The ambiguity stands and the outbox retries;
    // nothing is submitted in the meantime, which is the safe direction.
    return {
      outcome: 'resolved',
      result: { outcome: 'ambiguous', purchaseOrderId: purchaseOrder.id },
    };
  }
  if (call.answer === null) {
    // The provider has no order under our reference. The earlier attempt wrote
    // nothing, and submission may proceed — the ONE path on which a second
    // submission is reachable.
    log.general.info(
      { purchaseOrderId: purchaseOrder.id },
      '[Procurement] ambiguous submission converged: provider has no such order',
    );
    return { outcome: 'not_found' };
  }

  const applied = await applySubmissionAnswer(purchaseOrder, call.answer, call.adapter.capabilities);
  return {
    outcome: 'resolved',
    result:
      applied.outcome === 'submitted'
        ? { outcome: 'converged', purchaseOrderId: purchaseOrder.id, externalOrderId: applied.externalOrderId }
        : applied,
  };
}

/**
 * Apply a submission or lookup answer to the purchase order.
 *
 * Shared by both paths deliberately: converging on an order the provider
 * already had must produce exactly the state a first submission would have, or
 * a converged order and a plainly submitted one would be distinguishable
 * downstream for no reason anybody could act on.
 */
async function applySubmissionAnswer(
  purchaseOrder: PurchaseOrderRecord,
  answer: SupplierOrderSubmission,
  capabilities: readonly SupplierAdapterCapability[],
): Promise<SubmissionOutcome> {
  const bounded = applyDeclaredOrderCapabilities(answer, capabilities);
  if (bounded.downgrades.length > 0) {
    await raiseProcurementExceptionFor({
      kind: 'capability_not_declared',
      purchaseOrder,
      detail: `provider claimed more than it declared: ${bounded.downgrades
        .map((entry) => entry.commitment)
        .join(', ')}`,
    });
  }
  const applied = bounded.answer;

  if (applied.externalOrderId) {
    const attached = await attachSupplierExternalOrderId({
      purchaseOrderId: purchaseOrder.id,
      supplierExternalOrderId: applied.externalOrderId,
    });
    if (!attached) {
      const current = await findPurchaseOrderById(purchaseOrder.id);
      if (current?.supplierExternalOrderId !== applied.externalOrderId) {
        // Two different supplier orders now claim to be this purchase order's.
        // That is the failure the whole domain exists to prevent, so it halts
        // fulfilment rather than picking one.
        await raiseProcurementExceptionFor({
          kind: 'duplicate_external_order',
          purchaseOrder,
          detail: 'the provider returned a second, different order id for this purchase order',
          flagOperator: true,
        });
        return { outcome: 'refused', purchaseOrderId: purchaseOrder.id, reason: 'duplicate_external_order' };
      }
    }
  }

  if (applied.state === 'rejected') {
    await applySupplierRejection({
      purchaseOrderId: purchaseOrder.id,
      reasonCode: applied.reasonCode ?? 'supplier_error',
      ...(applied.providerMessage ? { supplierNote: applied.providerMessage } : {}),
    });
    await announceRejected(purchaseOrder.id);
    return { outcome: 'rejected', purchaseOrderId: purchaseOrder.id, reason: applied.reasonCode ?? 'supplier_error' };
  }

  if (applied.state === 'accepted' || applied.state === 'partially_accepted') {
    await applySupplierAcceptance({
      purchaseOrderId: purchaseOrder.id,
      ...(applied.externalOrderId ? { supplierExternalOrderId: applied.externalOrderId } : {}),
      ...(applied.providerMessage ? { supplierNote: applied.providerMessage } : {}),
      at: new Date(applied.observedAt),
    });
    await announceAccepted(purchaseOrder.id);
  }

  // Everything else — `received`, `processing`, a shipment already reported —
  // goes through the ONE observation path, so a submission answer and a webhook
  // reporting the same thing take the same route and cannot disagree.
  await applyProviderObservation({
    purchaseOrderId: purchaseOrder.id,
    observation: applied,
    capabilities,
  });

  await schedulePolling(purchaseOrder.id);

  return {
    outcome: 'submitted',
    purchaseOrderId: purchaseOrder.id,
    externalOrderId: applied.externalOrderId,
  };
}

/**
 * Compose what the supplier is sent.
 *
 * The destination comes from the purchase order's own redacted snapshot (#118),
 * which is the ONLY place a fulfilment address lives in this half of the
 * system. Amounts are asserted at this boundary because every money value
 * crossing into a provider request is a construction boundary
 * (`assertSafeMoneyAmount`'s rule), and because a supplier that echoes an
 * absurd total back would otherwise be reconciled against one.
 */
export function composeSupplierOrderDraft(
  purchaseOrder: PurchaseOrderRecord,
  lines: readonly PurchaseOrderLineRecord[],
): SupplierOrderDraft {
  const currency = purchaseOrder.currency;
  const orderLines: SupplierOrderLine[] = lines.map((line) => {
    assertSafeMoneyAmount(line.unitCostAmount, 'supplier order line unit cost');
    assertSafeMoneyAmount(line.lineTotalAmount, 'supplier order line total');
    return {
      clientLineReference: line.id,
      supplierSku: line.supplierSku,
      quantity: line.quantity,
      expectedUnitCost: money(line.unitCostAmount, currency),
      expectedLineTotal: money(line.lineTotalAmount, currency),
      description: line.description,
    };
  });
  assertSafeMoneyAmount(purchaseOrder.totalAmount, 'supplier order total');

  return {
    clientReference: deriveSupplierClientReference(purchaseOrder.id),
    currency,
    lines: orderLines,
    destination: {
      recipient: {
        name: purchaseOrder.destinationRecipientName,
        company: null,
        phone: purchaseOrder.destinationPhone,
      },
      address: {
        line1: purchaseOrder.destinationLine1,
        line2: purchaseOrder.destinationLine2,
        city: purchaseOrder.destinationCity,
        region: purchaseOrder.destinationRegion,
        postalCode: purchaseOrder.destinationPostalCode,
        country: purchaseOrder.destinationCountry,
      },
      deliveryInstructions: null,
    },
    shippingServiceCode: null,
    quoteReference: purchaseOrder.quoteRef,
    reservationReference: null,
    expectedTotal: money(purchaseOrder.totalAmount, currency),
  };
}

function money(amount: number, currency: PurchaseOrderRecord['currency']): Money {
  return { amount, currency };
}

/** Announce an acceptance once — the #126/#128 seam. */
async function announceAccepted(purchaseOrderId: string): Promise<void> {
  await enqueueProcurementEvent(getDb(), {
    id: purchaseOrderAcceptedEventId(purchaseOrderId),
    eventType: 'purchase_order_accepted',
    payload: { purchaseOrderId },
  });
}

/** Announce a rejection once — the compensating-refund seam (ADR 0004 D4 step 5). */
async function announceRejected(purchaseOrderId: string): Promise<void> {
  await enqueueProcurementEvent(getDb(), {
    id: purchaseOrderRejectedEventId(purchaseOrderId),
    eventType: 'purchase_order_rejected',
    payload: { purchaseOrderId },
  });
}

/**
 * Start polling this purchase order.
 *
 * ONE row for its whole life, which reschedules itself. Enqueued after a
 * submission rather than at creation, because an unsubmitted order has nothing
 * at the provider to poll for and a poll row waiting on one would spin.
 */
async function schedulePolling(purchaseOrderId: string): Promise<void> {
  await enqueueProcurementEvent(getDb(), {
    id: purchaseOrderStatusPollEventId(purchaseOrderId),
    eventType: 'purchase_order_status_poll',
    payload: { purchaseOrderId },
    availableAt: new Date(Date.now() + config.procurement.pollMinIntervalMs),
  });
}
