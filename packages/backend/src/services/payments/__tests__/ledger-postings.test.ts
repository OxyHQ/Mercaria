/**
 * ADR 0001's "Ledger representability" table, checked row by row.
 *
 * The builders are pure, so this is a table test — worked examples in, exact
 * entries out. Two things are asserted for every one of them:
 *
 *  1. the set BALANCES per currency, using `findUnbalancedCurrencies`, which is
 *     the same function the repository refuses on. Restating the rule here would
 *     let the two drift, and a posting that balances only against the test's own
 *     arithmetic is worth nothing;
 *  2. the exact legs — account, sign and amount — because "it balances" is
 *     satisfied by infinitely many wrong answers, including one that credits the
 *     seller what it should credit Mercaria.
 */

import { describe, it, expect } from 'vitest';
import { findUnbalancedCurrencies } from '../../../db/payments/ledgerRepository.js';
import {
  adjustment,
  chargeSucceeded,
  disputeCreated,
  disputeLost,
  disputeWon,
  refundPosting,
  toLedgerAmount,
  transferCreated,
  transferReversal,
} from '../ledger-postings.js';

/** `{account: signed amount}` — the shape assertions read most clearly in. */
function legs(
  entries: readonly { account: string; amountMinor: bigint; ownerId?: string }[],
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const entry of entries) {
    const key = entry.ownerId ? `${entry.account}:${entry.ownerId}` : entry.account;
    out[key] = (out[key] ?? 0n) + entry.amountMinor;
  }
  return out;
}

describe('chargeSucceeded', () => {
  it('books clearing and fee against per-order payable and the residual commission', () => {
    // Gross 10_000, fee 300, two sellers netting 4_000 and 5_000. The
    // commission is the charge minus what the sellers are owed —
    // 10_000 − 9_000 = 1_000 — and the fee is EXPENSED beside it rather than
    // netted out of it, so Mercaria's real margin reads as 1_000 − 300.
    const posting = chargeSucceeded({
      paymentId: 'pay-1',
      currency: 'EUR',
      grossMinor: 10_000n,
      feeMinor: 300n,
      shares: [
        { orderId: 'order-a', ownerType: 'store', ownerId: 'store-1', netMinor: 4_000n },
        { orderId: 'order-b', ownerType: 'user', ownerId: 'seller-2', netMinor: 5_000n },
      ],
    });

    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
    expect(legs(posting.entries)).toEqual({
      provider_clearing: 9_700n,
      processor_expense: 300n,
      'merchant_payable:store-1': -4_000n,
      'merchant_payable:seller-2': -5_000n,
      commission_revenue: -1_000n,
    });
    expect(posting.transaction.kind).toBe('charge_succeeded');
    expect(posting.transaction.paymentId).toBe('pay-1');
  });

  it('names the seller AND the order on every payable leg', () => {
    // The payable account is the only per-owner one, and "what do we owe this
    // seller for this order" is the question it exists to answer — a leg missing
    // either half cannot answer it.
    const posting = chargeSucceeded({
      paymentId: 'pay-2',
      currency: 'EUR',
      grossMinor: 1_000n,
      feeMinor: 0n,
      shares: [{ orderId: 'order-a', ownerType: 'store', ownerId: 'store-1', netMinor: 1_000n }],
    });
    const payable = posting.entries.find((entry) => entry.account === 'merchant_payable');
    expect(payable).toMatchObject({ ownerType: 'store', ownerId: 'store-1', orderId: 'order-a' });
  });

  it('OMITS the fee leg when there is no fee, rather than booking a zero', () => {
    // `ledger_entries` refuses a zero amount, so a fee-free rail is an ordinary
    // case rather than an exception the repository has to tolerate.
    const posting = chargeSucceeded({
      paymentId: 'pay-3',
      currency: 'EUR',
      grossMinor: 2_000n,
      feeMinor: 0n,
      shares: [{ orderId: 'order-a', ownerType: 'user', ownerId: 'seller-1', netMinor: 2_000n }],
    });
    expect(posting.entries.some((entry) => entry.account === 'processor_expense')).toBe(false);
    expect(posting.entries.some((entry) => entry.amountMinor === 0n)).toBe(false);
    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
  });

  it('OMITS the commission leg when the residual is zero', () => {
    // The whole gross going to sellers with no fee is exactly what a `mock`
    // charge looks like today, so this is the shape the dev seam produces.
    const posting = chargeSucceeded({
      paymentId: 'pay-4',
      currency: 'FAIR',
      grossMinor: 300_000_000n,
      feeMinor: 0n,
      shares: [
        { orderId: 'order-a', ownerType: 'store', ownerId: 'store-1', netMinor: 300_000_000n },
      ],
    });
    expect(posting.entries.some((entry) => entry.account === 'commission_revenue')).toBe(false);
    expect(legs(posting.entries)).toEqual({
      provider_clearing: 300_000_000n,
      'merchant_payable:store-1': -300_000_000n,
    });
  });
});

describe('transferCreated', () => {
  it('moves the payable to clearing — the receivable is settled', () => {
    const posting = transferCreated({
      paymentId: 'pay-1',
      transferId: 'tr-1',
      orderId: 'order-a',
      ownerType: 'store',
      ownerId: 'store-1',
      currency: 'EUR',
      amountMinor: 4_000n,
    });
    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
    expect(legs(posting.entries)).toEqual({
      'merchant_payable:store-1': 4_000n,
      provider_clearing: -4_000n,
    });
  });
});

describe('refundPosting', () => {
  it('splits the refund between the seller and Mercaria', () => {
    // R = 1_000 returned to the buyer, of which c = 100 was Mercaria's
    // commission on it. The seller bears 900, Mercaria returns 100.
    const posting = refundPosting({
      paymentId: 'pay-1',
      refundId: 'refund-1',
      orderId: 'order-a',
      ownerType: 'store',
      ownerId: 'store-1',
      currency: 'EUR',
      amountMinor: 1_000n,
      commissionShareMinor: 100n,
    });
    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
    expect(legs(posting.entries)).toEqual({
      'merchant_payable:store-1': 900n,
      commission_revenue: 100n,
      provider_clearing: -1_000n,
    });
    expect(posting.transaction.refundId).toBe('refund-1');
  });

  it('books the whole refund against the seller when no commission is returned', () => {
    const posting = refundPosting({
      paymentId: 'pay-1',
      refundId: 'refund-2',
      orderId: 'order-a',
      ownerType: 'user',
      ownerId: 'seller-1',
      currency: 'EUR',
      amountMinor: 500n,
      commissionShareMinor: 0n,
    });
    expect(posting.entries.some((entry) => entry.account === 'commission_revenue')).toBe(false);
    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
  });
});

describe('transferReversal', () => {
  it('recovers the seller-side amount back onto the platform balance', () => {
    const posting = transferReversal({
      paymentId: 'pay-1',
      transferId: 'tr-1',
      orderId: 'order-a',
      ownerType: 'store',
      ownerId: 'store-1',
      currency: 'EUR',
      amountMinor: 900n,
      refundId: 'refund-1',
    });
    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
    expect(legs(posting.entries)).toEqual({
      provider_clearing: 900n,
      'merchant_payable:store-1': -900n,
    });
    // Separate from the refund, so the ledger can show a refund that happened
    // and a recovery that did not — the operator exception ADR D7 describes.
    expect(posting.transaction.kind).toBe('transfer_reversal');
  });
});

describe('disputes', () => {
  it('holds the principal in `disputes` and expenses the fee when one opens', () => {
    const posting = disputeCreated({
      paymentId: 'pay-1',
      disputeRef: 'dp_1',
      orderId: 'order-a',
      currency: 'EUR',
      amountMinor: 2_500n,
      feeMinor: 1_500n,
    });
    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
    expect(legs(posting.entries)).toEqual({
      disputes: 2_500n,
      processor_expense: 1_500n,
      provider_clearing: -4_000n,
    });
  });

  it('returns the principal and NOT the fee when a dispute is won', () => {
    const opened = disputeCreated({
      paymentId: 'pay-1',
      disputeRef: 'dp_1',
      orderId: 'order-a',
      currency: 'EUR',
      amountMinor: 2_500n,
      feeMinor: 1_500n,
    });
    const won = disputeWon({
      paymentId: 'pay-1',
      disputeRef: 'dp_1',
      orderId: 'order-a',
      currency: 'EUR',
      amountMinor: 2_500n,
    });
    expect(findUnbalancedCurrencies(won.entries)).toEqual([]);

    // Together the two close `disputes` to zero and leave the fee expensed —
    // a lost fee on a won dispute is a real cost Mercaria bore (ADR D5), and
    // reversing it would overstate revenue by the amount of every dispute.
    const combined = legs([...opened.entries, ...won.entries]);
    expect(combined.disputes).toBe(0n);
    expect(combined.processor_expense).toBe(1_500n);
  });

  it('charges the seller when a dispute is lost, closing the holding account', () => {
    const lost = disputeLost({
      paymentId: 'pay-1',
      disputeRef: 'dp_1',
      orderId: 'order-a',
      ownerType: 'store',
      ownerId: 'store-1',
      currency: 'EUR',
      amountMinor: 2_500n,
    });
    expect(findUnbalancedCurrencies(lost.entries)).toEqual([]);
    expect(legs(lost.entries)).toEqual({
      'merchant_payable:store-1': 2_500n,
      disputes: -2_500n,
    });
  });
});

describe('adjustment', () => {
  it('passes entries through unchanged, so a correction is ordinary entries', () => {
    const entries = [
      { account: 'reserves' as const, currency: 'EUR' as const, amountMinor: 100n },
      { account: 'provider_clearing' as const, currency: 'EUR' as const, amountMinor: -100n },
    ];
    const posting = adjustment({ description: 'operator correction', entries });
    expect(posting.entries).toBe(entries);
    expect(posting.transaction.kind).toBe('adjustment');
    expect(findUnbalancedCurrencies(posting.entries)).toEqual([]);
  });
});

describe('toLedgerAmount', () => {
  it('converts a Money amount to the bigint the ledger stores', () => {
    expect(toLedgerAmount({ amount: 2_500, currency: 'EUR' })).toBe(2_500n);
    // A FAIR amount is a hundred million minor units per unit — the magnitude
    // the bigint column exists for.
    expect(toLedgerAmount({ amount: 300_000_000, currency: 'FAIR' })).toBe(300_000_000n);
  });
});
