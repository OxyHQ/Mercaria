import type { MerchantSubscriptionView } from '@mercaria/shared-types';

/**
 * How the plan screen says the next period is paid — pure, so it is
 * unit-tested where the screen cannot be.
 *
 * A card plan (`charge_automatically`) renews by itself on its period end. A
 * plan whose first invoice was paid in FairCoin is `send_invoice` from then on
 * (Peable ADR 0021 D3, FairCoin is never debited): nothing renews by itself,
 * and each period starts with an invoice the store pays on its page, with
 * FairCoin or a card. Saying "renews automatically" of that plan is false.
 *
 * KEYS rather than sentences (#398), and every line names the date it carries:
 * i18n-js renders a missing placeholder as a literal (#529), so a line whose
 * date is unknown is not shown at all.
 */
export interface PlanRenewalLine {
  readonly key:
    | 'settings.plan.renewsOn'
    | 'settings.plan.invoiceDueOn'
    | 'settings.plan.invoiceAtPeriodEnd';
  /** The ISO instant the line's `%{date}` formats. */
  readonly date: string;
}

/** True when each renewal is an invoice the store pays, not a card debit. */
export function renewsByInvoice(subscription: MerchantSubscriptionView | null): boolean {
  return subscription?.collectionMethod === 'send_invoice';
}

/**
 * The one line under the plan's state about the next period, or `null` when
 * nothing renews: a plan still waiting for its first payment, or one already
 * set to end.
 */
export function planRenewalLine(
  subscription: MerchantSubscriptionView | null,
): PlanRenewalLine | null {
  if (!subscription || subscription.status === 'incomplete' || subscription.cancelAt) return null;
  if (renewsByInvoice(subscription)) {
    if (subscription.nextInvoiceDueAt) {
      return { key: 'settings.plan.invoiceDueOn', date: subscription.nextInvoiceDueAt };
    }
    // The rail stated no days until due: say when the invoice is issued, never
    // a due date nobody stated.
    return subscription.currentPeriodEnd
      ? { key: 'settings.plan.invoiceAtPeriodEnd', date: subscription.currentPeriodEnd }
      : null;
  }
  return subscription.currentPeriodEnd
    ? { key: 'settings.plan.renewsOn', date: subscription.currentPeriodEnd }
    : null;
}

/**
 * The status copy that differs for a plan renewed by invoice: `active` must not
 * say it renews automatically, and `past_due` must not say a payment was
 * "taken" — an unpaid invoice is not a failed debit. Every other status reads
 * the same whichever way the plan is collected.
 */
export const INVOICE_STATUS_COPY_KEYS: Partial<
  Record<MerchantSubscriptionView['status'], { headingKey?: string; bodyKey?: string }>
> = {
  active: { bodyKey: 'settings.plan.statuses.active.invoiceBody' },
  past_due: { headingKey: 'settings.plan.statuses.pastDue.invoiceHeading' },
};
