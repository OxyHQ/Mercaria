/**
 * Telling a retail buyer what happened (#127 §"Notifications", twelve items).
 *
 * A thin layer over #108's `enqueueGuestMessage`, and thin on purpose — the
 * queue, the deterministic id, the locale snapshot, the suppression check, the
 * template catalogue and the retry are all already right. What this adds is
 * WHICH kind fires WHEN, plus the dedupe suffix that lets several states of one
 * case share one kind.
 *
 * ## Every function returns `void`, and that is the guarantee
 *
 * #127 does not restate #110's rule that a notification failure must not roll
 * back a completed refund, but the property is the same and it is held the same
 * way: the `emitAnalyticsEvent` device. There is nothing to await, so a caller
 * who tried would get a `tsc` error and a queue write can never join a money
 * transaction.
 *
 * ## Eight kinds for twelve items, and the arithmetic is deliberate
 *
 * Four of #127's twelve already have a kind: "evidence or action required" is
 * `buyer_action_required`, and the three refund states are `refund_pending` /
 * `refund_completed` / `refund_failed`. Retail-specific spellings of those would
 * be four more templates saying the same sentence and four more places a copy
 * fix has to land.
 *
 * **Item 8, "replacement dispatched", has NO kind and that is not an
 * oversight.** A replacement is not a remedy Mercaria can deliver (see
 * `SUPPORTED_RETAIL_CUSTOMER_OUTCOMES`), so a message announcing one is a
 * message that could never be truthfully sent. Adding it would be exactly the
 * stub this domain refuses everywhere else.
 *
 * ## Nothing here is sent to an Oxy buyer, and that is not a branch
 *
 * `enqueueGuestMessage` looks the group's `guest_checkouts` row up and returns
 * `false` when there is none. An authenticated buyer's transactional channel is
 * Oxy's own notifications and this domain deliberately knows nothing about it,
 * so an `oxy`-origin order costs one indexed read and produces no message.
 *
 * ## No message names a supplier, and none can
 *
 * The templates are code and take only the order line and the portal URL. There
 * is no parameter any of them could carry a supplier name, a supplier state or a
 * wholesale figure in — #127 experience rule 8 held by the signature.
 */

import { getDb } from '../../db/postgres.js';
import type { GuestPortalMessageKind } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { enqueueGuestMessage } from '../guest-portal/message.service.js';

/** The order facts a notification needs. Nothing else is available to it. */
export interface NotifiableRetailOrder {
  readonly id: string;
  readonly checkoutGroupId: string | null;
}

/** Queue one message about one order, best-effort. */
function notify(
  order: NotifiableRetailOrder,
  kind: GuestPortalMessageKind,
  dedupeSuffix: string,
): void {
  const checkoutGroupId = order.checkoutGroupId;
  if (checkoutGroupId === null) return;
  void enqueueGuestMessage({ checkoutGroupId, kind, orderId: order.id, dedupeSuffix }, getDb()).catch(
    (err: unknown) => {
      log.guest.error(
        { err, orderId: order.id, kind },
        '[RetailService] failed to enqueue a message; the request stands',
      );
    },
  );
}

/** Item 1 — "we have your request". */
export function notifyRetailRequestReceived(
  order: NotifiableRetailOrder,
  requestId: string,
): void {
  notify(order, 'retail_service_request_received', requestId);
}

/**
 * Item 3 — cancellation pending, accepted or unavailable.
 *
 * ONE kind, told apart by the state in the dedupe suffix — #108's own mechanism,
 * used for the case it was built for. Three kinds would be three sentences
 * pointing at the same portal page, and the fact the buyer actually needs is the
 * refund amount, which the page carries.
 */
export function notifyRetailCancellationUpdated(
  order: NotifiableRetailOrder,
  requestId: string,
  state: string,
): void {
  notify(order, 'retail_cancellation_updated', `${requestId}:${state}`);
}

/** Item 4 — the return is authorised and there is something to do. */
export function notifyRetailReturnAuthorized(
  order: NotifiableRetailOrder,
  requestId: string,
): void {
  notify(order, 'retail_return_authorized', requestId);
}

/** Items 5 and 6 — in transit, received, inspected. */
export function notifyRetailReturnUpdated(
  order: NotifiableRetailOrder,
  requestId: string,
  state: string,
): void {
  notify(order, 'retail_return_updated', `${requestId}:${state}`);
}

/** Item 7 — a warranty case moved. */
export function notifyRetailWarrantyUpdated(
  order: NotifiableRetailOrder,
  requestId: string,
  state: string,
): void {
  notify(order, 'retail_warranty_updated', `${requestId}:${state}`);
}

/**
 * Item 10 — a delay, in customer-appropriate language.
 *
 * The body names no supplier and no reason, because both are procurement facts
 * and because "our supplier has not replied" tells a buyer to go and find one.
 * The suffix carries the DAY rather than the request alone, so a request stuck
 * for a fortnight produces a small number of messages rather than one or one a
 * minute.
 */
export function notifyRetailServiceDelayed(
  order: NotifiableRetailOrder,
  requestId: string,
  day: string,
): void {
  notify(order, 'retail_service_delayed', `${requestId}:${day}`);
}

/**
 * Item 11 — a safety notice.
 *
 * Deliberately NOT deduped on a state, only on the request: a recall notice
 * re-sent is better than one swallowed, and #127 experience rule 7 asks that
 * safety notices stay prominent.
 */
export function notifyRetailSafetyNotice(
  order: NotifiableRetailOrder,
  requestId: string,
): void {
  notify(order, 'retail_safety_notice', requestId);
}

/**
 * Item 12 — the case is closed.
 *
 * Sent on EVERY terminal state, so a rejected request produces a message rather
 * than silence. A buyer who is told no can act on it; one who is told nothing
 * opens a second request.
 */
export function notifyRetailRequestClosed(
  order: NotifiableRetailOrder,
  requestId: string,
  state: string,
): void {
  notify(order, 'retail_service_request_closed', `${requestId}:${state}`);
}

/** Item 2 — something needs the buyer before a deadline. #108's kind, reused. */
export function notifyRetailActionRequired(
  order: NotifiableRetailOrder,
  requestId: string,
): void {
  notify(order, 'buyer_action_required', requestId);
}

/** Item 9 — the money is coming. #110's kind, reused for the same fact. */
export function notifyRetailRefundPending(
  order: NotifiableRetailOrder,
  requestId: string,
): void {
  notify(order, 'refund_pending', requestId);
}

/** Item 9 — the rail settled. */
export function notifyRetailRefundCompleted(
  order: NotifiableRetailOrder,
  requestId: string,
): void {
  notify(order, 'refund_completed', requestId);
}

/** Item 9 — the rail refused, and Mercaria is fixing it. */
export function notifyRetailRefundFailed(
  order: NotifiableRetailOrder,
  requestId: string,
): void {
  notify(order, 'refund_failed', requestId);
}
