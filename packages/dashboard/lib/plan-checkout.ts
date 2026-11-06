import type {
  BillingInterval,
  MerchantPlanCheckoutView,
  MerchantPlanStatusView,
} from '@mercaria/shared-types';
import type { SheetExpectation, SheetOutcome, SheetSettlement } from '@peable.to/sdk/checkout/ui';

/**
 * What a plan purchase in Peable's sheet is decided by — pure, so it is
 * unit-tested where the sheet cannot be.
 *
 * The sheet reports when Peable closed the order; whether the store now PAYS is
 * Mercaria's plan status, moved only by a verified provider event. Closing the
 * sheet proves nothing, and neither does a session marked complete: a FairCoin
 * first payment completes the session while it is still confirming.
 */

/** The statuses in which the store has the plan it bought. */
const PAYING: ReadonlySet<string> = new Set(['active', 'trialing']);

/** The sheet's outcome: `succeeded` only once Mercaria's own status says the store pays. */
export function planCheckoutOutcome(
  settlement: SheetSettlement | null,
  status: MerchantPlanStatusView | undefined,
): SheetOutcome {
  if (settlement === 'expired') return 'failed';
  if (settlement === 'complete' && status?.subscription && PAYING.has(status.subscription.status))
    return 'succeeded';
  return null;
}

/** What the merchant reviewed: the price Mercaria resolved, so the sheet refuses any other session. */
export function planCheckoutExpectation(view: MerchantPlanCheckoutView): SheetExpectation {
  return {
    amount: String(view.amount.amount),
    currency: view.amount.currency,
    livemode: view.livemode,
  };
}

/** The cadence the sheet shows beside the amount due today. */
export function sheetInterval(interval: BillingInterval): 'month' | 'year' {
  return interval === 'annual' ? 'year' : 'month';
}
