/**
 * The ONE place this domain moves money (#127 §"Refunds", ADR 0001 D7).
 *
 * ## It reimplements nothing
 *
 * Every rule #127's refund section asks for already exists in #49 and is FED
 * rather than copied:
 *
 * | #127 refund rule | Where it already lives |
 * |---|---|
 * | 1 — use the provider-neutral refund system | the `payment_refunded` outbox row |
 * | 2 — compute from the immutable order and prior refunds | `allocation.ts`, over `orders` and `sumRefundedShopAmount` |
 * | 3 — refund to the original rail | the adapter has no destination parameter |
 * | 4 — item, shipping, tax and discount explicitly | `RetailRefundAllocation`'s four members |
 * | 6 — do not wait for supplier reporting | nothing here reads a recovery |
 * | 8 — pending, failed and reversed represented | `refunds.provider_state`, read by the reconciler |
 *
 * ## Why it does NOT call `refund.service.process`
 *
 * That function is scoped to a STORE (`process(storeId, …)` and every read it
 * makes is `…InStore`), and a `mercaria_retail` order has no store —
 * `orders.store_id` is NULL on a `platform` order by CHECK. So the store-scoped
 * path cannot reach a retail order in any code path, for any actor.
 *
 * #123 already established the alternative for exactly this reason: its
 * compensating refund writes the commerce record with `insertRefund` and
 * enqueues `payment_refunded` in ONE transaction. This is that same shape, and
 * the reason it is the SAME shape rather than a second one is that both are the
 * commerce record committing before the rail is called (D7) — the rule that
 * makes a slow rail unable to refuse a refund Mercaria authorised.
 *
 * ## RESTOCK IS ALWAYS FALSE, and that is structural
 *
 * #127 refund rule 7 is *"restock only when Mercaria owns inventory; supplier
 * return state does not mutate native inventory"*. A retail line reserved no
 * local inventory (ADR 0004 D5), so there is nothing to put back — and this
 * module imports no inventory function at all, which
 * `retail-service-isolation.test.ts` asserts. `restockedAt` is left absent
 * rather than stamped: stamping it would tell a merchant surface that units
 * returned to a shelf that never held them.
 *
 * ## The dispute suspension is checked HERE and nowhere else
 *
 * #127 refund rule 10 — *"a chargeback cannot also produce an unnoticed
 * duplicate refund"* — needs exactly one chokepoint, because a check in the
 * decision path would be bypassed by the reconciler and vice versa. Every
 * refund this domain commits passes through {@link commitRetailServiceRefund},
 * so the suspension is a property of the call graph.
 */

import type { CurrencyCode, RetailRefundAllocation } from '@mercaria/shared-types';
import { retailRefundAllocationTotal } from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import { insertRefund, type NewRefundLineItem } from '../../db/orders/refundRepository.js';
import type { OrderRecord } from '../../db/orders/orderRepository.js';
import { findRetailRefundSuspension } from '../../db/retailServiceRequests/policyRepository.js';
import { getDb } from '../../db/postgres.js';
import { conflict } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import {
  enqueuePaymentEvent,
  paymentRefundedEventId,
} from '../payments/payment-outbox.service.js';

/**
 * The idempotency key every retail refund carries.
 *
 * Derived from the REQUEST, so an operator retry, a redelivered job and a second
 * press of the same button converge on ONE refund. `refunds.idempotency_key` is
 * uniquely indexed and `insertRefund` fails on it, which is what makes "cannot
 * double-refund" true rather than merely likely.
 */
export function retailRefundIdempotencyKey(requestId: string): string {
  return `retail-service-request:${requestId}`;
}

/** Why a refund was not committed. A bounded reason the request records. */
export type RetailRefundRefusal =
  | { readonly outcome: 'suspended'; readonly disputeId: string }
  | { readonly outcome: 'nothing_owed' }
  | { readonly outcome: 'order_not_refundable' };

/** What a commit produced. A STRING discriminant, for `strict: false`'s sake. */
export type RetailRefundCommit =
  | { readonly outcome: 'committed'; readonly refundId: string }
  | { readonly outcome: 'converged' }
  | RetailRefundRefusal;

/**
 * Commit one retail refund's COMMERCE record and enqueue its execution.
 *
 * The two commit in ONE transaction, because a provider call living in the
 * request that created the refund evaporates on a restart and leaves a record
 * claiming money went back to a buyer who never received it.
 */
export async function commitRetailServiceRefund(input: {
  order: OrderRecord;
  requestId: string;
  allocation: RetailRefundAllocation;
  units: readonly { orderItemId: string; quantity: number }[];
  reason: string;
}): Promise<RetailRefundCommit> {
  const total = retailRefundAllocationTotal(input.allocation);
  if (total.amount <= 0) return { outcome: 'nothing_owed' };
  if (input.order.paymentStatus !== 'paid') {
    // `refund.service` leaves `payment_status` at `paid` while anything is still
    // refundable and moves it to `refunded` only once the grand total is
    // covered — so anything but `paid` here means the charge was fully returned
    // or was reversed by another path (a dispute, a sweep). Refunding again
    // would return money twice, which is the failure rule 10 names.
    return { outcome: 'order_not_refundable' };
  }

  const suspension = await findRetailRefundSuspension(input.order.id);
  if (suspension !== undefined) {
    // #127 chargeback rule 5. The refusal names the DISPUTE so an operator has
    // somewhere to go; releasing it is an explicit, attributable act and never a
    // sweep. The word in rule 10 is *unnoticed* — a deliberate double payment is
    // sometimes right, and an unnoticed one never is.
    return { outcome: 'suspended', disputeId: suspension.disputeId };
  }

  const currency = input.allocation.currency as CurrencyCode;
  const itemById = new Map(input.order.items.map((item) => [item.id, item]));
  const lineItems: NewRefundLineItem[] = [];
  for (const unit of input.units) {
    const item = itemById.get(unit.orderItemId);
    if (item === undefined) continue;
    lineItems.push({
      variantId: item.variantId,
      quantity: unit.quantity,
      amount: {
        // A `platform` order has no connected seller, so its shop currency IS
        // its presentment currency and no conversion is possible or needed.
        shop: { amount: item.lineTotalPresentmentAmount, currency },
        presentment: { amount: item.lineTotalPresentmentAmount, currency },
      },
      // ALWAYS false. See the module docblock — a retail line reserved nothing.
      restock: false,
    });
  }

  const providerOperation =
    input.order.paymentId !== null && input.order.paymentProvider !== null
      ? { provider: input.order.paymentProvider, paymentId: input.order.paymentId }
      : undefined;

  try {
    const refundId = await getDb().transaction(async (tx) => {
      const refund = await insertRefund(
        {
          orderId: input.order.id,
          type: 'refund',
          status: 'refunded',
          reason: input.reason,
          lineItems,
          totalRefunded: {
            shop: { amount: total.amount, currency },
            presentment: { amount: total.amount, currency },
          },
          idempotencyKey: retailRefundIdempotencyKey(input.requestId),
          ...(providerOperation ? { providerOperation } : {}),
        },
        tx,
      );
      if (providerOperation) {
        await enqueuePaymentEvent(tx, {
          id: paymentRefundedEventId(refund.id),
          eventType: 'payment_refunded',
          payload: {
            refundId: refund.id,
            orderId: input.order.id,
            paymentId: providerOperation.paymentId,
          },
        });
      }
      return refund.id;
    });
    log.general.info(
      { orderId: input.order.id, requestId: input.requestId, refundId, amount: total.amount },
      '[RetailService] refund committed; the rail follows from its own outbox row',
    );
    return { outcome: 'committed', refundId };
  } catch (err) {
    if (isUniqueViolation(err, 'refunds_idempotency_key_key')) {
      // The convergence this key exists for. `converged` rather than the prior
      // refund's id, because the caller's only use for a value is a log line and
      // reading a refund back to log it would be a query for nothing.
      return { outcome: 'converged' };
    }
    throw err;
  }
}

/**
 * Refuse a refund while a dispute suspends it, as an HTTP error.
 *
 * Separate from {@link commitRetailServiceRefund}'s union because the OPERATOR
 * surface wants a 409 with the dispute named while the reconciler wants to
 * record a completion failure and move on — same fact, two right responses.
 */
export function assertRetailRefundNotSuspended(commit: RetailRefundCommit): void {
  if (commit.outcome === 'suspended') {
    throw conflict(
      `Refunds on this order are suspended while dispute ${commit.disputeId} is open. ` +
        'Release the suspension explicitly if the refund is owed regardless.',
    );
  }
}
