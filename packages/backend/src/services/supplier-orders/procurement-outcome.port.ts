/**
 * What happens to the CUSTOMER when a purchase order reaches a terminal state
 * — the seam onto #123's compensating refund and #128's cost reconciliation.
 *
 * ## Why a PORT and not a call
 *
 * #124's outbox handler already routes `purchase_order_accepted` and
 * `purchase_order_rejected` as ANNOUNCEMENTS, deliberately terminal, because
 * "each of those owns a decision this domain must not make — whether to tell a
 * buyer, whether to refund, whether to book a draw against a prefunded
 * balance". That reasoning is unchanged; what #123 adds is a REGISTERED
 * consumer for the announcement rather than a direct import.
 *
 * The alternative was `runProcurementOutboxEvent` importing
 * `services/payments/retail-procurement.service.ts`, and it is wrong for the
 * reason ADR 0004 D1 gives: a supplier's acceptance is not payment truth and a
 * captured charge is not procurement truth. An import would make the
 * procurement domain unable to build without the payment domain, and
 * `supplier-orders-isolation.test.ts` fails the build on exactly that edge.
 *
 * ## The default does NOTHING, and that is the right default here
 *
 * Unlike `payment-authorization.port.ts` — whose default REFUSES, because
 * authorizing by omission would place supplier orders nobody paid for — this
 * one is an announcement with no consumer. A deployment without retail checkout
 * has no retail orders, so there is nothing to refund and nothing to reconcile,
 * and a default that threw would dead-letter every purchase order a
 * marketplace-only deployment ever placed.
 *
 * The asymmetry is worth stating plainly: a missing AUTHORIZATION must fail
 * closed, a missing ANNOUNCEMENT must fail quiet, and getting either backwards
 * breaks something.
 */

import type { RetailProcurementFailureKind } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';

/** One terminal purchase-order outcome, as its consumer reads it. */
export type ProcurementOutcomeNotice =
  | {
      kind: 'accepted';
      purchaseOrderId: string;
      orderId: string;
      /** What the supplier accepted at, in the purchase order's own currency. */
      acceptedCostMinor: number;
    }
  | {
      kind: 'failed';
      purchaseOrderId: string;
      orderId: string;
      /** Why, from #123's DEFINITIVE set — never a retryable provider error. */
      failure: RetailProcurementFailureKind;
      detail: string;
    };

/** The one function #123 registers. */
export type ProcurementOutcomeConsumer = (notice: ProcurementOutcomeNotice) => Promise<void>;

/**
 * The default: record it and stop.
 *
 * `debug` rather than `warn`: on a marketplace-only deployment this is the
 * ordinary path, and a warning on every purchase order would train whoever
 * reads the logs to ignore the level that matters.
 */
export const unconsumedProcurementOutcome: ProcurementOutcomeConsumer = async (notice) => {
  log.general.debug(
    { kind: notice.kind, purchaseOrderId: notice.purchaseOrderId },
    '[Procurement] terminal outcome recorded; no consumer is registered',
  );
  await Promise.resolve();
};

let consumer: ProcurementOutcomeConsumer = unconsumedProcurementOutcome;

/**
 * Register the real consumer.
 *
 * Re-registering REPLACES, matching `registerProcurementPaymentAuthorizationReader`
 * and for its reason: startup ordering across lazily imported modules is not
 * something a port should have an opinion about.
 */
export function registerProcurementOutcomeConsumer(next: ProcurementOutcomeConsumer): void {
  consumer = next;
}

/** Restore the silent default. Exists for tests, which must not leak a consumer. */
export function resetProcurementOutcomeConsumer(): void {
  consumer = unconsumedProcurementOutcome;
}

/**
 * Announce one terminal outcome.
 *
 * A THROW from the consumer propagates, so the announcement's outbox row
 * retries: the consumer's work (enqueueing a compensating refund, recording a
 * variance) is durable work with a deterministic id, and swallowing its failure
 * would leave a buyer unrefunded for a supplier rejection that was reported
 * exactly once.
 */
export async function announceProcurementOutcome(notice: ProcurementOutcomeNotice): Promise<void> {
  await consumer(notice);
}
