import { describe, expect, it } from 'vitest';
import type { MerchantSubscriptionView } from '@mercaria/shared-types';
import { INVOICE_STATUS_COPY_KEYS, planRenewalLine, renewsByInvoice } from '../plan-renewal';

const PERIOD_END = '2026-12-01T00:00:00.000Z';
const DUE = '2026-12-31T00:00:00.000Z';

function subscription(overrides: Partial<MerchantSubscriptionView> = {}): MerchantSubscriptionView {
  return {
    status: 'active',
    planKey: 'plus',
    planVersion: 1,
    planName: 'Mercaria Plus',
    interval: 'monthly',
    currentPeriodStart: '2026-11-01T00:00:00.000Z',
    currentPeriodEnd: PERIOD_END,
    trialEndsAt: null,
    graceExpiresAt: null,
    cancellationBehavior: null,
    cancelAt: null,
    acceptedTermsVersion: '1',
    collectionMethod: 'charge_automatically',
    nextInvoiceDueAt: null,
    ...overrides,
  };
}

describe('how the plan screen says the next period is paid', () => {
  it('a card plan renews automatically on its period end', () => {
    expect(planRenewalLine(subscription())).toEqual({
      key: 'settings.plan.renewsOn',
      date: PERIOD_END,
    });
    expect(renewsByInvoice(subscription())).toBe(false);
  });

  it('a FairCoin-started plan is an invoice to pay, due on the date the server stated', () => {
    const invoiced = subscription({ collectionMethod: 'send_invoice', nextInvoiceDueAt: DUE });
    expect(planRenewalLine(invoiced)).toEqual({ key: 'settings.plan.invoiceDueOn', date: DUE });
    expect(renewsByInvoice(invoiced)).toBe(true);
  });

  it('without a stated due date it says the invoice comes at the period end, never a guessed date', () => {
    expect(planRenewalLine(subscription({ collectionMethod: 'send_invoice' }))).toEqual({
      key: 'settings.plan.invoiceAtPeriodEnd',
      date: PERIOD_END,
    });
    expect(
      planRenewalLine(subscription({ collectionMethod: 'send_invoice', currentPeriodEnd: null })),
    ).toBeNull();
  });

  it('says nothing renews while the first payment confirms or once the plan is set to end', () => {
    for (const collectionMethod of ['charge_automatically', 'send_invoice'] as const) {
      expect(
        planRenewalLine(
          subscription({ status: 'incomplete', collectionMethod, nextInvoiceDueAt: DUE }),
        ),
      ).toBeNull();
      expect(
        planRenewalLine(
          subscription({ cancelAt: PERIOD_END, collectionMethod, nextInvoiceDueAt: DUE }),
        ),
      ).toBeNull();
    }
    expect(planRenewalLine(null)).toBeNull();
  });

  it('an invoice plan never reads as renewing automatically or as a failed debit', () => {
    expect(INVOICE_STATUS_COPY_KEYS.active?.bodyKey).toBe(
      'settings.plan.statuses.active.invoiceBody',
    );
    expect(INVOICE_STATUS_COPY_KEYS.past_due?.headingKey).toBe(
      'settings.plan.statuses.pastDue.invoiceHeading',
    );
  });
});
