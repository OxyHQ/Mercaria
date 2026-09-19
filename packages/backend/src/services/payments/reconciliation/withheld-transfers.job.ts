/**
 * Releasing the high-value transfers this deployment held for review.
 *
 * The other half of `services/payments/high-value-hold.ts`. That file decides a
 * seller's share is large enough to wait; this one is the only thing that ends
 * the wait. They ship together and must stay together: a hold with no releaser
 * is a payout that never arrives, which is worse than the fraud it guards
 * against because it is silent and it is Mercaria's own doing.
 *
 * ## It re-enters SETTLEMENT rather than transferring by itself
 *
 * `settlePaymentTransfers` is called, not `provider.createTransfer`. The same
 * reason the open-payments sweep goes through `applyPaymentStatus`: a second
 * path that moves money would be a second set of rules about readiness, about
 * the ledger posting, about the `UNIQUE(payment_id, order_id)` claim — and it
 * would drift from the first at the first change to either. Settlement is
 * idempotent by construction (`createOrGetTransfer` plus the provider-object
 * compare-and-swap), so re-entering it for a whole checkout group re-settles
 * only what is unsettled.
 *
 * On re-entry the hold is recomputed from the transfer row's own `created_at`,
 * so it no longer fires — the window that was open when the buyer paid has
 * closed by definition, or this row would not have been selected.
 *
 * ## The sweep does not read the thresholds, and that is deliberate
 *
 * Its predicate is `held_until <= now()` and nothing else. So turning the hold
 * OFF — clearing `STRIPE_HIGH_VALUE_HOLD_THRESHOLDS`, shortening the window —
 * releases everything already held on schedule instead of stranding it. A sweep
 * gated on the current configuration would make disabling the feature the one
 * action that guarantees the outstanding money never moves.
 *
 * ## Why it records no discrepancy
 *
 * A release that does not free the transfer means settlement withheld it again,
 * and settlement has already written the `transfer_withheld` exception for that
 * (payment, order). Adding a `payment_discrepancies` row would be a second case
 * for one fact. The runner's `discrepancies` count stays 0 because that number
 * is a count of ROWS WRITTEN, and reporting a finding with no row behind it
 * would make the log claim a queue entry that an operator cannot open.
 */

import { getDb } from '../../../db/postgres.js';
import {
  clearTransferHold,
  findReleasableTransfers,
  type TransferRow,
} from '../../../db/payments/paymentRepository.js';
import { settlePaymentTransfers } from '../settlement.service.js';
import { log } from '../../../lib/logger.js';

/** What one page of this job did. */
export interface WithheldTransfersPageResult {
  /** Held transfers whose wait was over. Zero means the pass is complete. */
  scanned: number;
  /**
   * Of those, the ones that still had not left after settlement re-ran.
   *
   * Proved by the hold-clearing compare-and-swap matching: a transfer that was
   * paid carries a provider object and cannot match it.
   */
  stillWithheld: number;
  /** The id to resume from, or `null` when the pass is complete. */
  nextCursor: string | null;
}

/** Release one bounded page of held transfers. */
export async function releaseWithheldTransfersPage(input: {
  cursor: string | null;
  limit: number;
  now?: Date;
}): Promise<WithheldTransfersPageResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  const held = await findReleasableTransfers(db, {
    now,
    ...(input.cursor ? { afterId: input.cursor } : {}),
    limit: input.limit,
  });

  const result: WithheldTransfersPageResult = {
    scanned: held.length,
    stillWithheld: 0,
    nextCursor: null,
  };
  if (held.length === 0) return result;

  // Grouped, because settlement's unit is the CHECKOUT GROUP: two sellers in one
  // basket can both be held, and calling it once per transfer would re-walk the
  // whole group for each of them to no effect.
  const byPayment = new Map<string, TransferRow[]>();
  for (const transfer of held) {
    const siblings = byPayment.get(transfer.paymentId);
    if (siblings) siblings.push(transfer);
    else byPayment.set(transfer.paymentId, [transfer]);
  }

  for (const [paymentId, transfers] of byPayment) {
    try {
      await settlePaymentTransfers(paymentId);
    } catch (error: unknown) {
      // A rail that is down is exactly the case a retry fixes, so the holds are
      // left in place and this payment is picked up by the next pass. Per
      // payment rather than per page, so one unreachable settlement does not
      // strand the others in the same page.
      log.general.error(
        { err: error, paymentId },
        '[Reconciliation] releasing a held transfer failed; it stays held for the next pass',
      );
      continue;
    }

    for (const transfer of transfers) {
      if (!transfer.heldUntil) continue;
      const stranded = await clearTransferHold(db, {
        transferId: transfer.id,
        heldUntil: transfer.heldUntil,
      });
      if (!stranded) continue;
      result.stillWithheld += 1;
      log.general.warn(
        {
          paymentId,
          transferId: transfer.id,
          orderId: transfer.orderId,
          amount: transfer.amountAmount,
          currency: transfer.amountCurrency,
        },
        '[Reconciliation] a held transfer was released for settlement and still did not leave; ' +
          'its transfer_withheld exception carries the reason',
      );
    }
  }

  // A SHORT page ends the pass. A full one advances to the last id read — uuid
  // v7, so the next page starts exactly where this one stopped.
  result.nextCursor = held.length < input.limit ? null : (held[held.length - 1]?.id ?? null);
  return result;
}
