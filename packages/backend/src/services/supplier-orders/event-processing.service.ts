/**
 * Interpreting stored supplier events — the second half of the receipt /
 * processing split, and its own leased loop.
 *
 * The `payment_provider_events` arrangement: the row IS the job, claims are
 * leases with an owner check, failures back off and a failure that cannot
 * succeed becomes a visible `dead_letter`. What differs is what a stuck event
 * means — a supplier event nobody interpreted is a customer whose tracking page
 * is wrong, so a dead letter here is logged at error level and shows up in the
 * operator queue rather than only in a counter.
 *
 * ## The LOOP is gated, the record never is
 *
 * `PROCUREMENT_EVENT_PROCESSING_ENABLED` stops interpretation while receipt
 * carries on, which is #124 polling-and-webhooks item 10's "keep provider fetch
 * and public-order projection independently pausable": with it off, events
 * accumulate durably and nothing customer-visible moves; with
 * `PROCUREMENT_PROVIDER_FETCH_ENABLED` off instead, Mercaria stops ASKING while
 * still processing what it is told. Two genuinely independent levers, neither
 * of which gates a durable row.
 */

import { randomUUID } from 'node:crypto';
import type { SupplierAdapterCapability } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { findSupplierAccountById } from '../../db/procurement/supplierAccountRepository.js';
import {
  claimSupplierProviderEvent,
  completeSupplierProviderEvent,
  failSupplierProviderEvent,
  renewSupplierProviderEvent,
  type PublicSupplierProviderEvent,
} from '../../db/supplierOrders/providerEventRepository.js';
import { applyProviderObservation } from './observation.service.js';
import { resolveOrderAdapter } from './provider-call.js';

/** Longest a retryable failure is backed off for. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;

/** Attempts after which a failing event is dead-lettered. */
const MAX_ATTEMPTS = 20;

/** What one processing pass did. */
export interface SupplierEventProcessingResult {
  processed: number;
  skipped: number;
  failed: number;
  deadLettered: number;
}

/**
 * Process up to `batchSize` stored events.
 *
 * At-least-once: a task can die between applying an event and completing its
 * row. Reprocessing is safe because `applyProviderObservation`'s monotonic
 * guard makes a re-application a no-op — the second pass finds the observation
 * no newer than what is already applied and ignores it. The idempotency is
 * therefore a property of the observation path, not of this loop.
 */
export async function processSupplierProviderEvents(options?: {
  batchSize?: number;
  leaseMs?: number;
  leaseOwner?: string;
  eventId?: string;
  signal?: AbortSignal;
}): Promise<SupplierEventProcessingResult> {
  const db = getDb();
  const leaseOwner = options?.leaseOwner ?? `procurement-events:${String(process.pid)}:${randomUUID()}`;
  const batchSize = options?.eventId
    ? 1
    : Math.max(1, options?.batchSize ?? config.procurement.eventBatchSize);
  const leaseMs = Math.max(1_000, options?.leaseMs ?? config.procurement.eventLeaseMs);
  const result: SupplierEventProcessingResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (let index = 0; index < batchSize; index += 1) {
    if (options?.signal?.aborted) break;
    const event = await claimSupplierProviderEvent(db, {
      leaseOwner,
      leaseMs,
      ...(options?.eventId ? { eventId: options.eventId } : {}),
    });
    if (!event) break;

    const heartbeat = setInterval(() => {
      void renewSupplierProviderEvent(db, event.id, leaseOwner, leaseMs);
    }, Math.max(250, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();

    try {
      const note = await applyStoredEvent(event);
      await completeSupplierProviderEvent(db, {
        eventId: event.id,
        leaseOwner,
        ...(event.purchaseOrderId ? { purchaseOrderId: event.purchaseOrderId } : {}),
        ...(note ? { processingNote: note } : {}),
      });
      if (note) result.skipped += 1;
      else result.processed += 1;
    } catch (error: unknown) {
      result.failed += 1;
      const deadLetter = event.attempts >= MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);
      await failSupplierProviderEvent(db, {
        eventId: event.id,
        leaseOwner,
        error: message,
        deadLetter,
        nextAttemptAt: new Date(
          Date.now() + Math.min(1_000 * 2 ** Math.min(event.attempts, 20), MAX_BACKOFF_MS),
        ),
      });
      if (deadLetter) {
        result.deadLettered += 1;
        log.general.error(
          { eventId: event.id, purchaseOrderId: event.purchaseOrderId, err: error },
          '[Procurement] supplier event dead-lettered',
        );
      } else {
        log.general.warn(
          { eventId: event.id, purchaseOrderId: event.purchaseOrderId, err: error },
          '[Procurement] supplier event failed, will retry',
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  return result;
}

/**
 * Apply one stored event.
 *
 * @returns a processing NOTE when the event was understood and deliberately not
 *   applied, and nothing when it moved something. The distinction matters in a
 *   trace: an event marked `processed` with no note did something, and one with
 *   a note is a seam or a refusal an operator may need to read — the
 *   `payment_provider_events.processing_note` convention.
 */
async function applyStoredEvent(event: PublicSupplierProviderEvent): Promise<string | undefined> {
  if (!event.purchaseOrderId) {
    // An event about an order Mercaria does not know. Kept as evidence: a
    // supplier that starts reporting orders under references we never sent is
    // something an operator needs to see, and deleting it would make that
    // invisible.
    return 'no purchase order resolved for this event';
  }

  const account = await findSupplierAccountById(event.supplierAccountId);
  const adapter = account ? resolveOrderAdapter(account.provider) : undefined;
  // The adapter's DECLARED capabilities bound what this event may claim, even
  // though the event was stored earlier — an adapter reconfigured between
  // receipt and processing must not have its old claims applied under its new
  // declaration.
  const capabilities: readonly SupplierAdapterCapability[] = adapter?.capabilities ?? [];

  const applied = await applyProviderObservation({
    purchaseOrderId: event.purchaseOrderId,
    capabilities,
    providerEventId: event.id,
    observation: {
      externalOrderId: event.providerOrderId,
      state: event.normalizedState,
      providerState: event.providerState ?? '',
      stateMappingVersion: event.stateMappingVersion,
      observedAt: event.observedAt.toISOString(),
      reasonCode: null,
      providerMessage: null,
      total: null,
      lineOutcomes: [],
      duplicateOfExistingOrder: false,
    },
  });

  // `=== false` rather than a truthiness check: this package compiles with
  // `strict: false`, where a boolean discriminant does not narrow by truthiness.
  return applied.applied === false ? `observation not applied: ${applied.reason}` : undefined;
}
