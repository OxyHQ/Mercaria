/**
 * The ONE place this domain moves money — a thin bridge onto `refund.service`
 * (#110 refund integration).
 *
 * ## It reimplements nothing, and that is the whole design
 *
 * Every rule #110's refund section asks for already exists and is already
 * right: amounts computed from the immutable order and prior refunds (rule 2),
 * fee and transfer behaviour from #88 and #43 (rule 3), verified provider
 * events authoritative for completion (rule 4), restock exactly once in the
 * commerce path (rule 5), the four provider outcomes represented separately
 * (rule 6), and the destination fixed to the original provider path (rule 9)
 * because the adapter has no parameter for another one. So this module chooses
 * the LINES and the KEY, and calls the function a merchant's own dashboard
 * calls.
 *
 * ## The key is derived from the REQUEST, and that is what stops a double refund
 *
 * `refunds.idempotency_key` is uniquely indexed, and `refund.service.process`
 * short-circuits on it before touching inventory. Deriving the key from the
 * request id means an operator retrying a failed completion, a second seller
 * clicking the same button and a redelivered outbox job all converge on ONE
 * refund — acceptance 4, held by a unique index rather than by a service
 * remembering to look.
 *
 * ## Refund destination
 *
 * Rule 9 asks that the destination stay the original provider path unless a
 * separately approved policy permits otherwise. It does, structurally: the
 * adapter's refund call takes a payment and an amount and has no destination
 * parameter at all, so there is nowhere for another one to be named. Rule 10
 * ("never ask a guest to send card or bank credentials through support") is the
 * same fact from the other side — nothing in this domain could use them.
 */

import type { CreateRefundInput, RefundLineInput } from '@mercaria/shared-types';
import type { BuyerRequestCompletionFailure } from '@mercaria/shared-types';
import { findRefundById } from '../../db/orders/refundRepository.js';
import type { OrderRecord } from '../../db/orders/orderRepository.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { process as processRefund } from '../refund.service.js';

/** What a bridged refund did. A discriminated union — no partial success. */
export type RefundBridgeOutcome =
  | {
      readonly outcome: 'refunded';
      readonly refundId: string;
      /** `true` once the RAIL has settled; `false` while it is still moving. */
      readonly settled: boolean;
      /** `true` when the rail reported the money did NOT go. */
      readonly failed: boolean;
    }
  | { readonly outcome: 'refused'; readonly failure: BuyerRequestCompletionFailure };

/**
 * The idempotency key one buyer request's refund is made under.
 *
 * Namespaced so it can never collide with a merchant's own key, and derived
 * ONLY from the request id — not from the lines, not from a timestamp and not
 * from the actor, because a retry that differed in any of those would mint a
 * second refund for the same decision.
 */
export function buyerRequestRefundKey(requestId: string): string {
  return `buyer-request:${requestId}`;
}

/**
 * Whether a refund can be made for this order AT ALL.
 *
 * `refund.service.process` is scoped to a STORE, and `/admin/stores/:storeId/
 * orders/:id/refunds` is the only route that reaches it — so a P2P order has no
 * refund path in this repository, for any actor, and never had one. That is a
 * PRE-EXISTING gap #110 names rather than papers over.
 *
 * It is unreachable for a guest today: guest P2P checkout is refused outright
 * (ADR 0003 D18 / ADR 0006 G18, until #112), so every guest order is a store
 * order. It IS reachable for an authenticated Oxy buyer who bought from a
 * person, and such a buyer gets `refund_path_unavailable` with the reason
 * recorded — which is the honest answer, and a louder one than a refund that
 * silently never happens.
 */
export function orderHasRefundPath(order: OrderRecord): boolean {
  return order.storeId !== null;
}

/**
 * Commit a refund for a buyer request and report what the rail did.
 *
 * Never throws for a refusal the caller can record: an over-refund, an unpaid
 * order and an already-closed one all come back as `refused` with a bounded
 * code, because the caller's job is to write that code onto the request and
 * leave it retryable. A genuinely unexpected error still propagates — a failure
 * nobody classified must not be filed as a business outcome.
 */
export async function refundForBuyerRequest(input: {
  order: OrderRecord;
  requestId: string;
  lines: RefundLineInput[];
  reason: string;
  refundShipping: boolean;
  actorOxyUserId: string;
}): Promise<RefundBridgeOutcome> {
  const storeId = input.order.storeId;
  if (storeId === null) return { outcome: 'refused', failure: 'refund_path_unavailable' };
  if (input.lines.length === 0) return { outcome: 'refused', failure: 'refund_refused' };

  const refundInput: CreateRefundInput = {
    type: 'return',
    reason: input.reason,
    lineItems: input.lines,
    refundShipping: input.refundShipping,
    idempotencyKey: buyerRequestRefundKey(input.requestId),
  };

  let refundId: string;
  try {
    const refund = await processRefund(storeId, input.order.id, refundInput, input.actorOxyUserId);
    refundId = refund.id;
  } catch (err: unknown) {
    // `MercariaError` is what the refund service raises for every decision a
    // merchant could have made differently — not paid, already refunded, over
    // the ordered quantity. Anything else is a fault and is rethrown, so a
    // dropped connection is never recorded as "the seller refused".
    if (isMercariaError(err)) {
      log.general.warn(
        { err, orderId: input.order.id, requestId: input.requestId },
        '[BuyerRequests] the refund service refused a buyer-request refund',
      );
      return { outcome: 'refused', failure: 'refund_refused' };
    }
    throw err;
  }

  return { outcome: 'refunded', refundId, ...(await settlementOf(refundId)) };
}

/**
 * Where the money actually got to, read from the refund row.
 *
 * ADR 0001 D7 makes the commerce record and the rail two different facts, and
 * #49 stores both — so this reads the refund's `provider_state` rather than
 * assuming. A refund with NO provider (cash in a register, an order captured on
 * a connected platform) is settled the moment it commits: there is no rail to
 * wait for, and leaving it `refund_pending` forever would be a queue of
 * completed work.
 */
export async function settlementOf(
  refundId: string,
): Promise<{ settled: boolean; failed: boolean }> {
  const refund = await findRefundById(refundId);
  if (!refund) return { settled: false, failed: false };
  if (!refund.provider) return { settled: true, failed: false };
  return {
    settled: refund.providerState === 'succeeded',
    failed: refund.providerState === 'failed' || refund.providerState === 'canceled',
  };
}
