/**
 * The readiness conjunction and the state derivation, as truth tables.
 *
 * These are the two functions a checkout gate ultimately consults, and they are
 * pure precisely so they can be tested exhaustively without a database, a Stripe
 * key or a webhook. ADR 0001 D9 is a five-way `and`, and the failure that
 * matters is a conjunct silently dropped — so every conjunct gets its own case
 * where it alone is false, which is the shape that fails if `&&` becomes `||`
 * or a term is deleted.
 *
 * `snapshotStripeAccount` is tested beside them because the mapping is where a
 * unit error hides: Stripe reports the deadline in epoch SECONDS, and a
 * millisecond reading puts every deadline in 1970 without any type complaining.
 */

import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  deriveOnboardingState,
  isPaymentReady,
  redactAccountId,
  snapshotStripeAccount,
  type StripeAccountSnapshot,
} from '../account.service.js';

/** A snapshot that satisfies every conjunct — the base each case perturbs by one. */
function readySnapshot(overrides: Partial<StripeAccountSnapshot> = {}): StripeAccountSnapshot {
  return {
    chargesEnabled: true,
    payoutsEnabled: true,
    transfersCapability: 'active',
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

  // One case per conjunct, each falsifying exactly one term. A conjunct that
  // was dropped from the `and` passes its own row and nothing else fails, which
  // is why "ready is true" above cannot be the only assertion.
  it.each([
    ['payouts are disabled', { payoutsEnabled: false }],
    ['the transfers capability is pending', { transfersCapability: 'pending' as const }],
    ['the transfers capability is inactive', { transfersCapability: 'inactive' as const }],
    ['the transfers capability was never requested', { transfersCapability: undefined }],
    ['a requirement is currently due', { currentlyDue: 1 }],
    ['a requirement is past due', { pastDue: 1 }],
    ['the provider gave a disabling reason', { disabledReasonCodes: ['requirements.past_due'] }],
  ])('is false when %s', (_label, overrides: Partial<StripeAccountSnapshot>) => {
    expect(isPaymentReady(readySnapshot(overrides))).toBe(false);
  });

  it('does not consult charges_enabled, which D3 makes irrelevant', () => {
    // The connected account never charges a card under separate charges and
    // transfers, so a seller whose account cannot charge can still be paid. If
    // this ever starts failing, the conjunction gained a term the ADR does not
    // have — and every P2P seller loses readiness for a capability nobody asked
    // Stripe for.
    expect(isPaymentReady(readySnapshot({ chargesEnabled: false }))).toBe(true);
  });

  it('ignores eventually-due requirements, which are collected but not blocking', () => {
    expect(isPaymentReady(readySnapshot({ eventuallyDue: 4 }))).toBe(true);
  });
});

describe('deriveOnboardingState', () => {
  it('is ready when the conjunction holds', () => {
    expect(deriveOnboardingState(readySnapshot(), { revoked: false })).toBe('ready');
  });

  it('is disabled once revoked, whatever else Stripe last said', () => {
    // The revocation branch has to beat a snapshot that would otherwise be
    // `ready` — a sync in flight when the deauthorization landed carries exactly
    // that snapshot, and letting it win would silently re-enable a seller
    // Mercaria can no longer pay.
    expect(deriveOnboardingState(readySnapshot(), { revoked: true })).toBe('disabled');
  });

  it.each([
    'rejected.fraud',
    'rejected.terms_of_service',
    'rejected.listed',
    'rejected.other',
    // Not in the explicit set: matched by the `rejected.` prefix, which is the
    // point — a rejection Stripe adds later must not read as `action_required`.
    'rejected.a_reason_invented_after_this_test_was_written',
    'listed',
    'platform_paused',
    'other',
  ])('is disabled on %s', (code) => {
    expect(
      deriveOnboardingState(readySnapshot({ payoutsEnabled: false, disabledReasonCodes: [code] }), {
        revoked: false,
      }),
    ).toBe('disabled');
  });

  it('is restricted when a requirement went past due', () => {
    expect(
      deriveOnboardingState(
        readySnapshot({
          payoutsEnabled: false,
          pastDue: 2,
          currentlyDue: 2,
          disabledReasonCodes: ['requirements.past_due'],
        }),
        { revoked: false },
      ),
    ).toBe('restricted');
  });

  it('prefers restricted over under_review when both apply', () => {
    // `past_due` is ahead of the review branch deliberately: an account can be
    // overdue AND have something in verification, and only one of those two is
    // something the seller can act on.
    expect(
      deriveOnboardingState(
        readySnapshot({
          payoutsEnabled: false,
          pastDue: 1,
          pendingVerification: 1,
          disabledReasonCodes: ['under_review'],
        }),
        { revoked: false },
      ),
    ).toBe('restricted');
  });

  it.each(['under_review', 'requirements.pending_verification'])(
    'is under_review on %s',
    (code) => {
      expect(
        deriveOnboardingState(
          readySnapshot({ payoutsEnabled: false, disabledReasonCodes: [code] }),
          { revoked: false },
        ),
      ).toBe('under_review');
    },
  );

  it('is under_review when nothing is asked of the seller and the capability is pending', () => {
    expect(
      deriveOnboardingState(
        readySnapshot({ payoutsEnabled: false, transfersCapability: 'pending' }),
        { revoked: false },
      ),
    ).toBe('under_review');
  });

  it('is under_review when documents are submitted and being checked', () => {
    expect(
      deriveOnboardingState(
        readySnapshot({ payoutsEnabled: false, transfersCapability: 'inactive', pendingVerification: 3 }),
        { revoked: false },
      ),
    ).toBe('under_review');
  });

  it('is action_required when the seller still has something to submit', () => {
    expect(
      deriveOnboardingState(
        readySnapshot({ payoutsEnabled: false, transfersCapability: 'pending', currentlyDue: 3 }),
        { revoked: false },
      ),
    ).toBe('action_required');
  });

  it('is action_required for a brand-new account with nothing collected', () => {
    expect(
      deriveOnboardingState(
        {
          chargesEnabled: false,
          payoutsEnabled: false,
          transfersCapability: 'inactive',
          currentlyDue: 6,
          eventuallyDue: 9,
          pastDue: 0,
          pendingVerification: 0,
          disabledReasonCodes: [],
        },
        { revoked: false },
      ),
    ).toBe('action_required');
  });
});

/** A Stripe account object with only the fields the mapping reads. */
function stripeAccount(overrides: Record<string, unknown>): Stripe.Account {
  return { id: 'acct_test', object: 'account', ...overrides } as unknown as Stripe.Account;
}

describe('snapshotStripeAccount', () => {
  it('counts requirements and keeps none of their names', () => {
    const snapshot = snapshotStripeAccount(
      stripeAccount({
        charges_enabled: false,
        payouts_enabled: false,
        capabilities: { transfers: 'pending', card_payments: 'inactive' },
        requirements: {
          currently_due: ['individual.id_number', 'individual.verification.document'],
          eventually_due: ['individual.id_number', 'tos_acceptance.date', 'external_account'],
          past_due: [],
          pending_verification: ['individual.verification.document'],
          disabled_reason: 'requirements.pending_verification',
          current_deadline: null,
        },
      }),
    );

    expect(snapshot.currentlyDue).toBe(2);
    expect(snapshot.eventuallyDue).toBe(3);
    expect(snapshot.pastDue).toBe(0);
    expect(snapshot.pendingVerification).toBe(1);
    expect(snapshot.transfersCapability).toBe('pending');

    // The identity-data position, asserted rather than trusted: no requirement
    // Stripe NAMED may survive the mapping. Serializing the whole snapshot is
    // the only form of this check a newly-added field cannot slip past.
    //
    // The assertions name whole requirement identifiers rather than fragments:
    // `verification` on its own also occurs inside the legitimate reason code
    // `requirements.pending_verification`, so a fragment match would fail for a
    // reason that has nothing to do with the property under test.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('individual.id_number');
    expect(serialized).not.toContain('individual.verification.document');
    expect(serialized).not.toContain('tos_acceptance.date');
    expect(serialized).not.toContain('external_account');
  });

  it('reads the deadline as epoch SECONDS', () => {
    // Read as milliseconds this lands in January 1970 and every deadline renders
    // as overdue by fifty years, with no type error anywhere — which is why the
    // assertion is a real instant and not "a Date".
    //
    // Both sides are derived from the same UTC instant rather than a literal
    // epoch number, so the test cannot pass because two hand-computed constants
    // happened to agree with each other and not with the calendar.
    const deadline = Date.UTC(2026, 8, 1, 0, 0, 0);
    const snapshot = snapshotStripeAccount(
      stripeAccount({ requirements: { current_deadline: deadline / 1_000 } }),
    );
    expect(snapshot.deadlineAt?.toISOString()).toBe(new Date(deadline).toISOString());
  });

  it('upper-cases the payout currency Stripe reports in lower case', () => {
    const snapshot = snapshotStripeAccount(stripeAccount({ default_currency: 'eur' }));
    expect(snapshot.defaultCurrency).toBe('EUR');
  });

  it('carries the payout schedule when Stripe supplies one', () => {
    const snapshot = snapshotStripeAccount(
      stripeAccount({ settings: { payouts: { schedule: { interval: 'weekly', delay_days: 7 } } } }),
    );
    expect(snapshot.payoutScheduleInterval).toBe('weekly');
    expect(snapshot.payoutScheduleDelayDays).toBe(7);
  });

  it('omits a capability that was never requested rather than calling it inactive', () => {
    const snapshot = snapshotStripeAccount(stripeAccount({ capabilities: {} }));
    expect(snapshot.transfersCapability).toBeUndefined();
  });

  it('replaces a reason code that is not a machine token', () => {
    // The field is a string whose value set is Stripe's. Anything that could be
    // a sentence — or a name — becomes `other` rather than being forwarded into
    // Mercaria's database and rendered in a seller's dashboard.
    const snapshot = snapshotStripeAccount(
      stripeAccount({ requirements: { disabled_reason: 'Rejected: contact Jane Doe (jane@x.test)' } }),
    );
    expect(snapshot.disabledReasonCodes).toEqual(['other']);
  });

  it('keeps a well-formed reason code verbatim', () => {
    const snapshot = snapshotStripeAccount(
      stripeAccount({ requirements: { disabled_reason: 'requirements.past_due' } }),
    );
    expect(snapshot.disabledReasonCodes).toEqual(['requirements.past_due']);
  });

  it('reports no reason codes when the account is not disabled', () => {
    const snapshot = snapshotStripeAccount(stripeAccount({ requirements: { disabled_reason: null } }));
    expect(snapshot.disabledReasonCodes).toEqual([]);
  });
});

describe('redactAccountId', () => {
  it('keeps only enough to tell two accounts apart', () => {
    expect(redactAccountId('acct_1QxYzAbCdEfGhIjK')).toBe('acct_…hIjK');
  });
});
