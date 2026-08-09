/**
 * What the payment outbox does with `procurement_requested` and
 * `retail_procurement_failed` — a PORT, because the answer lives in neither
 * domain.
 *
 * ## Why the handlers are not in this directory
 *
 * `role-separation.test.ts` (#118 acceptance 8, consistency rules 4–5) fails
 * the build if anything under `services/payments/` imports the procurement
 * domain, and that gate is correct and stays: "supplier acceptance marks Stripe
 * paid" and "Stripe success marks procurement accepted" must not merely be
 * unwritten — there must be no import through which either could be written.
 *
 * #123 needs ONE edge across that wall, and only one: ADR 0004 D4 step 4 makes
 * a captured payment the trigger for procurement. Satisfying that by importing
 * the procurement domain here would have widened the gate to admit every OTHER
 * edge too, including the reverse one the gate exists to prevent. So the
 * handlers live in `services/retail-checkout/`, which is neither domain and is
 * allowed to know both, and this port is how the outbox reaches them.
 *
 * The direction is worth stating because it is asymmetric and deliberate:
 * `services/retail-checkout/` may read payment state and may call procurement,
 * and NOTHING in either domain may call it back. It is a consumer of both.
 *
 * ## The default THROWS, unlike `procurement-outcome.port.ts`
 *
 * That one is an announcement with no consumer, and a deployment without retail
 * checkout has nothing to announce — so it fails quiet. This one carries WORK:
 * a `procurement_requested` row is a paid buyer's order waiting to be placed
 * with a supplier, and completing it silently would leave that buyer paid and
 * unprocured with the outbox reporting success. An unregistered handler is a
 * deployment fault, and the row retrying until somebody notices is the correct
 * behaviour — the outbox's `dead_letter` makes it visible either way.
 */

import type { PaymentOutboxRow } from '../../db/payments/paymentOutboxRepository.js';

/**
 * What `services/retail-checkout/` registers: the outbox handler, and the
 * TRIGGER a paid group runs.
 *
 * Two functions rather than one, because they are called from opposite ends of
 * the same story and only one of them is a queue handler. The trigger reads a
 * paid group's intents and enqueues; the handler runs one of the rows it
 * enqueued.
 */
export interface RetailOutboxConsumer {
  handle: (event: PaymentOutboxRow) => Promise<void>;
  /** A paid group's orders: enqueue procurement for every retail one. */
  requestFulfilment: (orderIds: readonly string[]) => Promise<number>;
}

/**
 * The default consumer.
 *
 * `handle` THROWS, so an unrunnable row stays pending; `requestFulfilment`
 * answers ZERO, because a deployment with no retail checkout has no retail
 * orders and enqueueing nothing for them is the correct answer rather than a
 * failure. The two halves fail differently for the reason the module docblock
 * gives: one carries work a paid buyer is waiting behind, the other is a
 * question whose honest answer on such a deployment is "none".
 */
export const unregisteredRetailOutboxConsumer: RetailOutboxConsumer = {
  handle: async (event) => {
    await Promise.resolve();
    throw new Error(
      `No retail outbox consumer is registered, so '${event.eventType}' cannot be run. This ` +
        'deployment has no Mercaria-retail checkout; the row stays pending rather than being ' +
        'completed, because a paid buyer is waiting behind it.',
    );
  },
  requestFulfilment: async () => await Promise.resolve(0),
};

let consumer: RetailOutboxConsumer = unregisteredRetailOutboxConsumer;

/** Register the real consumer. Re-registering REPLACES — the house port idiom. */
export function registerRetailOutboxConsumer(next: RetailOutboxConsumer): void {
  consumer = next;
}

/** Restore the refusing default. Exists for tests, which must not leak a consumer. */
export function resetRetailOutboxConsumer(): void {
  consumer = unregisteredRetailOutboxConsumer;
}

/** Run one retail outbox row. */
export async function runRetailOutboxEvent(event: PaymentOutboxRow): Promise<void> {
  await consumer.handle(event);
}

/** A paid group's orders: enqueue procurement for every retail one. */
export async function requestRetailFulfilment(orderIds: readonly string[]): Promise<number> {
  return await consumer.requestFulfilment(orderIds);
}
