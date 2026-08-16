/**
 * The payment-facts port's UNREGISTERED behaviour (#344).
 *
 * Every deployment is unregistered today — nothing calls
 * `registerReferralRiskPaymentFactsReader` — so this file measures the state
 * that actually ships, which is the reason `partner-readiness.port.ts` exports
 * its default too. A port whose unregistered behaviour is untestable is a port
 * whose unregistered behaviour is unknown.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS,
  readReferralRiskPaymentFacts,
  registerReferralRiskPaymentFactsReader,
  resetReferralRiskPaymentFactsReader,
  type ReferralRiskPaymentFacts,
  type ReferralRiskPaymentSubject,
} from '../payment-facts.port.js';

const SUBJECT: ReferralRiskPaymentSubject = {
  partnerId: 'partner-1',
  ownerType: 'user',
  ownerId: 'oxy-user-1',
  windowStart: new Date('2026-08-01T00:00:00.000Z'),
  windowEnd: new Date('2026-08-02T00:00:00.000Z'),
};

afterEach(() => {
  resetReferralRiskPaymentFactsReader();
  vi.restoreAllMocks();
});

describe('the unregistered default is SILENCE, not a zero', () => {
  it('answers no facts at all', async () => {
    const facts = await readReferralRiskPaymentFacts(SUBJECT);
    expect(facts).toEqual({});
  });

  it('adds NO KEYS when spread, which is the property the caller depends on', async () => {
    // `collectRiskSignalFacts` spreads this into a `ReferralRiskSignalFacts`.
    // An object carrying three explicit `undefined`s would spread three keys in,
    // and `'disputeRateBps' in facts` would then be TRUE for a fact nobody
    // measured — "we looked" made indistinguishable from "the field exists".
    // `deriveRiskSignals` reads the VALUE rather than the key today, so this is
    // defence against a future reader that asks the other question.
    const facts = { conversionsInWindow: 3, ...(await readReferralRiskPaymentFacts(SUBJECT)) };
    expect(Object.keys(facts)).toEqual(['conversionsInWindow']);
  });

  it('is the exported constant, so the doc and the behaviour cannot drift', async () => {
    expect(await readReferralRiskPaymentFacts(SUBJECT)).toBe(
      UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS,
    );
  });
});

describe('a registered reader is consulted and its answer passes through', () => {
  it('receives the subject and returns its facts verbatim', async () => {
    const seen: ReferralRiskPaymentSubject[] = [];
    const answer: ReferralRiskPaymentFacts = {
      sharedPayoutBeneficiaryPartnerCount: 2,
      disputeRateBps: 450,
    };
    registerReferralRiskPaymentFactsReader(async (subject) => {
      seen.push(subject);
      return answer;
    });

    expect(await readReferralRiskPaymentFacts(SUBJECT)).toEqual(answer);
    expect(seen).toEqual([SUBJECT]);
    // The third fact stays ABSENT rather than arriving as a zero: a reader that
    // can measure two of three says so by omission.
    expect('providerAdverseOutcomeCount' in answer).toBe(false);
  });

  it('a LATER registration replaces the earlier one', async () => {
    registerReferralRiskPaymentFactsReader(async () => ({ disputeRateBps: 1 }));
    registerReferralRiskPaymentFactsReader(async () => ({ disputeRateBps: 2 }));
    expect(await readReferralRiskPaymentFacts(SUBJECT)).toEqual({ disputeRateBps: 2 });
  });
});

describe('a reader that THROWS is the same situation as no reader', () => {
  it('never propagates, and answers the same silence', async () => {
    // A throw here would abort `collectRiskSignalFacts`, turning a payment-domain
    // outage into a failure to record the SIX facts that have nothing to do with
    // payments — an operator's risk evaluation returning nothing at the moment
    // they most wanted it.
    registerReferralRiskPaymentFactsReader(async () => {
      throw new Error('the rail is down');
    });

    await expect(readReferralRiskPaymentFacts(SUBJECT)).resolves.toEqual({});
  });

  it('a SYNCHRONOUS throw is caught too', async () => {
    // `await reader(...)` inside the `try` covers both, but the two are
    // different code paths in the caller and only one of them is the obvious
    // one to write a test for.
    registerReferralRiskPaymentFactsReader((() => {
      throw new Error('threw before returning a promise');
    }) as never);

    await expect(readReferralRiskPaymentFacts(SUBJECT)).resolves.toEqual({});
  });
});
