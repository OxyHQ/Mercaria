/**
 * Every rail that BOOKS is a rail the ledger audit LOOKS AT.
 *
 * `PROVIDER_BOOKS_LEDGER` is what `payment.service.transition` branches on when
 * a payment succeeds: `true` means a `charge_succeeded` transaction is written
 * in that same commit. `auditMissingChargeTransactions` is the sweep that finds
 * succeeded payments with no such transaction behind them. If a rail books but
 * the audit does not scan it, the audit reports nothing wrong — not because
 * nothing is wrong, but because it never looked, which is the failure mode that
 * reads exactly like health.
 *
 * That is not hypothetical. The audit's list was hand-written as
 * `['stripe', 'mock']` under a comment calling it "an ASSERTION, not a copy";
 * no assertion existed, and ADR 0009's `peable` was added to the booking table
 * without being added here. An entire money-moving rail was uncovered.
 *
 * `BOOKING_PROVIDERS` is now derived, so the two cannot disagree by
 * construction. This file is the floor under that: it fails if the derivation
 * is ever replaced by a literal that drifts, and — more importantly — it fails
 * if the derivation is replaced by something vacuous.
 */

import { describe, expect, it } from 'vitest';
import { PAYMENT_PROVIDER_IDS } from '@mercaria/shared-types';
import { PROVIDER_BOOKS_LEDGER } from '../../payment.service.js';
import { BOOKING_PROVIDERS } from '../ledger-audit.job.js';

describe('the rails the ledger audit covers', () => {
  it('scans exactly the rails that book, and no others', () => {
    const books = PAYMENT_PROVIDER_IDS.filter((provider) => PROVIDER_BOOKS_LEDGER[provider]);

    // Set equality AND length, because comparing as sets passes just as happily
    // with a duplicated member — and a duplicate here would make the sweep's
    // `providers` filter match the same rail twice, which is harmless today and
    // is the kind of harmless that stops being harmless when somebody counts.
    expect(BOOKING_PROVIDERS.length).toBe(books.length);
    expect([...BOOKING_PROVIDERS].sort()).toEqual([...books].sort());
  });

  it('covers `peable`, the rail whose absence was the bug', () => {
    // Named rather than left to the set comparison above. That comparison is
    // satisfied by two lists that are wrong in the same way — if `peable` were
    // dropped from `PROVIDER_BOOKS_LEDGER` by mistake, the derivation would
    // faithfully drop it here too and the case above would still pass.
    expect(PROVIDER_BOOKS_LEDGER.peable).toBe(true);
    expect(BOOKING_PROVIDERS).toContain('peable');
  });

  it('covers `stripe` while both rails coexist', () => {
    // ADR 0009 D13: the two rails run side by side until the Peable one is
    // verified end to end. Until then a Stripe payment can still be created, so
    // the audit that would notice an unbooked one still has to run.
    expect(BOOKING_PROVIDERS).toContain('stripe');
  });

  it('excludes the rails that book nothing by design', () => {
    // ADR 0001 D12 / #45 acceptance 5. Scanning these would report every
    // externally-captured and every till payment as a missing charge, which is
    // a sweep that cries wolf on every pass until somebody switches it off.
    expect(BOOKING_PROVIDERS).not.toContain('external');
    expect(BOOKING_PROVIDERS).not.toContain('manual_pos');
  });

  it('is not vacuously satisfied by an empty list', () => {
    // The real floor. A `filter` whose predicate silently became false-y would
    // satisfy every case above except this one: an empty `providers` filter
    // makes the sweep scan nothing and report clean, forever.
    expect(BOOKING_PROVIDERS.length).toBeGreaterThanOrEqual(3);
  });
});
