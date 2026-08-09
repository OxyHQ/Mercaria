/**
 * Applying ONE provider observation to a purchase order — the single path a
 * webhook, a poll, a submission answer and a convergence lookup all take.
 *
 * Four call sites, one body, deliberately. Each of them learns the same kind of
 * thing (the provider says this order is now in this state, as of this instant)
 * and each of them would otherwise grow its own version of the monotonic guard,
 * the regression check and the legality check — three rules that must not
 * differ between "we were told" and "we asked".
 *
 * ## Nothing here overwrites history
 *
 * `purchase_order_transitions` is append-only (#118), so the trail is safe by
 * construction. What this module adds is that the CURRENT state is only ever
 * moved forward: a stale observation is recorded and ignored, a regression is
 * recorded and raised, and an illegal edge is recorded and raised. In none of
 * those branches is a status written — which is what "never overwrite history
 * when a provider regresses or corrects a state" means for the live row.
 *
 * ## The order of the two writes
 *
 * The provider-state stamp advances AFTER the status transition, not before. If
 * the transition fails its compare-and-swap — another task applied a different
 * observation first — the stamp must not have moved, or the observation that
 * actually won would look older than the one that lost and the next delivery
 * would be admitted against the wrong baseline.
 */

import type {
  SupplierAdapterCapability,
  SupplierOrderNormalizedState,
  SupplierOrderSubmission,
  SupplierShipment,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import {
  advancePurchaseOrderProviderState,
  findPurchaseOrderById,
  findPurchaseOrderLines,
  recordPurchaseOrderShipment,
  transitionPurchaseOrder,
  type PurchaseOrderRecord,
} from '../../db/procurement/purchaseOrderRepository.js';
import {
  recordPurchaseOrderLineOutcome,
  recordPurchaseOrderTrackingEvent,
} from '../../db/supplierOrders/evidenceRepository.js';
import {
  PURCHASE_ORDER_LEGAL_TRANSITIONS,
  markPurchaseOrderDelivered,
} from '../procurement/purchase-order.service.js';
import { raiseProcurementExceptionFor } from './exception.service.js';
import { redactSupplierOrderMessage } from './redact.js';
import { decideProviderObservation } from './state-mapping.js';

/** One observation, from whichever path saw it. */
export interface ProviderObservationApplication {
  purchaseOrderId: string;
  observation: SupplierOrderSubmission;
  capabilities: readonly SupplierAdapterCapability[];
  /** Parcels this observation reported, when it reported any. */
  shipments?: readonly SupplierShipment[];
  /** The stored event this came from, so evidence can cite it. */
  providerEventId?: string;
}

/** What applying one observation did. */
export type ProviderObservationResult =
  | { applied: true; nextStatus: string }
  | { applied: false; reason: 'stale' | 'regression' | 'unmapped' | 'illegal' | 'lost_race' | 'no_change' };

/**
 * Apply one observation, or record why it was not applied.
 *
 * Never throws for a provider disagreement: a regression, an unmapped state and
 * an illegal edge are all conditions a person resolves, and throwing would
 * route them into the outbox's retry — which would re-ask the same provider the
 * same question and get the same answer, forever.
 */
export async function applyProviderObservation(
  input: ProviderObservationApplication,
): Promise<ProviderObservationResult> {
  const purchaseOrder = await findPurchaseOrderById(input.purchaseOrderId);
  if (!purchaseOrder) {
    throw new Error(`applyProviderObservation: purchase order ${input.purchaseOrderId} not found`);
  }

  const observedAt = new Date(input.observation.observedAt);
  const decision = decideProviderObservation({
    currentStatus: purchaseOrder.status,
    appliedState: appliedStateOf(purchaseOrder),
    appliedObservedAt: purchaseOrder.providerStateObservedAt,
    observedState: input.observation.state,
    observedAt,
    legalNextStatuses: PURCHASE_ORDER_LEGAL_TRANSITIONS[purchaseOrder.status],
  });

  if (decision.action === 'ignore_stale') {
    log.general.debug(
      { purchaseOrderId: purchaseOrder.id, observedAt: input.observation.observedAt },
      '[Procurement] observation is older than what was applied; recorded and ignored',
    );
    return { applied: false, reason: 'stale' };
  }
  if (decision.action === 'raise_unmapped') {
    await raiseProcurementExceptionFor({
      kind: 'unmapped_provider_state',
      purchaseOrder,
      detail: `the provider reported \`${input.observation.providerState}\`, which this adapter's mapping does not recognise`,
      ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
    });
    return { applied: false, reason: 'unmapped' };
  }
  if (decision.action === 'raise_regression') {
    await raiseProcurementExceptionFor({
      kind: 'provider_state_regression',
      purchaseOrder,
      detail: `the provider moved backwards to \`${input.observation.providerState}\` from a later state; the machine was left where it is`,
      ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
    });
    return { applied: false, reason: 'regression' };
  }
  if (decision.action === 'raise_illegal_transition') {
    // The particular illegal edge worth naming: a shipment or an acceptance
    // arriving on an order Mercaria has already cancelled or refunded. ADR 0004
    // concern 9 routes that to #127's return-to-supplier path, and it starts
    // here, as a halting condition rather than a forced transition.
    const kind =
      purchaseOrder.status === 'cancelled' || purchaseOrder.status === 'rejected'
        ? decision.nextStatus === 'shipped'
          ? 'shipment_after_cancellation'
          : 'late_acceptance_after_cancellation'
        : 'provider_state_regression';
    await raiseProcurementExceptionFor({
      kind,
      purchaseOrder,
      detail: `the provider reported \`${input.observation.providerState}\`, which would move this purchase order from \`${purchaseOrder.status}\` to \`${decision.nextStatus}\` — not an edge the machine has`,
      ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
    });
    return { applied: false, reason: 'illegal' };
  }

  await recordEvidence(purchaseOrder, input, observedAt);

  if (decision.action === 'advance_only') {
    await advancePurchaseOrderProviderState({
      purchaseOrderId: purchaseOrder.id,
      providerState: input.observation.providerState,
      observedAt,
      stateMappingVersion: input.observation.stateMappingVersion,
    });
    return { applied: false, reason: 'no_change' };
  }

  // `delivered` goes through the purchase-order service's own transition so the
  // machine's legality assertion runs, rather than being spelled a second time
  // here. Everything else is the generic CAS.
  const moved =
    decision.nextStatus === 'delivered'
      ? await markPurchaseOrderDelivered(purchaseOrder.id, observedAt)
      : await transitionPurchaseOrder({
          purchaseOrderId: purchaseOrder.id,
          expected: purchaseOrder.status,
          next: decision.nextStatus,
          initiator: 'supplier',
          ...(input.observation.reasonCode ? { reasonCode: input.observation.reasonCode } : {}),
          ...(input.observation.providerMessage
            ? { supplierNote: redactSupplierOrderMessage(input.observation.providerMessage) }
            : {}),
          at: observedAt,
          patch: {
            ...(decision.nextStatus === 'accepted' ? { acceptedAt: observedAt } : {}),
            ...(decision.nextStatus === 'shipped' ? { shippedAt: observedAt } : {}),
            ...(decision.nextStatus === 'cancelled' || decision.nextStatus === 'rejected'
              ? { cancelledAt: observedAt }
              : {}),
            providerState: input.observation.providerState,
            providerStateObservedAt: observedAt,
            stateMappingVersion: input.observation.stateMappingVersion,
          },
        });

  if (!moved) {
    // Another task applied a different observation first. The stamp is NOT
    // advanced — see the module docblock.
    return { applied: false, reason: 'lost_race' };
  }
  if (decision.nextStatus === 'delivered') {
    await advancePurchaseOrderProviderState({
      purchaseOrderId: purchaseOrder.id,
      providerState: input.observation.providerState,
      observedAt,
      stateMappingVersion: input.observation.stateMappingVersion,
    });
  }
  return { applied: true, nextStatus: decision.nextStatus };
}

/**
 * Record the line-level and parcel evidence an observation carried.
 *
 * Runs BEFORE the status decision is executed and on every non-refused branch,
 * because evidence is worth keeping whether or not it moved anything — a
 * partial shipment reported on an order already `shipped` changes no status and
 * is exactly what a customer's tracking page needs.
 */
async function recordEvidence(
  purchaseOrder: PurchaseOrderRecord,
  input: ProviderObservationApplication,
  observedAt: Date,
): Promise<void> {
  if (input.observation.lineOutcomes.length > 0) {
    const lines = await findPurchaseOrderLines(purchaseOrder.id);
    const byId = new Map(lines.map((line) => [line.id, line]));
    for (const outcome of input.observation.lineOutcomes) {
      const line = byId.get(outcome.clientLineReference);
      if (!line) {
        // A line reference Mercaria never sent. Recorded rather than dropped:
        // it is either a provider bug or a substitution, and both need a person
        // (ADR 0004 D9.5 — a substitution is never a success).
        await raiseProcurementExceptionFor({
          kind: 'substitution_detected',
          purchaseOrder,
          detail: `the provider reported an outcome for a line reference this purchase order does not contain`,
          ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        });
        continue;
      }
      await recordPurchaseOrderLineOutcome({
        purchaseOrderId: purchaseOrder.id,
        purchaseOrderLineId: line.id,
        kind: outcome.kind,
        quantity: outcome.quantity,
        ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        observedAt,
      });
    }
  }

  for (const shipment of input.shipments ?? []) {
    const parcel = await recordPurchaseOrderShipment({
      purchaseOrderId: purchaseOrder.id,
      trackingNumber: shipment.trackingNumber,
      ...(shipment.carrier ? { carrier: shipment.carrier } : {}),
      ...(shipment.service ? { service: shipment.service } : {}),
      shippedAt: new Date(shipment.shippedAt),
      ...(shipment.deliveredAt ? { deliveredAt: new Date(shipment.deliveredAt) } : {}),
    });
    for (const scan of shipment.trackingEvents) {
      await recordPurchaseOrderTrackingEvent({
        purchaseOrderId: purchaseOrder.id,
        shipmentId: parcel.id,
        trackingNumber: shipment.trackingNumber,
        status: scan.status,
        occurredAt: new Date(scan.occurredAt),
        ...(scan.description
          ? { description: redactSupplierOrderMessage(scan.description) }
          : {}),
        ...(scan.locationCountry ? { locationCountry: scan.locationCountry } : {}),
        ...(scan.locationRegion ? { locationRegion: scan.locationRegion } : {}),
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
      });
    }
  }
}

/**
 * The normalized state currently applied to a purchase order.
 *
 * Derived from the stored provider state through the SAME question the mapping
 * answers, and `null` when nothing has been applied yet. It is deliberately not
 * a stored `normalized_state` column beside `provider_state`: two
 * representations of one fact can disagree, and here the disagreement would be
 * between what the provider said and what we decided it meant.
 */
function appliedStateOf(purchaseOrder: PurchaseOrderRecord): SupplierOrderNormalizedState | null {
  if (purchaseOrder.providerStateObservedAt === null) return null;
  switch (purchaseOrder.status) {
    case 'draft':
      return null;
    case 'submitted':
      return 'received';
    case 'accepted':
    case 'cancel_requested':
      return 'accepted';
    case 'shipped':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    case 'rejected':
      return 'rejected';
    case 'expired':
    case 'cancelled':
      return 'cancelled';
  }
}
