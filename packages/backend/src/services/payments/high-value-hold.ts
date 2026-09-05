/**
 * WHEN a seller's transfer waits before it leaves.
 *
 * ## What this buys, stated honestly
 *
 * Mercaria is merchant of record and ADR 0001 D2 puts the losses on it
 * (`controller.losses.payments = 'application'`). On a fraudulent charge the
 * money leaves twice: the goods go to the fraudster and the transfer goes to
 * the seller, and weeks later the chargeback takes the gross back off
 * Mercaria's balance. The seller has been paid and is not the one who loses.
 *
 * A short hold on a HIGH-VALUE transfer does not remove that risk and this
 * module does not claim to. **A card chargeback can arrive 120 days later and
 * no marketplace holds a payout for 120 days** — a seller would not accept it
 * and Mercaria could not compete. What a hold buys is the window in which most
 * card fraud actually surfaces: the real cardholder reads a statement, Radar
 * scores the charge, a delivery fails. Inside that window the transfer has not
 * left and Mercaria loses the goods rather than the goods AND the cash.
 *
 * So this is a REVIEW hold. Calling it a dispute-window hold would be false,
 * and the difference decides how long it may reasonably be.
 *
 * ## The default is NO HOLD, which is the opposite of `three-d-secure.ts`
 *
 * That asymmetry is deliberate rather than an oversight, and it is worth
 * stating because the two modules otherwise read as a pair.
 *
 * A currency with no 3DS threshold authenticates every payment: the cost of the
 * safe default is friction, which is recoverable. A currency with no HOLD
 * threshold settles immediately, because the "safe" default here would freeze
 * every payout on a deployment nobody configured — which is not caution, it is
 * an outage that looks like caution. The protective direction is only a default
 * when the failure it causes is cheaper than the one it prevents.
 *
 * ## Releasing is the other half, and it is not here
 *
 * A held transfer stays `pending` with a `transfer_withheld` exception. Nothing
 * in the outbox re-drives a settlement — `handleTransferWithheld` records, and
 * `handleProviderAccountChanged` only logs — so before this module the only way
 * out was an operator running `retry_withheld_transfer`. The reconciliation
 * runner's `withheld_transfers` sweep is what releases a hold whose window has
 * passed. A hold with no releaser is a payout that never arrives.
 */

import type { CurrencyCode, Money } from '@mercaria/shared-types';

/** Settle now, or wait until a stated instant. A union, so neither is optional. */
export type HighValueHoldDecision =
  | { readonly outcome: 'settle' }
  | { readonly outcome: 'hold'; readonly releasableAt: Date };

const SETTLE: HighValueHoldDecision = Object.freeze({ outcome: 'settle' });

/**
 * Decide whether this seller's share waits.
 *
 * Pure, and takes its configuration rather than reading `config`, so both
 * branches are reachable from a test whatever this deployment is configured
 * with.
 *
 * `settleableSince` is the TRANSFER row's creation, not the payment's: it is
 * the instant the money became settleable, and it is per seller order.
 * Anchoring on the payment's `updatedAt` would restart the window on every
 * unrelated write, which is a hold that never expires.
 *
 * This function is consulted ONCE per transfer, by the caller whose
 * `createOrGetTransfer` insert won; `transfers.held_until` is the durable answer
 * from then on. So a threshold or a window changed later never moves a hold
 * already in force, and — the reason that matters — a review's decision to
 * release one cannot be silently re-imposed by the settlement it re-enters.
 */
export function highValueHoldFor(input: {
  readonly amount: Money;
  readonly settleableSince: Date;
  readonly now: Date;
  readonly thresholds: Readonly<Partial<Record<CurrencyCode, number>>>;
  readonly windowMs: number;
}): HighValueHoldDecision {
  const threshold = input.thresholds[input.amount.currency];
  if (threshold === undefined) return SETTLE;
  if (input.amount.amount < threshold) return SETTLE;
  if (input.windowMs <= 0) return SETTLE;

  const releasableAt = new Date(input.settleableSince.getTime() + input.windowMs);
  // `>=` so a transfer whose window has expired to the millisecond settles
  // rather than being held for one more sweep. The boundary matters at all only
  // because the sweep is periodic: an off-by-one here is a payout delayed by an
  // interval, not by a millisecond.
  return input.now.getTime() >= releasableAt.getTime()
    ? SETTLE
    : { outcome: 'hold', releasableAt };
}

/**
 * Parse `STRIPE_HIGH_VALUE_HOLD_THRESHOLDS` — `EUR:100000,USD:100000`, MINOR
 * units.
 *
 * Same grammar as `STRIPE_3DS_THRESHOLDS` and deliberately a SEPARATE setting:
 * the two answer different questions (authenticate the buyer / delay the
 * seller), they have different right answers, and one variable serving both
 * would make raising the authentication bar silently freeze payouts.
 *
 * A rejected entry leaves its currency with NO hold, which settles. That is the
 * same direction as the missing-entry default and for the same reason — see the
 * module docblock.
 */
export function parseHighValueHoldThresholds(
  raw: string,
  isKnownCurrency: (code: string) => code is CurrencyCode,
): { thresholds: Record<string, number>; rejected: string[] } {
  const thresholds: Record<string, number> = {};
  const rejected: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    const code = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim().toUpperCase();
    const value = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    if (!isKnownCurrency(code) || !/^\d+$/u.test(value)) {
      rejected.push(trimmed);
      continue;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      rejected.push(trimmed);
      continue;
    }
    thresholds[code] = parsed;
  }
  return { thresholds, rejected };
}
