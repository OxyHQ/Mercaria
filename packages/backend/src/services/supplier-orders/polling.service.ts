/**
 * Asking a supplier what has changed, within its limits (#124 polling and
 * webhooks 5–7, 9).
 *
 * Webhooks are the normal path. Polling exists for the providers that have
 * none, and as the reconciliation for the ones that do: an event that was never
 * delivered is invisible to everything that waits to be told — the #50 sentence,
 * one domain over.
 *
 * ## One poll row per purchase order, for its whole life
 *
 * The outbox row's id is derived from the purchase order and the handler
 * RESCHEDULES it rather than enqueueing another, so an order can never
 * accumulate a queue of poll jobs. The reschedule is not a failure: it resets
 * the attempt counter, because a poll that answered is a success and counting
 * it as one would dead-letter a perfectly healthy order after twenty-five
 * passes.
 *
 * ## Terminal orders are confirmed for a bounded period and then let go
 *
 * A delivered or cancelled order still gets polled for
 * `PROCUREMENT_POLL_TERMINAL_GRACE_MS`, because a late correction (a delivery
 * that bounced, a cancellation the supplier reversed) arrives after the state
 * that looks final. After the grace the row is completed and polling STOPS —
 * an unbounded confirmation loop is how a provider's rate budget is spent on
 * orders nobody is waiting for.
 *
 * ## Disagreement between a webhook and a poll is RECORDED, never averaged
 *
 * Both paths go through `applyProviderObservation`, so the monotonic guard
 * decides which is newer and the regression check decides whether the older one
 * is a correction. A poll that reports an EARLIER state than a webhook already
 * applied does not overwrite it — it raises `webhook_poll_disagreement`, which
 * is #124 item 7's "reconcile explicitly" rather than a rule about which source
 * wins.
 */

import type { SupplierOrderState } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  findPurchaseOrderById,
  type PurchaseOrderRecord,
} from '../../db/procurement/purchaseOrderRepository.js';
import { findSupplierAccountById } from '../../db/procurement/supplierAccountRepository.js';
import { applyDeclaredOrderStateCapabilities } from './adapter.js';
import { digestSupplierValue } from './redact.js';
import { ingestSupplierEvent } from './event-ingest.service.js';
import { raiseProcurementExceptionFor } from './exception.service.js';
import { applyProviderObservation } from './observation.service.js';
import { callSupplierProvider } from './provider-call.js';
import { ProcurementReschedule } from './procurement-outbox.service.js';

/** The purchase-order statuses nothing further can arrive for. */
const TERMINAL_STATUSES = new Set(['delivered', 'rejected', 'expired', 'cancelled']);

/**
 * Poll one purchase order once, then reschedule or stop.
 *
 * Throws {@link ProcurementReschedule} on the ordinary path — the outbox reads
 * it as "not done, not failing" and puts the row back with a fresh deadline.
 * Returning normally means polling is FINISHED for this order, which the outbox
 * records by completing the row.
 */
export async function pollPurchaseOrderStatus(purchaseOrderId: string): Promise<void> {
  const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
  if (!purchaseOrder) return;

  if (isPastTerminalGrace(purchaseOrder)) {
    log.general.debug(
      { purchaseOrderId, status: purchaseOrder.status },
      '[Procurement] polling finished: terminal past its confirmation window',
    );
    return;
  }
  if (!purchaseOrder.supplierExternalOrderId) {
    // Nothing to read yet: the submission has not produced an id, or produced
    // one that is still ambiguous. The convergence path owns that; polling just
    // waits rather than inventing a handle.
    throw new ProcurementReschedule(nextPollAt());
  }

  const externalOrderId = purchaseOrder.supplierExternalOrderId;
  const call = await callSupplierProvider<SupplierOrderState>({
    purchaseOrderId,
    supplierAccountId: purchaseOrder.supplierAccountId,
    supplierId: purchaseOrder.supplierId,
    operation: 'read',
    requestHash: digestSupplierValue(`read:${purchaseOrderId}:${externalOrderId}`),
    providerObjectIdOf: (answer) => answer.externalOrderId,
    invoke: async ({ adapter, providerAccountId, environment, credential, timeoutMs }) => {
      if (!adapter.readOrder) {
        throw new Error(`adapter ${adapter.provider} declares order_state_read with no method`);
      }
      return await adapter.readOrder({
        providerAccountId,
        environment,
        credential,
        timeoutMs,
        externalOrderId,
      });
    },
  });

  if (call.outcome !== 'succeeded') {
    // Every non-success is a reason to try again later, including a refusal:
    // a paused fetch lever, an exhausted lease and a killed account are all
    // conditions that end, and the poll row is what remembers to come back.
    throw new ProcurementReschedule(nextPollAt());
  }

  const bounded = applyDeclaredOrderStateCapabilities(call.answer, call.adapter.capabilities);
  if (bounded.downgrades.length > 0) {
    await raiseProcurementExceptionFor({
      kind: 'capability_not_declared',
      purchaseOrder,
      detail: `a polled answer claimed more than the adapter declared: ${bounded.downgrades
        .map((entry) => entry.commitment)
        .join(', ')}`,
    });
  }
  const answer = bounded.answer;

  // Stored FIRST, exactly as a webhook is: a poll is an observation, and an
  // observation Mercaria acted on but did not record is one nobody can audit.
  const account = await findSupplierAccountById(purchaseOrder.supplierAccountId);
  const stored = await ingestSupplierEvent({
    supplierAccountId: purchaseOrder.supplierAccountId,
    provider: account?.provider ?? 'unknown',
    delivery: 'poll',
    verification: 'authenticated_poll',
    eventType: `poll:${answer.providerState}`,
    externalOrderId: answer.externalOrderId,
    clientReference: null,
    state: answer.state,
    providerState: answer.providerState,
    stateMappingVersion: answer.stateMappingVersion,
    observedAt: new Date(answer.observedAt),
    payload: { orderStatus: answer.providerState, externalOrderId: answer.externalOrderId },
    shipments: answer.shipments,
  });

  const applied = await applyProviderObservation({
    purchaseOrderId,
    observation: answer,
    capabilities: call.adapter.capabilities,
    shipments: answer.shipments,
    providerEventId: stored.event.id,
  });

  // A poll reporting something a webhook already superseded is ordinary and
  // silent. A poll reporting a state BEHIND what was applied, with its own
  // clock ahead, is the disagreement item 7 asks to be explicit about — and
  // `applyProviderObservation` has already raised it as a regression, so this
  // branch only adds the fact that the two SOURCES differed.
  if (applied.applied === false && applied.reason === 'regression') {
    await raiseProcurementExceptionFor({
      kind: 'webhook_poll_disagreement',
      purchaseOrder,
      detail: `a poll reported \`${answer.providerState}\` while a later state was already applied`,
      providerEventId: stored.event.id,
    });
  }

  const refreshed = await findPurchaseOrderById(purchaseOrderId);
  if (refreshed && isPastTerminalGrace(refreshed)) return;
  throw new ProcurementReschedule(nextPollAt());
}

/** When the next poll of one order may happen — never sooner than the limit. */
function nextPollAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + config.procurement.pollMinIntervalMs);
}

/**
 * Whether a terminal order is past its confirmation window.
 *
 * Measured from the terminal timestamp the order itself carries, not from the
 * poll's own clock, so a task that was down for a day does not restart the
 * grace period — the window is a property of the order, not of the loop.
 */
function isPastTerminalGrace(purchaseOrder: PurchaseOrderRecord, now: Date = new Date()): boolean {
  if (!TERMINAL_STATUSES.has(purchaseOrder.status)) return false;
  const reached =
    purchaseOrder.deliveredAt ?? purchaseOrder.cancelledAt ?? purchaseOrder.updatedAt;
  return now.getTime() - reached.getTime() >= config.procurement.pollTerminalGraceMs;
}
