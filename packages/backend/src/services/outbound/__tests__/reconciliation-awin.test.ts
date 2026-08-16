/**
 * The Awin Publisher API reader, measured through the REAL reader over a fake
 * socket (#67).
 *
 * Only the transport is faked. The URL building, the status classification, the
 * envelope handling, the money conversion and the state map are the shipped
 * ones — #65's ruling, and the reason it matters here is that every one of
 * those is a place where a wrong answer is a wrong AMOUNT rather than an error.
 */

import { describe, expect, it } from 'vitest';
import {
  AWIN_COMMISSION_STATUS_STATES,
  awinAmountText,
  awinDateParam,
  awinReportWindows,
  awinTransactionsUrl,
  normalizeAwinTransaction,
} from '../reconciliation/awin.js';
import { assertAwinPublisherUrl } from '../reconciliation/awin-transport.js';
import { EBAY_REPORT_READER_UNAVAILABLE } from '../reconciliation/ebay.js';

/** One Awin transaction as its own documentation shapes it. */
function awinTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 259630312,
    advertiserId: 7052,
    publisherId: 189069,
    commissionStatus: 'approved',
    commissionAmount: { amount: 1.2, currency: 'GBP' },
    saleAmount: { amount: 24.0, currency: 'GBP' },
    transactionDate: '2026-03-01T10:00:00.000Z',
    validationDate: '2026-03-05T00:00:00.000Z',
    clickRefs: { clickRef: 'ref-1' },
    paidToPublisher: false,
    ...overrides,
  };
}

describe('reading an Awin money value', () => {
  it('converts major units exactly, without floating point', () => {
    // `Math.round(1.2 * 100)` happens to be right and `Math.round(1.005 * 100)`
    // is 100 — a half-penny lost, invisibly, on every commission that lands on
    // one. The whole reason this goes through #63's string arithmetic.
    const normalized = normalizeAwinTransaction(
      awinTransaction({ commissionAmount: { amount: 1.2, currency: 'GBP' } }),
    );
    expect(normalized.outcome).toBe('transaction');
    if (normalized.outcome !== 'transaction') return;
    expect(normalized.transaction.commission).toEqual({ amount: 120, currency: 'GBP' });
  });

  it('reads a THREE-DECIMAL amount as a decimal, not as a thousands separator', () => {
    // The trap this reader exists around. `parseFeedMoney` reads a single
    // separator followed by exactly three digits as a GROUPING separator,
    // because `1.005` is one thousand and five in every European CSV it was
    // written for — and catastrophically wrong for a JSON number, where it is
    // one and a half pence. A thousandfold error, in the direction that
    // overstates revenue.
    const normalized = normalizeAwinTransaction(
      awinTransaction({ commissionAmount: { amount: 1.005, currency: 'GBP' } }),
    );
    expect(normalized.outcome).toBe('transaction');
    if (normalized.outcome !== 'transaction') return;
    // 1.005 GBP is 100.5 minor units; half-up gives 101, NOT 1005 and NOT 100.
    expect(normalized.transaction.commission.amount).toBe(101);
  });

  it('leaves a two-decimal amount alone', () => {
    // The other half of the same rule: padding unconditionally would turn
    // `19.99` into `19.990` and CREATE the ambiguity the padding closes.
    expect(awinAmountText(19.99)).toBe('19.99');
    expect(awinAmountText(1.005)).toBe('1.0050');
    expect(awinAmountText(1200)).toBe('1200');
  });

  it('refuses an amount it cannot read exactly', () => {
    // `String(1e-7)` is `'1e-7'` and `String(1e21)` is `'1e+21'`; expanding
    // either by hand would be the second money parser this module exists to
    // avoid, so both are refused.
    expect(awinAmountText(1e-7)).toBeNull();
    expect(awinAmountText(1e21)).toBeNull();
    expect(awinAmountText(Number.NaN)).toBeNull();
    expect(awinAmountText('1.20')).toBeNull();
  });

  it('rejects a transaction whose currency Mercaria cannot store', () => {
    const normalized = normalizeAwinTransaction(
      awinTransaction({ commissionAmount: { amount: 1.2, currency: 'XYZ' } }),
    );
    expect(normalized.outcome).toBe('rejected');
    if (normalized.outcome !== 'rejected') return;
    expect(normalized.rejected.networkTransactionId).toBe('259630312');
  });
});

describe('mapping Awin’s own vocabulary', () => {
  it('maps every documented status and NOTHING else', () => {
    expect(Object.keys(AWIN_COMMISSION_STATUS_STATES).sort()).toEqual([
      'approved',
      'declined',
      'deleted',
      'pending',
    ]);
    expect(AWIN_COMMISSION_STATUS_STATES['deleted']).toBe('reversed');
  });

  it('REJECTS an unrecognised status rather than guessing a state', () => {
    // Guessing here books money on a word nobody has checked. The row is named
    // and counted, and the pass carries on: one unreadable row must not cost a
    // window.
    const normalized = normalizeAwinTransaction(
      awinTransaction({ commissionStatus: 'partially_approved' }),
    );
    expect(normalized.outcome).toBe('rejected');
    if (normalized.outcome !== 'rejected') return;
    expect(normalized.rejected.reason).toContain('partially_approved');
  });

  it('promotes an approved-and-paid transaction to `paid`', () => {
    const normalized = normalizeAwinTransaction(awinTransaction({ paidToPublisher: true }));
    expect(normalized.outcome).toBe('transaction');
    if (normalized.outcome !== 'transaction') return;
    expect(normalized.transaction.state).toBe('paid');
  });

  it('does NOT promote a deleted transaction that was already paid', () => {
    // A clawback: Awin paid it and the advertiser then deleted it. Reading it
    // as `paid` would leave the reversal unbooked while the money is going
    // back.
    const normalized = normalizeAwinTransaction(
      awinTransaction({ commissionStatus: 'deleted', paidToPublisher: true }),
    );
    expect(normalized.outcome).toBe('transaction');
    if (normalized.outcome !== 'transaction') return;
    expect(normalized.transaction.state).toBe('reversed');
  });

  it('carries the network’s own references, the click reference included', () => {
    const normalized = normalizeAwinTransaction(awinTransaction());
    expect(normalized.outcome).toBe('transaction');
    if (normalized.outcome !== 'transaction') return;
    expect(normalized.transaction).toMatchObject({
      networkTransactionId: '259630312',
      advertiserRef: '7052',
      publisherRef: '189069',
      networkClickRef: 'ref-1',
      orderValue: { amount: 2400, currency: 'GBP' },
    });
    expect(normalized.transaction.eventAt.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(normalized.transaction.networkProcessedAt?.toISOString()).toBe(
      '2026-03-05T00:00:00.000Z',
    );
  });

  it('rejects a row with no id, no commission or no event time', () => {
    for (const broken of [
      awinTransaction({ id: null }),
      awinTransaction({ commissionAmount: null }),
      awinTransaction({ transactionDate: 'not a date' }),
      'not an object',
    ]) {
      expect(normalizeAwinTransaction(broken).outcome).toBe('rejected');
    }
  });

  it('keeps a transaction whose order value the network withheld', () => {
    // A network can report a conversion whose sale amount it does not
    // disclose, and refusing it would drop real commission.
    const normalized = normalizeAwinTransaction(awinTransaction({ saleAmount: null }));
    expect(normalized.outcome).toBe('transaction');
    if (normalized.outcome !== 'transaction') return;
    expect(normalized.transaction.orderValue).toBeNull();
  });
});

describe('the request Mercaria composes', () => {
  it('renders Awin’s date format from UTC parts', () => {
    expect(awinDateParam(new Date('2026-03-09T00:00:00.000Z'))).toBe('2026-03-09T00:00:00');
    expect(awinDateParam(new Date('2026-03-09T23:59:59.000Z'))).toBe('2026-03-09T23:59:59');
  });

  it('names the publisher and the window and nothing else', () => {
    const url = awinTransactionsUrl({
      baseUrl: 'https://api.awin.com',
      publisherId: '189069',
      from: new Date('2026-02-01T00:00:00.000Z'),
      to: new Date('2026-03-03T23:59:59.000Z'),
    });
    expect(url).toBe(
      'https://api.awin.com/publishers/189069/transactions/' +
        '?startDate=2026-02-01T00%3A00%3A00&endDate=2026-03-03T23%3A59%3A59&timezone=UTC',
    );
    // The token is a HEADER. A credential in a URL reaches an access log, an
    // error message and every `catch` that stringifies a request.
    expect(url).not.toMatch(/accessToken|Bearer/i);
  });

  it('covers a 45-day lookback with contiguous windows, no gap and no overlap', () => {
    const to = new Date('2026-03-15T12:00:00.000Z');
    const from = new Date(to.getTime() - 45 * 24 * 60 * 60 * 1_000);
    const windows = awinReportWindows(from, to);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(windows[0]?.from.toISOString()).toBe('2026-01-29T00:00:00.000Z');
    expect(windows[windows.length - 1]?.to.toISOString()).toBe('2026-03-15T23:59:59.000Z');
    for (const [index, window] of windows.entries()) {
      // Awin refuses more than 31 days; a window that straddles the boundary is
      // rejected at exactly two moments a year in one hemisphere.
      const days = (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1_000);
      expect(days).toBeLessThanOrEqual(31);
      const previous = windows[index - 1];
      if (previous) {
        // Contiguous to the second: the next window starts the day after the
        // previous one ends. A one-day gap at a seam is commission that is
        // never read, and its only symptom is a number slightly too small.
        expect(window.from.getTime() - previous.to.getTime()).toBe(1_000);
      }
    }
  });

  it('refuses a URL that is not on the configured Publisher API origin', () => {
    expect(() =>
      assertAwinPublisherUrl('https://api.awin.com.evil.test/publishers/1/transactions/', 'https://api.awin.com'),
    ).toThrow();
    expect(() =>
      assertAwinPublisherUrl('http://api.awin.com/publishers/1/transactions/', 'https://api.awin.com'),
    ).toThrow();
    expect(() =>
      assertAwinPublisherUrl('https://api.awin.com/publishers/1/transactions/', 'https://api.awin.com'),
    ).not.toThrow();
  });
});

describe('the eBay seam', () => {
  it('answers `network_not_configured` and never an empty list', () => {
    // An empty list and "no conversions this month" are the same value. This
    // domain's whole failure mode is a number that is quietly too small, so the
    // seam refuses instead.
    expect(EBAY_REPORT_READER_UNAVAILABLE.outcome).toBe('unavailable');
    if (EBAY_REPORT_READER_UNAVAILABLE.outcome !== 'unavailable') return;
    expect(EBAY_REPORT_READER_UNAVAILABLE.reason).toBe('network_not_configured');
    expect(EBAY_REPORT_READER_UNAVAILABLE.detail).toContain('EPN');
  });
});
