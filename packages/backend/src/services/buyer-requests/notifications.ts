/**
 * Telling a guest buyer what happened to their request (#110 transactional
 * communication).
 *
 * A thin layer over #108's `enqueueGuestMessage`, and thin on purpose — the
 * queue, the deterministic id, the locale snapshot, the suppression check, the
 * template catalogue and the single-use link minting all already exist and are
 * already right. What #110 adds is WHICH kind fires WHEN, plus the dedupe
 * suffix that lets four states of one return share one kind.
 *
 * ## Every function here returns `void`, and that is the guarantee
 *
 * #110 communication rule 6: "a notification failure does not roll back a
 * completed refund or cancellation". The `emitAnalyticsEvent` device — there is
 * nothing to await, so a caller who tried would get a `tsc` error, and a caller
 * who did not cannot accidentally join a queue write to a money transaction.
 *
 * ## Nothing here is sent to an Oxy buyer, and that is not a branch
 *
 * `enqueueGuestMessage` looks the group's `guest_checkouts` row up and returns
 * `false` when there is none. An authenticated buyer's transactional channel is
 * Oxy's own notifications and this domain deliberately knows nothing about it,
 * so an `oxy`-origin order costs one indexed read and produces no message.
 *
 * ## Every message links to the portal ENTRY, never to a mutation
 *
 * Communication rule 1 asks that messages link "to a current secure portal
 * entry, not directly to an unrestricted mutation", and none of the kinds below
 * is in `GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS` — so their bodies carry the
 * credential-free portal URL and the recipient exchanges or recovers from
 * there. A "cancel now" link in an email would be a mutation reachable from a
 * forwarded message, which is exactly the shape ADR 0003 T4 exists to refuse.
 *
 * ## Marketing is unreachable from here
 *
 * Communication rule 3. There is no subscription call, no list id and no
 * consent read in this module, and `guest_checkouts.marketing_opt_in` is a
 * separate column defaulting to false that nothing below consults.
 */

import type { GuestPortalMessageKind } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { enqueueGuestMessage } from '../guest-portal/message.service.js';

/** The order facts a notification needs. Nothing else is available to it. */
export interface NotifiableOrder {
  readonly id: string;
  readonly checkoutGroupId: string | null;
}

/**
 * Queue one message about one order, best-effort.
 *
 * `dedupeSuffix` is how four states of one return share `return_request_updated`
 * without the second silently colliding on the deterministic id — #108's own
 * mechanism, used for the case it was built for. Passing the REQUEST id and the
 * state means a redelivered decision converges and a genuine later state does
 * not.
 */
function notify(
  order: NotifiableOrder,
  kind: GuestPortalMessageKind,
  dedupeSuffix: string,
): void {
  const checkoutGroupId = order.checkoutGroupId;
  if (checkoutGroupId === null) return;
  void enqueueGuestMessage({ checkoutGroupId, kind, orderId: order.id, dedupeSuffix }).catch(
    (err: unknown) => {
      log.guest.error(
        { err, orderId: order.id, kind },
        '[BuyerRequests] failed to enqueue a message; the request stands',
      );
    },
  );
}

/** "We have your cancellation request." */
export function notifyCancellationReceived(order: NotifiableOrder, requestId: string): void {
  notify(order, 'cancellation_request_received', requestId);
}

/**
 * "Your cancellation was approved" / "…was not approved".
 *
 * TWO kinds rather than one carrying an outcome, because the subject lines have
 * to differ and a template that branched on a state would be a fifth place the
 * state is spelled. #110 communication item 2 names them together and they are
 * opposite facts.
 */
export function notifyCancellationDecided(
  order: NotifiableOrder,
  requestId: string,
  accepted: boolean,
): void {
  notify(
    order,
    accepted ? 'cancellation_request_approved' : 'cancellation_request_rejected',
    requestId,
  );
}

/** "We have your return request." */
export function notifyReturnReceived(order: NotifiableOrder, requestId: string): void {
  notify(order, 'return_request_received', requestId);
}

/**
 * "There is an update on your return."
 *
 * ONE kind for approved / rejected / awaiting-item / received / cancelled,
 * distinguished by the state in the dedupe suffix. The alternative — five kinds
 * — was rejected because their bodies would be five sentences pointing at the
 * same portal page, and #108's catalogue is already the longest file in that
 * domain.
 */
export function notifyReturnUpdated(
  order: NotifiableOrder,
  requestId: string,
  state: string,
): void {
  notify(order, 'return_request_updated', `${requestId}:${state}`);
}

/**
 * "Your refund is on its way" — the commerce record has committed.
 *
 * #108 deferred this kind with the note that "pending" would mean the RAIL had
 * not paid yet, which a buyer cannot act on. In a RETURN it means something
 * different and actionable: the seller approved, the goods are accounted for,
 * and the money is coming. That is why the trigger lands here rather than in
 * the payment domain.
 */
export function notifyRefundPending(order: NotifiableOrder, requestId: string): void {
  notify(order, 'refund_pending', requestId);
}

/** "Your refund is complete." Fired when the rail settled, not when we asked. */
export function notifyRefundCompleted(order: NotifiableOrder, requestId: string): void {
  notify(order, 'refund_completed', requestId);
}

/**
 * "Your refund could not be completed."
 *
 * Sent on a rail failure, and it is the one message here that tells a buyer
 * about something Mercaria is fixing rather than something they must do —
 * because the alternative is a person watching a refund that never arrives with
 * no way to tell whether anybody knows.
 */
export function notifyRefundFailed(order: NotifiableOrder, requestId: string): void {
  notify(order, 'refund_failed', requestId);
}

/** "There is a reply waiting in your order's support thread." */
export function notifySupportResponse(order: NotifiableOrder, threadId: string, messageId: string): void {
  notify(order, 'support_response_available', `${threadId}:${messageId}`);
}

/**
 * "Something needs you before a deadline" — #110 communication item 10.
 *
 * Fired when a return is approved with a ship-back deadline, which is the only
 * deadline in this domain a buyer can miss. The suffix carries the request so a
 * re-issued set of instructions produces a second message rather than being
 * swallowed by the first.
 */
export function notifyActionRequired(order: NotifiableOrder, requestId: string): void {
  notify(order, 'buyer_action_required', requestId);
}
