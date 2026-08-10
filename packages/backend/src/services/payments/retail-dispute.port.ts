/**
 * What happens on Mercaria's side when a card dispute names a RETAIL order — a
 * PORT, because the answer lives in a domain built on top of this one (#127).
 *
 * ## The dependency has to point one way and this is how it keeps doing so
 *
 * `services/retail-service-requests/` reads the payment domain: it reads
 * `refunds.provider_state`, it commits refunds through `insertRefund`, it
 * enqueues `payment_refunded`. Nothing in the payment domain knows it exists,
 * and a direct import from `dispute.service.ts` into it would invert that — the
 * same one-way seam `verified-conversion.ts` states for analytics and #110's
 * reconciler already follows.
 *
 * So the dispute service calls a function it owns the SIGNATURE of, and the
 * retail domain registers the body at boot.
 *
 * ## The default is SILENT, and the asymmetry with `retail-outbox.port.ts` is
 * deliberate
 *
 * That port carries WORK — a `procurement_requested` row is a paid buyer waiting
 * to be procured for — so its default throws. This one is a CONSEQUENCE: a
 * marketplace-only deployment has no retail orders, so a dispute that names one
 * cannot arise, and throwing would dead-letter every ordinary marketplace
 * dispute event for a case that does not exist. The consumer itself already
 * answers "not a retail order" with a no-op, so the two agree.
 *
 * The cost is stated rather than hidden: a deployment that runs retail checkout
 * and forgets to register this coordinates no suspension, and a refund committed
 * during a dispute would be the duplicate #127 rule 10 forbids. `registration.ts`
 * is called unconditionally from `index.ts` beside every other boot
 * registration, so forgetting it means deleting a line rather than omitting one.
 */

import { log } from '../../lib/logger.js';

/** What the retail service domain registers. */
export interface RetailDisputeConsumer {
  /**
   * A dispute was observed against an order. Answers for a NON-retail order by
   * doing nothing, which is why the payment domain may call it unconditionally.
   */
  coordinate: (input: { disputeId: string; orderId: string }) => Promise<void>;
}

/** The default: nothing happens, and nothing needs to. */
const noRetailDisputeConsumer: RetailDisputeConsumer = {
  async coordinate() {
    /* A deployment without retail checkout has no retail order to coordinate. */
  },
};

let consumer: RetailDisputeConsumer = noRetailDisputeConsumer;

/** Register the consumer. Called once at boot. */
export function registerRetailDisputeConsumer(next: RetailDisputeConsumer): void {
  consumer = next;
  log.general.info({}, '[Payments] a retail dispute consumer was registered');
}

/**
 * Tell whoever is listening that a dispute names this order.
 *
 * Returns `void` and swallows nothing: a failure propagates to the dispute
 * handler, which retries the whole event from its own row. That is the right
 * direction — a coordination that did not open is a refund suspension that does
 * not exist, and the loud failure is better than a silent one.
 */
export async function coordinateRetailDisputeIfAny(input: {
  disputeId: string;
  orderId: string;
}): Promise<void> {
  await consumer.coordinate(input);
}

/** Test-only: restore the default. */
export function resetRetailDisputeConsumerForTests(): void {
  consumer = noRetailDisputeConsumer;
}
