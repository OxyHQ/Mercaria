/**
 * The one posting the subscription domain books (#89), and the property that
 * matters: it balances to zero PER CURRENCY, always.
 *
 * Randomized over mixed currencies and amounts, like the payment domain's own
 * ledger property tests — because the failure this defends against is not a
 * wrong constant, it is an arithmetic path somebody adds later that happens to
 * balance for the numbers in a fixture.
 */

import { describe, expect, it } from 'vitest';
import { ALL_CURRENCY_CODES, type CurrencyCode } from '@mercaria/shared-types';
import { findUnbalancedCurrencies } from '../../../db/payments/ledgerRepository.js';
import { subscriptionInvoicePaidEntries } from '../ledger-postings.js';

/** A deterministic pseudo-random source, so a failure is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('a settled subscription invoice balances', () => {
  it('nets to zero per currency over randomized amounts and currencies', () => {
    const random = makeRandom(89);
    for (let round = 0; round < 500; round += 1) {
      const currency = ALL_CURRENCY_CODES[
        Math.floor(random() * ALL_CURRENCY_CODES.length)
      ] as CurrencyCode;
      const netMinor = Math.floor(random() * 5_000_000) + 1;
      const feeMinor = Math.floor(random() * 100_000);
      const entries = subscriptionInvoicePaidEntries({ netMinor, feeMinor, currency });
      expect(
        findUnbalancedCurrencies(entries),
        `net=${String(netMinor)} fee=${String(feeMinor)} ${currency} does not balance`,
      ).toEqual([]);
      expect(entries.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('credits subscription_revenue and NEVER commission_revenue', () => {
    // Acceptance 6: subscription revenue and marketplace fees report separately.
    // `commission_revenue` is ADR 0001 D3's residual and means something else
    // entirely; a subscription landing in it would make that figure stop meaning
    // what it means, with no way to separate them afterwards.
    const entries = subscriptionInvoicePaidEntries({
      netMinor: 2_650,
      feeMinor: 250,
      currency: 'EUR',
    });
    const accounts = entries.map((entry) => entry.account);
    expect(accounts).toContain('subscription_revenue');
    expect(accounts).not.toContain('commission_revenue');
    expect(accounts).not.toContain('merchant_payable');

    const revenue = entries.find((entry) => entry.account === 'subscription_revenue');
    // Negative is a CREDIT, and the gross is what is recognised.
    expect(revenue?.amountMinor).toBe(-2_900n);
    const clearing = entries.find((entry) => entry.account === 'provider_clearing');
    expect(clearing?.amountMinor).toBe(2_650n);
    const expense = entries.find((entry) => entry.account === 'processor_expense');
    expect(expense?.amountMinor).toBe(250n);
  });

  it('OMITS the expense leg when there is no fee, rather than booking a zero', () => {
    // `ledger_entries_amount_nonzero_check` refuses a zero amount: it conveys
    // nothing, survives every balance check, and accumulates.
    const entries = subscriptionInvoicePaidEntries({
      netMinor: 2_900,
      feeMinor: 0,
      currency: 'EUR',
    });
    expect(entries.map((entry) => entry.account)).toEqual([
      'provider_clearing',
      'subscription_revenue',
    ]);
    expect(findUnbalancedCurrencies(entries)).toEqual([]);
  });

  it('refuses a settlement that moved nothing, and a negative one', () => {
    // A transaction of no entries is not a transaction, and a credit is an
    // operator `adjustment` through the existing mechanism rather than a
    // negative invoice.
    expect(() =>
      subscriptionInvoicePaidEntries({ netMinor: 0, feeMinor: 0, currency: 'EUR' }),
    ).toThrow(RangeError);
    expect(() =>
      subscriptionInvoicePaidEntries({ netMinor: -100, feeMinor: 0, currency: 'EUR' }),
    ).toThrow(RangeError);
    expect(() =>
      subscriptionInvoicePaidEntries({ netMinor: 100.5, feeMinor: 0, currency: 'EUR' }),
    ).toThrow(RangeError);
  });
});
