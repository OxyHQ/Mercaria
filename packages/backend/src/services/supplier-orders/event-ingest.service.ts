/**
 * Receiving a supplier event — verifying it, resolving it and storing it BEFORE
 * anything interprets it (#124 polling and webhooks 1–4).
 *
 * ## A 200 means stored, never processed
 *
 * The ingress verifies, resolves the purchase order and writes the row. It does
 * NOT apply the event: applying is a separate, leased, retryable act, and
 * collapsing the two would make a slow handler a delivery failure the provider
 * retries — which is how a webhook endpoint gets disabled.
 *
 * ## An unverified callback is never stored
 *
 * `SupplierEventVerification` has no `unverified` member, so there is no row
 * shape for one. The refusal happens here, is counted, and is logged — and
 * nothing downstream can ever encounter a stored event whose authenticity was
 * not established, because such an event does not exist. That is the
 * `STRIPE_ENABLED` mount rule: without a secret there is nothing to verify, so
 * accepting bytes to process later would be storing a stranger's opinion.
 *
 * ## The dedupe key depends on how it arrived
 *
 * A webhook carries the provider's own event id. A POLL does not — it is a
 * snapshot Mercaria asked for — so its identity is its CONTENT. Both converge
 * on one row; see `db/schema/supplierOrders.ts` for why they are two partial
 * unique indexes rather than one constraint.
 */

import type {
  SupplierEventDelivery,
  SupplierEventVerification,
  SupplierOrderNormalizedState,
  SupplierShipment,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import {
  findPurchaseOrderById,
  findPurchaseOrderBySupplierExternalOrderId,
} from '../../db/procurement/purchaseOrderRepository.js';
import {
  recordSupplierProviderEvent,
  type PublicSupplierProviderEvent,
} from '../../db/supplierOrders/providerEventRepository.js';
import { digestPolledObservation } from './client-reference.js';
import { parseSupplierClientReference } from './client-reference.js';
import { projectSupplierEventPayload } from './redact.js';

/** 90 days, the payment provider event's retention and for the same reason. */
const SUPPLIER_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Process-local counters — the metrics surface reads them. */
const counters = { refusedUnverified: 0, storedWebhook: 0, storedPoll: 0, duplicates: 0 };

/** How many deliveries this task has refused as unverifiable. */
export function readSupplierEventIngestCounters(): Readonly<typeof counters> {
  return { ...counters };
}

/** Reset the process-local counters. Exists for tests. */
export function resetSupplierEventIngestCounters(): void {
  counters.refusedUnverified = 0;
  counters.storedWebhook = 0;
  counters.storedPoll = 0;
  counters.duplicates = 0;
}

/** One observation, however it arrived. */
export interface IngestSupplierEventInput {
  supplierAccountId: string;
  provider: string;
  delivery: SupplierEventDelivery;
  verification: SupplierEventVerification;
  /** Required for a webhook, absent for a poll — a CHECK enforces the pairing. */
  providerEventId?: string;
  eventType: string;
  externalOrderId: string | null;
  /** Mercaria's own reference, when the provider echoes it. */
  clientReference: string | null;
  state: SupplierOrderNormalizedState;
  providerState: string;
  stateMappingVersion: number;
  observedAt: Date;
  /** The provider's object, for the ALLOW-LIST projection. Never stored whole. */
  payload: Record<string, unknown>;
  shipments?: readonly SupplierShipment[];
  receivedAt?: Date;
}

/** The stored event, and whether this call stored it. */
export interface IngestSupplierEventResult {
  event: PublicSupplierProviderEvent;
  stored: boolean;
}

/**
 * Store one verified observation.
 *
 * The purchase order is resolved HERE rather than during processing, from two
 * independent handles: Mercaria's own client reference (which the provider
 * echoes, and which cannot be forged into another tenant's order because it is
 * checked against the account's own purchase orders) and the provider's order
 * id scoped to the account. Resolving at ingest is what lets an event about an
 * order Mercaria does not know be STORED with a null purchase order — evidence
 * worth keeping — rather than refused at the door and lost.
 */
export async function ingestSupplierEvent(
  input: IngestSupplierEventInput,
): Promise<IngestSupplierEventResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const purchaseOrderId = await resolvePurchaseOrder(input);

  const contentHash = digestPolledObservation({
    providerAccountId: input.supplierAccountId,
    externalOrderId: input.externalOrderId,
    clientReference: input.clientReference,
    providerState: input.providerState,
    observedAt: input.observedAt.toISOString(),
    trackingNumbers: (input.shipments ?? []).map((shipment) => shipment.trackingNumber),
  });

  const result = await recordSupplierProviderEvent({
    supplierAccountId: input.supplierAccountId,
    provider: input.provider,
    delivery: input.delivery,
    verification: input.verification,
    ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
    contentHash,
    eventType: input.eventType,
    ...(input.externalOrderId ? { providerOrderId: input.externalOrderId } : {}),
    ...(purchaseOrderId ? { purchaseOrderId } : {}),
    normalizedState: input.state,
    providerState: input.providerState,
    stateMappingVersion: input.stateMappingVersion,
    observedAt: input.observedAt,
    receivedAt,
    payloadSummary: projectSupplierEventPayload(input.payload),
    expiresAt: new Date(receivedAt.getTime() + SUPPLIER_EVENT_RETENTION_SECONDS * 1_000),
  });

  if (result.stored) {
    if (input.delivery === 'webhook') counters.storedWebhook += 1;
    else counters.storedPoll += 1;
  } else {
    counters.duplicates += 1;
  }
  return result;
}

/**
 * Count and log a delivery whose authenticity could not be established.
 *
 * Deliberately NOT a stored row (see the module docblock). The counter is what
 * makes a spray of forged callbacks visible to an operator, and the log line
 * carries the account and the reason and no part of the body — a rejected body
 * is a stranger's bytes and quoting it into a log is how a log becomes an
 * injection surface.
 */
export function refuseUnverifiedSupplierCallback(input: {
  provider: string;
  supplierAccountId: string | null;
  reason: string;
}): void {
  counters.refusedUnverified += 1;
  log.general.warn(
    { provider: input.provider, supplierAccountId: input.supplierAccountId, reason: input.reason },
    '[Procurement] refused an unverified supplier callback',
  );
}

/**
 * Which purchase order an event is about.
 *
 * Mercaria's own client reference is tried FIRST and is checked against the
 * account: a provider echoing a reference proves only that somebody sent it
 * one, so an event on account A naming a purchase order placed on account B is
 * not resolved to that order. That is #124 security item 10 — "no supplier API
 * can call Mercaria with arbitrary order ids or destinations" — and it is why
 * the reference is not simply parsed and trusted.
 */
async function resolvePurchaseOrder(input: IngestSupplierEventInput): Promise<string | null> {
  const referenced = input.clientReference
    ? parseSupplierClientReference(input.clientReference)
    : null;
  if (referenced) {
    const purchaseOrder = await findPurchaseOrderById(referenced);
    if (purchaseOrder && purchaseOrder.supplierAccountId === input.supplierAccountId) {
      return purchaseOrder.id;
    }
  }
  if (input.externalOrderId) {
    const byExternal = await findPurchaseOrderBySupplierExternalOrderId({
      supplierAccountId: input.supplierAccountId,
      supplierExternalOrderId: input.externalOrderId,
    });
    if (byExternal) return byExternal.id;
  }
  return null;
}
