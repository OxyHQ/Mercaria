/**
 * May a supplier order be placed for this customer order, right now? (#123,
 * closing #124's `payment-authorization.port.ts` seam.)
 *
 * #124 published the port and a default that refuses every order under
 * `authorization_reader_not_registered`, so a deployment without retail
 * checkout places no supplier orders and says why. This file is the real
 * reader, and it lives in the PAYMENT domain rather than the procurement one
 * for the reason the port's own docblock gives: the question is entirely about
 * payment state, and answering it from `services/supplier-orders/` would mean
 * that domain reading `payments` — which the isolation gate forbids, and which
 * would make a supplier acceptance and a captured charge look like facts of one
 * kind (ADR 0004 D1 says they are not).
 *
 * ## The four conjuncts, and why each is refused separately
 *
 * ADR 0004 D4 selects immediate capture, so "authorized" here means the money
 * is already Mercaria's — not that an authorization is being held. The
 * conjunction is:
 *
 *  1. the order exists (`order_not_found`);
 *  2. it is `mercaria_retail` (`order_not_retail`) — a marketplace order is
 *     also `paid`, and procuring against one would buy goods for an order a
 *     connected merchant is already fulfilling. This is the conjunct the port
 *     exists for;
 *  3. it is `paid` and not cancelled (`order_not_paid` / `order_cancelled`);
 *  4. its payment actually succeeded at the rail (`payment_not_captured`), and
 *     the order carries no moderation hold (`order_on_moderation_hold`).
 *
 * They are separate reasons rather than one because an operator's next action
 * differs for each: a `payment_not_captured` waits, an `order_cancelled` never
 * proceeds, and an `order_on_moderation_hold` needs a jury decision. Collapsing
 * them into "not authorized" would put all three in one queue.
 *
 * ## Why the ORDER's status is not enough on its own
 *
 * `orders.status = 'paid'` is written by the outbox handler in a SEPARATE
 * transaction from the payment's own success (`order-linkage.ts` states that
 * window explicitly). Reading only the order would authorize procurement inside
 * that window for a payment that had not actually succeeded — narrow, but the
 * failure is buying goods with money that never arrived. So the payment
 * aggregate is read too, and both must agree.
 *
 * The reverse pairing is what makes the check safe rather than merely strict: a
 * payment that succeeded while the order sits at `pending_payment` answers
 * `order_not_paid`, and the outbox retries — which is exactly the reconciliation
 * path #45 invariant 7 promises, rather than a race this file has to resolve.
 */

import type { ProcurementSubmissionAuthorization } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findOrderById } from '../../db/orders/orderRepository.js';
import { findNativePaymentByCheckoutGroupId } from '../../db/payments/paymentRepository.js';
import { registerProcurementPaymentAuthorizationReader } from '../supplier-orders/payment-authorization.port.js';

/**
 * Payment statuses under which the money is captured and will not be handed
 * back on its own.
 *
 * `refunded` and `partially_refunded` are deliberately EXCLUDED. Both describe
 * money already flowing back to the buyer, and a purchase order submitted
 * against one would buy goods for a sale being unwound — the failure ADR 0004
 * concern 9 handles at the OTHER end (a late acceptance after a refund), which
 * is much more expensive than refusing here.
 */
const CAPTURED_PAYMENT_STATUSES: readonly string[] = ['succeeded'];

/**
 * Answer #124's question from this order's payment state.
 *
 * Exported so the realdb suite can drive it directly against a real order
 * matrix rather than through the module-level registration, which would make
 * every case depend on import order.
 */
export async function readRetailProcurementAuthorization(
  orderId: string,
): Promise<ProcurementSubmissionAuthorization> {
  const order = await findOrderById(orderId);
  if (!order) return { authorized: false, reason: 'order_not_found' };

  // Conjunct 2 FIRST, before any payment read. A marketplace order is not a
  // near miss here — it is a different commercial model entirely, and its
  // payment state is none of this reader's business.
  if (order.commercialRole !== 'mercaria_retail') {
    return { authorized: false, reason: 'order_not_retail' };
  }
  if (order.status === 'cancelled' || order.status === 'refunded') {
    return { authorized: false, reason: 'order_cancelled' };
  }
  if (order.moderationHold === true) {
    return { authorized: false, reason: 'order_on_moderation_hold' };
  }
  // `paid` and everything after it: an order that has already reached
  // `processing` or `shipped` is still authorized, because a re-submission on
  // that path is the convergence #124 performs after an ambiguous outcome and
  // refusing it would strand exactly the case the port exists to serve.
  if (order.status === 'pending_payment') {
    return { authorized: false, reason: 'order_not_paid' };
  }
  if (order.checkoutGroupId === null) {
    // A retail order always has one — checkout mints it before any order row.
    // Its absence means the order was written by something that is not this
    // checkout, and there is no payment to verify it against.
    return { authorized: false, reason: 'payment_not_captured' };
  }

  const payment = await findNativePaymentByCheckoutGroupId(getDb(), order.checkoutGroupId);
  if (!payment || !CAPTURED_PAYMENT_STATUSES.includes(payment.status)) {
    return { authorized: false, reason: 'payment_not_captured' };
  }

  return {
    authorized: true,
    orderId: order.id,
    paymentId: payment.id,
    // The captured instant, from the ORDER rather than the payment row: it is
    // what the buyer's receipt states, and a purchase order's own trail should
    // cite the same moment the customer record does. Falling back to the
    // payment's own update is not correct here, so an order that reached `paid`
    // without a stamp answers with its creation time rather than inventing one.
    capturedAt: (order.paymentPaidAt ?? order.createdAt).toISOString(),
  };
}

/**
 * Install the reader. Called once at boot from `index.ts`, beside the other
 * port registrations, and never conditionally on a feature flag.
 *
 * The flag question is worth stating because getting it wrong is a silent
 * stranding: `MERCARIA_RETAIL_ENABLED` gates ENTRY (ADR 0004 D4 concern 13, D13)
 * — offer visibility and new retail checkouts — and never the machinery that
 * finishes orders already placed. Registering this reader behind the flag would
 * mean a rollback stopped authorizing procurement for orders whose buyers had
 * already been charged, which is the opposite of "in-flight POs finish or
 * cancel".
 */
export function registerRetailProcurementAuthorizationReader(): void {
  registerProcurementPaymentAuthorizationReader(readRetailProcurementAuthorization);
}
