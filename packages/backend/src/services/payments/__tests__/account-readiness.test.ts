/**
 * The readiness conjunction and the state derivation, as truth tables.
 *
 * These are the two functions a checkout gate ultimately consults, and they are
 * pure precisely so they can be tested exhaustively without a database or a
 * gateway. ADR 0001 D9 is a conjunction, and the failure that matters is a
 * conjunct silently dropped — so every conjunct gets its own case where it
 * alone is false, which is the shape that fails if `&&` becomes `||` or a term
 * is deleted.
 */

import { describe, expect, it } from 'vitest';
import {
  type AccountSnapshot,
  deriveOnboardingState,
  isPaymentReady,
  safeReasonCodes,
  toAccountState,
} from '../account-readiness.js';

/** A snapshot that satisfies every conjunct — the base each case perturbs by one. */
function readySnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    chargesEnabled: true,
    payoutsEnabled: true,
    transfersCapability: 'active',
    payable: true,
    currentlyDue: 0,
    eventuallyDue: 0,
    pastDue: 0,
    pendingVerification: 0,
    disabledReasonCodes: [],
    ...overrides,
  };
}

describe('isPaymentReady — ADR 0001 D9', () => {
  it('is true when every conjunct holds', () => {
    expect(isPaymentReady(readySnapshot())).toBe(true);
  });

  it.each([
    ['payouts are disabled', { payoutsEnabled: false }],
    ['the transfers capability is pending', { transfersCapability: 'pending' as const }],
    ['the transfers capability is inactive', { transfersCapability: 'inactive' as const }],
    ['the transfers capability was never requested', { transfersCapability: undefined }],
    ['the gateway does not call the account payable', { payable: false }],
    ['a requirement is currently due', { currentlyDue: 1 }],
    ['a requirement is past due', { pastDue: 1 }],
    ['the provider gave a disabling reason', { disabledReasonCodes: ['requirements.past_due'] }],
  ])('is false when %s', (_label, overrides: Partial<AccountSnapshot>) => {
    expect(isPaymentReady(readySnapshot(overrides))).toBe(false);
  });

  it('does not consult charges_enabled, which D3 makes irrelevant', () => {
    // The connected account never charges a card under separate charges and
    // transfers, so a seller whose account cannot charge can still be paid.
    expect(isPaymentReady(readySnapshot({ chargesEnabled: false }))).toBe(true);
  });

  it('ignores eventually-due requirements, which are collected but not blocking', () => {
    expect(isPaymentReady(readySnapshot({ eventuallyDue: 4 }))).toBe(true);
  });
});

describe('deriveOnboardingState', () => {
  it('is ready when the conjunction holds', () => {
    expect(deriveOnboardingState(readySnapshot())).toBe('ready');
  });

  it.each([['rejected.fraud'], ['rejected.something_new'], ['listed'], ['platform_paused']])(
    'is disabled for the terminal reason %s, even with everything else enabled',
    (reason) => {
      expect(deriveOnboardingState(readySnapshot({ disabledReasonCodes: [reason] }))).toBe(
        'disabled',
      );
    },
  );

  it('is restricted when something is past due, and that beats review', () => {
    expect(
      deriveOnboardingState(
        readySnapshot({ pastDue: 1, disabledReasonCodes: ['under_review'], payable: false }),
      ),
    ).toBe('restricted');
  });

  it('is under review when the provider names review as the reason', () => {
    expect(
      deriveOnboardingState(
        readySnapshot({ payoutsEnabled: false, disabledReasonCodes: ['under_review'] }),
      ),
    ).toBe('under_review');
  });

  it('is under review when nothing is asked and verification or the capability is pending', () => {
    expect(
      deriveOnboardingState(readySnapshot({ pendingVerification: 2, payoutsEnabled: false })),
    ).toBe('under_review');
    expect(
      deriveOnboardingState(readySnapshot({ transfersCapability: 'pending', payable: false })),
    ).toBe('under_review');
  });

  it('is action required for a freshly opened account with requirements due', () => {
    expect(
      deriveOnboardingState({
        chargesEnabled: false,
        payoutsEnabled: false,
        transfersCapability: 'inactive',
        payable: false,
        currentlyDue: 3,
        eventuallyDue: 3,
        pastDue: 0,
        pendingVerification: 0,
        disabledReasonCodes: ['requirements.past_due'],
      }),
    ).toBe('action_required');
  });
});

describe('safeReasonCodes', () => {
  it('keeps a machine token and drops prose to `other`', () => {
    expect(safeReasonCodes('requirements.past_due')).toEqual(['requirements.past_due']);
    expect(safeReasonCodes('Your account was flagged by J. Smith')).toEqual(['other']);
  });

  it('is empty for no reason at all', () => {
    expect(safeReasonCodes(null)).toEqual([]);
    expect(safeReasonCodes('  ')).toEqual([]);
  });
});

describe('toAccountState', () => {
  it('carries the observation time and the derived verdict, never a stored ready flag', () => {
    const syncedAt = new Date('2025-03-14T10:00:00.000Z');
    const state = toAccountState(readySnapshot({ defaultCurrency: 'EUR' }), syncedAt);
    expect(state).toMatchObject({
      onboardingState: 'ready',
      payoutsEnabled: true,
      transfersCapability: 'active',
      defaultCurrency: 'EUR',
      syncedAt,
    });
    expect(state).not.toHaveProperty('ready');
  });
});
