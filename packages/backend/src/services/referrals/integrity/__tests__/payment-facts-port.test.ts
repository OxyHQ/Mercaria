/**
 * The payment-facts port's UNREGISTERED behaviour, and the subject's shape
 * (#344).
 *
 * `services/referral-payouts/register.ts` fills this port at boot, so a
 * deployment that reached `startServer` is registered — but a port whose
 * unregistered behaviour is untestable is a port whose unregistered behaviour is
 * unknown (`partner-readiness.port.ts`'s reasoning, and it is not hypothetical:
 * anything that constructs the domain without the join, a partial boot, or the
 * next port added here, all land in it).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFERRAL_RISK_ORDER_COHORT_BOUND,
  UNREGISTERED_REFERRAL_RISK_PAYMENT_FACTS,
  readReferralRiskPaymentFacts,
  registerReferralRiskPaymentFactsReader,
  resetReferralRiskPaymentFactsReader,
  type ReferralRiskOrderCohort,
  type ReferralRiskPaymentFacts,
  type ReferralRiskPaymentSubject,
} from '../payment-facts.port.js';

const SUBJECT: ReferralRiskPaymentSubject = {
  partnerId: 'partner-1',
  ownerType: 'user',
  ownerId: 'oxy-user-1',
  windowStart: new Date('2026-08-01T00:00:00.000Z'),
  windowEnd: new Date('2026-08-02T00:00:00.000Z'),
  conversionsInWindow: 12,
  orderCohort: { kind: 'enumerated', orderRefs: ['order-1', 'order-2'] },
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

describe('the cohort is a STRING-discriminated union, and both members mean something', () => {
  it('narrows without `strictNullChecks`, which a boolean discriminant would not', () => {
    // This package compiles with `strict: false`. Under it TypeScript does not
    // narrow a union on the truthiness of a boolean-literal member, so a reader
    // written as `if (!cohort.enumerated)` would be left holding the whole union
    // and would read `orderRefs` off the branch that has none. #68 and #110 both
    // hit exactly that; the assertion below is the compile-time property, made
    // executable — `orderRefs` is only reachable after the `kind` check.
    const cohort: ReferralRiskOrderCohort = { kind: 'enumerated', orderRefs: ['o-1'] };
    if (cohort.kind === 'enumerated') {
      expect(cohort.orderRefs).toEqual(['o-1']);
      return;
    }
    expect.unreachable('the enumerated branch must be the one that narrows');
  });

  it('an EMPTY enumerated cohort is a measurement, and `not_enumerable` is not', () => {
    // The distinction the reader must act on differently: "we looked and this
    // partner converted nothing from an order" versus "we declined to answer".
    // Collapsing them is the unknown-read-as-zero defect, and it would land on
    // the reassuring side — a partner too large to enumerate scoring a clean 0
    // bps dispute rate.
    const measured: ReferralRiskOrderCohort = { kind: 'enumerated', orderRefs: [] };
    const withheld: ReferralRiskOrderCohort = {
      kind: 'not_enumerable',
      reason: 'cohort_exceeds_bound',
    };
    expect(measured.kind).not.toBe(withheld.kind);
    expect('orderRefs' in withheld).toBe(false);
  });

  it('the bound is a real number the caller can exceed', () => {
    // A floor on the floor: a bound of 0 would make every cohort unmeasurable
    // and a bound of Infinity would make the truncation branch dead. Either
    // reads as coverage.
    expect(REFERRAL_RISK_ORDER_COHORT_BOUND).toBeGreaterThan(0);
    expect(Number.isFinite(REFERRAL_RISK_ORDER_COHORT_BOUND)).toBe(true);
  });

  it('passes the DENOMINATOR through untouched, so the reader cannot recount it', async () => {
    const seen: ReferralRiskPaymentSubject[] = [];
    registerReferralRiskPaymentFactsReader(async (subject) => {
      seen.push(subject);
      return {};
    });

    await readReferralRiskPaymentFacts({ ...SUBJECT, conversionsInWindow: 37 });
    expect(seen[0]?.conversionsInWindow).toBe(37);
    expect(seen[0]?.orderCohort).toEqual(SUBJECT.orderCohort);
  });
});
