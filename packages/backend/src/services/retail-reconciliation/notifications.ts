/**
 * Telling a buyer that Mercaria is giving part of their money back (#128 item
 * 5).
 *
 * A thin layer over #108's `enqueueGuestMessage`, and thin on purpose — the
 * queue, the deterministic id, the locale snapshot, the suppression check and
 * the template catalogue all already exist and are already right. What #128
 * adds is WHICH kind fires WHEN.
 *
 * ## It returns `void`, and that is the guarantee
 *
 * The `recordAnalyticsEvent` device, one domain over: there is nothing to await,
 * so a caller who tried gets a `tsc` error and a caller who did not cannot
 * accidentally join a queue write to a money transaction. A notification failure
 * must never roll back a committed refund — the buyer's money is more important
 * than the email about it.
 *
 * ## "Without requiring Oxy registration" is what the guest path IS
 *
 * #128 item 5 asks that the buyer be notified without needing an account, and
 * #108's portal is exactly that mechanism: the message goes to the encrypted
 * contact the guest checkout recorded, and the link is the credential-free
 * portal entry. `enqueueGuestMessage` looks the group's `guest_checkouts` row up
 * and returns false when there is none, so an Oxy-origin order costs one indexed
 * read and produces no message — their transactional channel is Oxy's own
 * notifications and this domain deliberately knows nothing about it.
 *
 * That difference is a CHANNEL and not a right. The obligation, its amount and
 * its refund are identical for both actor kinds and nothing in
 * `adjustment.service.ts` reads a buyer origin, which is #128 acceptance 9.
 */

import { log } from '../../lib/logger.js';
import { enqueueGuestMessage } from '../guest-portal/message.service.js';

/** The order facts a notification needs. Nothing else is available to it. */
export interface AdjustableOrder {
  readonly id: string;
  readonly checkoutGroupId: string | null;
}

/**
 * "The order cost us less than you were charged, so the difference is yours."
 *
 * Deduped on the ADJUSTMENT id, so a reconciliation re-run converges on one
 * message and a LATER revision that finds a different surplus sends its own —
 * which is right, because it is a different amount going back.
 */
export function notifyRetailCostAdjustment(order: AdjustableOrder, adjustmentId: string): void {
  const checkoutGroupId = order.checkoutGroupId;
  if (checkoutGroupId === null) return;
  void enqueueGuestMessage({
    checkoutGroupId,
    kind: 'cost_adjustment_issued',
    orderId: order.id,
    dedupeSuffix: adjustmentId,
  }).catch((err: unknown) => {
    log.guest.error(
      { err, orderId: order.id, adjustmentId },
      '[RetailReconciliation] failed to enqueue the cost-adjustment message; the refund stands',
    );
  });
}
