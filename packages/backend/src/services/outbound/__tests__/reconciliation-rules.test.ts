/**
 * The four PURE rules of commission reconciliation (#67).
 *
 * Everything measured here decides money or decides what a run counted, and
 * none of it needs a database — which is the point of it being pure. The cases
 * that matter most are the ones that take four polls to reach (approve,
 * reverse, approve, pay); nobody would drive those through a real report, and a
 * rule only reachable that way is a rule nobody checks.
 */

import { describe, expect, it, afterEach } from 'vitest';
import type { AffiliateCommissionPostingRow } from '../../../db/affiliateOutbound/postingRepository.js';
import {
  AFFILIATE_CLASSIFICATION_ORDER,
  affiliateContentDigest,
  classifyAffiliateObservation,
  observationChangedTheRecord,
  type AffiliateSourceFacts,
  type StoredAffiliateObservation,
} from '../reconciliation/observe.js';
import { resolveRefusalAccountRef } from '../reconciliation/poll.service.js';
import {
  lookupAffiliateClick,
  matchReportedTransaction,
  registerAffiliateClickResolver,
  resetAffiliateClickResolver,
} from '../reconciliation/matching.js';
import { planAffiliateCommissionPostings } from '../reconciliation/posting.js';

const EVENT_AT = new Date('2026-03-01T10:00:00.000Z');

function facts(overrides: Partial<AffiliateSourceFacts> = {}): AffiliateSourceFacts {
  return {
    state: 'approved',
    orderValue: { amount: 2400, currency: 'GBP' },
    commission: { amount: 120, currency: 'GBP' },
    eventAt: EVENT_AT,
    networkProcessedAt: null,
    advertiserRef: '7052',
    publisherRef: '189069',
    networkClickRef: null,
    ...overrides,
  };
}

/** The stored side, derived from the same facts so the two cannot drift. */
function stored(
  source: AffiliateSourceFacts,
  overrides: Partial<StoredAffiliateObservation> = {},
): StoredAffiliateObservation {
  return {
    state: source.state,
    orderValueAmount: source.orderValue?.amount ?? null,
    orderValueCurrency: source.orderValue?.currency ?? null,
    commissionAmount: source.commission.amount,
    commissionCurrency: source.commission.currency,
    contentDigest: affiliateContentDigest(source),
    ...overrides,
  };
}

/** The incoming side, likewise. */
function incoming(source: AffiliateSourceFacts) {
  return {
    state: source.state,
    orderValue: source.orderValue,
    commission: source.commission,
    contentDigest: affiliateContentDigest(source),
  };
}

describe('the content digest', () => {
  it('is 64 hex characters, which the CHECK requires', () => {
    expect(affiliateContentDigest(facts())).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is stable across two readings of one unchanged transaction', () => {
    // A `Date` is a new object on every poll. If the digest depended on object
    // identity — or on property insertion order — every re-poll would read as a
    // change, every transaction would grow an observation an hour, and every
    // approval would try to re-book money it had already booked.
    const first = affiliateContentDigest(facts({ eventAt: new Date(EVENT_AT.getTime()) }));
    const second = affiliateContentDigest(facts({ eventAt: new Date(EVENT_AT.getTime()) }));
    expect(second).toBe(first);
  });

  it('moves for every source-reported field it covers', () => {
    const base = affiliateContentDigest(facts());
    const variants: readonly AffiliateSourceFacts[] = [
      facts({ state: 'paid' }),
      facts({ orderValue: { amount: 2401, currency: 'GBP' } }),
      facts({ orderValue: { amount: 2400, currency: 'EUR' } }),
      facts({ orderValue: null }),
      facts({ commission: { amount: 121, currency: 'GBP' } }),
      facts({ commission: { amount: 120, currency: 'EUR' } }),
      facts({ eventAt: new Date('2026-03-02T10:00:00.000Z') }),
      facts({ networkProcessedAt: new Date('2026-03-05T10:00:00.000Z') }),
      facts({ advertiserRef: '7053' }),
      facts({ publisherRef: '189070' }),
      // IN the digest, and the reason is written at the function: without it a
      // network that started echoing an attribution reference would read
      // `unchanged` forever and the match would never be recomputed.
      facts({ networkClickRef: 'mox-abc' }),
    ];
    // A positive control on the DIGEST's own coverage: a field the digest
    // silently ignored would make a real correction read as `unchanged`, and
    // the only symptom would be a commission that is quietly wrong.
    for (const variant of variants) {
      expect(affiliateContentDigest(variant)).not.toBe(base);
    }
    expect(new Set(variants.map(affiliateContentDigest)).size).toBe(variants.length);
  });
});

describe('classifying an observation', () => {
  it('calls the first sighting `first_observation`', () => {
    expect(classifyAffiliateObservation(undefined, incoming(facts()))).toBe('first_observation');
  });

  it('calls an identical re-poll `unchanged`', () => {
    const source = facts();
    expect(classifyAffiliateObservation(stored(source), incoming(source))).toBe('unchanged');
  });

  it('calls a moved state `state_change`, even when the amount moved with it', () => {
    // The precedence that matters: a reversal carrying a corrected amount is a
    // REVERSAL. Bucketing it as `amount_change` would bury it among "somebody
    // adjusted a number", which is the row an operator scrolls past.
    const previous = stored(facts({ state: 'approved' }));
    const next = facts({ state: 'reversed', commission: { amount: 60, currency: 'GBP' } });
    expect(classifyAffiliateObservation(previous, incoming(next))).toBe('state_change');
  });

  it('calls a same-state commission correction `amount_change`', () => {
    const previous = stored(facts());
    const next = facts({ commission: { amount: 130, currency: 'GBP' } });
    expect(classifyAffiliateObservation(previous, incoming(next))).toBe('amount_change');
  });

  it('calls a same-state order-value correction `amount_change`', () => {
    const previous = stored(facts());
    const next = facts({ orderValue: { amount: 2600, currency: 'GBP' } });
    expect(classifyAffiliateObservation(previous, incoming(next))).toBe('amount_change');
  });

  it('calls a re-issued record with the same money `restated`', () => {
    const previous = stored(facts());
    const next = facts({ networkProcessedAt: new Date('2026-03-06T09:00:00.000Z') });
    expect(classifyAffiliateObservation(previous, incoming(next))).toBe('restated');
  });

  it('calls a newly-echoed click reference `restated`, not `unchanged`', () => {
    // THE ONLY moving field is `network_click_ref`. It is source-reported, so a
    // digest without it would make a network that started supplying attribution
    // read as unchanged forever and the match would never be recomputed — a
    // latent bug that becomes reachable when somebody ELSE's contract changes,
    // which is exactly when nobody is reading this file.
    const before = facts({ networkClickRef: null });
    const after = facts({ networkClickRef: 'mox-abc' });
    expect(classifyAffiliateObservation(stored(before), incoming(after))).toBe('restated');
    // And a reference the network keeps echoing unchanged is still `unchanged`,
    // so including it has not made every poll a change.
    expect(classifyAffiliateObservation(stored(after), incoming(after))).toBe('unchanged');
  });

  it('decides in the documented TOTAL ORDER, state before amount', () => {
    // A test that drove the five kinds one at a time would pass under ANY
    // ordering. Asserting the sequence is what makes the precedence checkable.
    expect(AFFILIATE_CLASSIFICATION_ORDER).toEqual([
      'first_observation',
      'state_change',
      'amount_change',
      'restated',
    ]);
  });

  it('lands the degenerate case — state, money AND metadata all moving — on `state_change`', () => {
    // What a network actually does when it validates a transaction: the state
    // moves, the commission is corrected and a processing instant appears, all
    // in one poll. Three predicates true at once is where an ordering bug shows,
    // and it must read as the state move.
    const previous = stored(facts({ state: 'pending' }));
    const next = facts({
      state: 'approved',
      commission: { amount: 130, currency: 'GBP' },
      orderValue: { amount: 2600, currency: 'GBP' },
      networkProcessedAt: new Date('2026-03-05T00:00:00.000Z'),
      networkClickRef: 'mox-abc',
    });
    expect(classifyAffiliateObservation(previous, incoming(next))).toBe('state_change');
  });

  it('marks every kind but `unchanged` as changing the record', () => {
    expect(observationChangedTheRecord('unchanged')).toBe(false);
    for (const kind of ['first_observation', 'state_change', 'amount_change', 'restated'] as const) {
      expect(observationChangedTheRecord(kind)).toBe(true);
    }
  });
});

describe('matching a reported transaction', () => {
  afterEach(() => {
    resetAffiliateClickResolver();
  });

  it('answers `network_supplies_no_reference` for the networks as they stand', () => {
    // The production answer, for both networks, for every transaction. It is
    // the adapter CONTRACT talking, not the transaction — which is why it takes
    // precedence over a reference the network happened to echo.
    for (const network of ['awin', 'ebay'] as const) {
      expect(
        matchReportedTransaction({
          network,
          referenceSupport: 'not_supported',
          networkClickRef: 'something-the-network-sent',
          resolvedClick: { id: 'click-1', network },
        }),
      ).toEqual({ state: 'unmatched', reason: 'network_supplies_no_reference' });
    }
  });

  it('MATCHES when a supported network echoes a reference that resolves', () => {
    expect(
      matchReportedTransaction({
        network: 'awin',
        referenceSupport: 'publisher_supplied',
        networkClickRef: 'click-42',
        resolvedClick: { id: 'click-42', network: 'awin' },
      }),
    ).toEqual({ state: 'matched', clickId: 'click-42' });
  });

  it('tells the three unmatched reasons apart', () => {
    const base = { network: 'awin', referenceSupport: 'publisher_supplied' } as const;
    expect(
      matchReportedTransaction({ ...base, networkClickRef: null, resolvedClick: null }),
    ).toEqual({ state: 'unmatched', reason: 'no_reference_reported' });
    expect(
      matchReportedTransaction({ ...base, networkClickRef: '   ', resolvedClick: null }),
    ).toEqual({ state: 'unmatched', reason: 'no_reference_reported' });
    expect(
      matchReportedTransaction({ ...base, networkClickRef: 'click-9', resolvedClick: null }),
    ).toEqual({ state: 'unmatched', reason: 'reference_not_recognized' });
    expect(
      matchReportedTransaction({
        ...base,
        networkClickRef: 'click-9',
        resolvedClick: { id: 'click-9', network: 'ebay' },
      }),
    ).toEqual({ state: 'unmatched', reason: 'reference_network_mismatch' });
  });

  it('never looks up a click for a network that supplies none', async () => {
    let consulted = 0;
    registerAffiliateClickResolver(async () => {
      consulted += 1;
      return null;
    });
    const lookup = await lookupAffiliateClick({
      network: 'awin',
      referenceSupport: 'not_supported',
      reference: 'whatever',
    });
    expect(lookup).toEqual({ outcome: 'not_supported' });
    expect(consulted).toBe(0);
  });

  it('reports an unregistered resolver rather than answering "no click"', async () => {
    // "We looked and found nothing" and "we never looked" must not be the same
    // value: the first is publishable as `reference_not_recognized` and the
    // second is a deployment fault.
    const lookup = await lookupAffiliateClick({
      network: 'awin',
      referenceSupport: 'publisher_supplied',
      reference: 'click-3',
    });
    expect(lookup).toEqual({ outcome: 'resolver_unavailable' });
  });
});

/** A posting row as the database would hand one back. */
function posting(
  overrides: Partial<AffiliateCommissionPostingRow> & Pick<AffiliateCommissionPostingRow, 'kind' | 'amountMinor'>,
): AffiliateCommissionPostingRow {
  return {
    id: `posting-${String(overrides.revision ?? 1)}-${overrides.kind}`,
    transactionId: 'tx-1',
    ledgerTransactionId: 'ledger-1',
    revision: 1,
    currency: 'GBP',
    postedAt: EVENT_AT,
    createdAt: EVENT_AT,
    ...overrides,
  };
}

describe('planning the ledger postings', () => {
  const commission = { amount: 120, currency: 'GBP' } as const;
  const plan = (
    state: Parameters<typeof planAffiliateCommissionPostings>[0]['state'],
    booked: readonly AffiliateCommissionPostingRow[] = [],
    money: { amount: number; currency: 'GBP' | 'EUR' } = commission,
  ) =>
    planAffiliateCommissionPostings({
      state,
      commission: money,
      networkTransactionId: 'awin-1',
      booked,
    });

  it('books NOTHING for a pending commission', () => {
    // The rule this whole domain exists to enforce: a pending commission is a
    // claim the network may still decline, and booking one is revenue that
    // exists in Mercaria's book and nowhere in the world.
    const result = plan('pending');
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings).toHaveLength(0);
  });

  it('books NOTHING for a decline that was never accrued', () => {
    const result = plan('declined');
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings).toHaveLength(0);
  });

  it('accrues on approval: debit the receivable, credit the revenue', () => {
    const result = plan('approved');
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings).toHaveLength(1);
    const [accrual] = result.postings;
    expect(accrual?.kind).toBe('accrual');
    expect(accrual?.ledgerKind).toBe('affiliate_commission_accrued');
    expect(accrual?.receivableMinor).toBe(120);
    expect(accrual?.entries).toEqual([
      { account: 'affiliate_receivable', currency: 'GBP', amountMinor: 120n },
      { account: 'affiliate_commission_revenue', currency: 'GBP', amountMinor: -120n },
    ]);
  });

  it('accrues AND settles when a network reports `paid` having never shown `approved`', () => {
    const result = plan('paid');
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings.map((entry) => entry.kind)).toEqual(['accrual', 'settlement']);
    // Recognition FIRST: settling a receivable that was never created would
    // leave `affiliate_receivable` permanently negative for this transaction.
    expect(result.postings[1]?.entries).toEqual([
      { account: 'platform_funds', currency: 'GBP', amountMinor: 120n },
      { account: 'affiliate_receivable', currency: 'GBP', amountMinor: -120n },
    ]);
  });

  it('settles only the outstanding part once an accrual is already booked', () => {
    const result = plan('paid', [posting({ kind: 'accrual', amountMinor: 120 })]);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings.map((entry) => entry.kind)).toEqual(['settlement']);
  });

  it('reverses exactly what was accrued when the network takes it back', () => {
    const result = plan('reversed', [posting({ kind: 'accrual', amountMinor: 120 })]);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings).toHaveLength(1);
    const [reversal] = result.postings;
    expect(reversal?.kind).toBe('reversal');
    expect(reversal?.receivableMinor).toBe(-120);
    expect(reversal?.entries).toEqual([
      { account: 'affiliate_receivable', currency: 'GBP', amountMinor: -120n },
      { account: 'affiliate_commission_revenue', currency: 'GBP', amountMinor: 120n },
    ]);
  });

  it('accrues AGAIN when a reversed transaction is approved a second time', () => {
    const result = plan('approved', [
      posting({ kind: 'accrual', amountMinor: 120, revision: 1 }),
      posting({ kind: 'reversal', amountMinor: -120, revision: 2 }),
    ]);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings.map((entry) => entry.kind)).toEqual(['accrual']);
    expect(result.postings[0]?.receivableMinor).toBe(120);
  });

  it('books only the DIFFERENCE when a commission is corrected while approved', () => {
    const result = plan('approved', [posting({ kind: 'accrual', amountMinor: 120 })], {
      amount: 130,
      currency: 'GBP',
    });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.receivableMinor).toBe(10);
  });

  it('unwinds a settled commission when a paid transaction is reversed', () => {
    // The clawback. Without the negative settlement the receivable would be
    // reversed while `platform_funds` kept money the network is taking back.
    const result = plan('reversed', [
      posting({ kind: 'accrual', amountMinor: 120, revision: 1 }),
      posting({ kind: 'settlement', amountMinor: -120, revision: 2 }),
    ]);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings.map((entry) => entry.kind)).toEqual(['reversal', 'settlement']);
    expect(result.postings[1]?.entries).toEqual([
      { account: 'platform_funds', currency: 'GBP', amountMinor: -120n },
      { account: 'affiliate_receivable', currency: 'GBP', amountMinor: 120n },
    ]);
  });

  it('is a no-op when everything the state calls for is already booked', () => {
    // Idempotency by CONSTRUCTION rather than by a claim: the unique index is
    // the second layer, and this is the first.
    const result = plan('paid', [
      posting({ kind: 'accrual', amountMinor: 120, revision: 1 }),
      posting({ kind: 'settlement', amountMinor: -120, revision: 2 }),
    ]);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.postings).toHaveLength(0);
  });

  it('every plan balances to zero per currency', () => {
    const cases: readonly (readonly [
      Parameters<typeof planAffiliateCommissionPostings>[0]['state'],
      readonly AffiliateCommissionPostingRow[],
    ])[] = [
      ['approved', []],
      ['paid', []],
      ['paid', [posting({ kind: 'accrual', amountMinor: 120 })]],
      ['reversed', [posting({ kind: 'accrual', amountMinor: 120 })]],
      [
        'reversed',
        [
          posting({ kind: 'accrual', amountMinor: 120, revision: 1 }),
          posting({ kind: 'settlement', amountMinor: -120, revision: 2 }),
        ],
      ],
    ];
    let measured = 0;
    for (const [state, booked] of cases) {
      const result = plan(state, booked);
      if (result.outcome !== 'planned') continue;
      for (const entry of result.postings) {
        measured += 1;
        const sum = entry.entries.reduce((total, leg) => total + leg.amountMinor, 0n);
        expect({ kind: entry.kind, sum }).toEqual({ kind: entry.kind, sum: 0n });
      }
    }
    // The floor: "every plan balances" is also what zero plans would report.
    expect(measured).toBeGreaterThanOrEqual(7);
  });

  it('records a refused attempt only under an identity that EXISTS', () => {
    // #124's rule: a refusal is an outcome, and silence reads identically to
    // "the loop never ran". But `account_ref` names the publisher account a
    // report was drawn under, so a placeholder there would make every reader of
    // that column wrong forever. Both branches, driven directly.
    expect(
      resolveRefusalAccountRef('ebay', { campaignId: '5338123456', attributionEnabled: true }),
    ).toBe('5338123456');
    expect(
      resolveRefusalAccountRef('ebay', { campaignId: '5338123456', attributionEnabled: false }),
    ).toBeNull();
    expect(resolveRefusalAccountRef('ebay', { campaignId: '   ', attributionEnabled: true })).toBeNull();
    // Awin's refusal is reached only when no account row exists at all, so
    // there is no publisher id to name and the pass result carries the reason.
    expect(
      resolveRefusalAccountRef('awin', { campaignId: '5338123456', attributionEnabled: true }),
    ).toBeNull();
  });

  it('REFUSES to net a commission the network re-denominated', () => {
    const result = plan('approved', [posting({ kind: 'accrual', amountMinor: 120 })], {
      amount: 100,
      currency: 'EUR',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('currency_restated');
  });
});
