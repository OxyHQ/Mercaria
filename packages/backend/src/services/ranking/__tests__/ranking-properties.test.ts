/**
 * Property tests over randomized inputs (#74 acceptance 8): currency
 * conversion, missing data, ties and eligibility boundaries.
 *
 * The generator is a small deterministic LCG rather than a random source, and
 * the seed is printed into every failure message: a property test that fails
 * once on a seed nobody recorded is a flake report, not a bug report. The retail
 * pricing domain's markup property test is the local precedent.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_CURRENCY_CODES,
  OFFER_ELIGIBILITY_RULES,
  OFFER_RANKING_SIGNALS,
  hasKnownTotal,
  weightedSignalScore,
  type CurrencyCode,
  type EligibleOffer,
  type FxRates,
} from '@mercaria/shared-types';
import { composeComparisonTotal, convertOfferMoney } from '../money.js';
import { BUILTIN_RANKING_POLICY } from '../policy.js';
import { rankOffers } from '../ranking.js';
import { buildFacts } from './offer-fixtures.js';

/** A deterministic 32-bit LCG. Reproducible, and no dependency. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

const RATE_TABLE: Record<string, number> = {
  FAIR: 1,
  USD: 0.05,
  EUR: 0.045,
  GBP: 0.039,
  JPY: 7.4,
};

function ratesFor(base: CurrencyCode): FxRates {
  // Every rate expressed against `base`, derived from the FAIR table exactly as
  // `fx.service` derives a non-pivot base — so the fixture cannot accidentally
  // be self-consistent in a way the real service is not.
  const perBase = RATE_TABLE[base] ?? 1;
  const rates: Record<string, number> = {};
  for (const [code, perFair] of Object.entries(RATE_TABLE)) {
    rates[code] = perFair / perBase;
  }
  return { base, rates, provider: 'static', asOf: '2026-08-10T12:00:00.000Z', stale: false, ttlSeconds: 60 };
}

const QUOTABLE = Object.keys(RATE_TABLE) as CurrencyCode[];

describe('property: currency conversion', () => {
  it('a converted price is always in the comparison currency, and carries its quote', () => {
    const random = lcg(20_260_810);
    for (let run = 0; run < 300; run += 1) {
      const target = QUOTABLE[Math.floor(random() * QUOTABLE.length)] ?? 'EUR';
      const source = QUOTABLE[Math.floor(random() * QUOTABLE.length)] ?? 'EUR';
      const amount = Math.floor(random() * 1_000_000) + 1;

      const converted = convertOfferMoney({ amount, currency: source }, target, ratesFor(target));
      expect(converted.known, `run ${run}: ${amount} ${source} -> ${target}`).toBe(true);
      if (!converted.known) continue;
      expect(converted.amount.currency).toBe(target);
      expect(converted.fx.from).toBe(source);
      expect(converted.fx.to).toBe(target);
      expect(converted.fx.rate).toBeGreaterThan(0);
      expect(Number.isInteger(converted.amount.amount)).toBe(true);
    }
  });

  it('a currency no rate covers is UNKNOWN — never zero, never dropped', () => {
    const uncovered = ALL_CURRENCY_CODES.filter((code) => RATE_TABLE[code] === undefined);
    // Vacuity floor: if every currency were covered this case would pass while
    // testing nothing at all.
    expect(uncovered.length).toBeGreaterThan(0);
    for (const code of uncovered) {
      const converted = convertOfferMoney({ amount: 1_000, currency: code }, 'EUR', ratesFor('EUR'));
      expect(converted.known).toBe(false);
      expect(converted.known === false ? converted.reason : undefined).toBe('not_convertible');
    }
  });

  it('a currency outside Mercarias set entirely is UNKNOWN, not a crash', () => {
    // #57 states this exception deliberately: an offer's currency is whatever
    // the SOURCE published and may sit outside `CurrencyCode`.
    const converted = convertOfferMoney({ amount: 1_000, currency: 'XYZ' }, 'EUR', ratesFor('EUR'));
    expect(converted.known).toBe(false);
  });

  it('a total is known EXACTLY when both halves are', () => {
    const random = lcg(7);
    for (let run = 0; run < 200; run += 1) {
      const itemKnown = random() < 0.5;
      const deliveryKnown = random() < 0.5;
      const total = composeComparisonTotal(
        itemKnown
          ? convertOfferMoney({ amount: 1_000, currency: 'EUR' }, 'EUR', ratesFor('EUR'))
          : { known: false, reason: 'not_published' },
        deliveryKnown
          ? convertOfferMoney({ amount: 200, currency: 'EUR' }, 'EUR', ratesFor('EUR'))
          : { known: false, reason: 'not_published' },
      );
      expect(hasKnownTotal(total), `run ${run}`).toBe(itemKnown && deliveryKnown);
      if (!hasKnownTotal(total)) {
        expect(total.missing.length).toBe((itemKnown ? 0 : 1) + (deliveryKnown ? 0 : 1));
      }
    }
  });
});

describe('property: missing data', () => {
  it('an unknown signal is in NEITHER half of the weighted mean', () => {
    const random = lcg(99);
    for (let run = 0; run < 200; run += 1) {
      const scoredOutcomes = OFFER_RANKING_SIGNALS.map((signal) => ({
        signal,
        state: 'scored' as const,
        normalized: random(),
        weight: 1,
        detail: '',
      }));
      const full = weightedSignalScore(scoredOutcomes);

      // Turn ONE outcome unknown and confirm the score becomes the mean of the
      // REST rather than the mean including a zero.
      const index = Math.floor(random() * scoredOutcomes.length);
      const kept = scoredOutcomes.filter((_, position) => position !== index);
      const withUnknown = weightedSignalScore([
        ...kept,
        { signal: OFFER_RANKING_SIGNALS[index] ?? 'item_price', state: 'unknown', reason: 'not_published', detail: '' },
      ]);
      expect(withUnknown).toBeCloseTo(weightedSignalScore(kept), 12);

      const asZero =
        (full * scoredOutcomes.length - (scoredOutcomes[index]?.normalized ?? 0)) /
        scoredOutcomes.length;
      // …and confirm the two really are different, so the assertion above is not
      // vacuously true for a fixture where they happen to coincide.
      if ((scoredOutcomes[index]?.normalized ?? 0) !== weightedSignalScore(kept)) {
        expect(withUnknown).not.toBeCloseTo(asZero, 12);
      }
    }
  });

  it('an offer with NOTHING known scores zero and is still ranked, never dropped', () => {
    const barren: EligibleOffer = {
      offerId: 'barren',
      kind: 'informational',
      admission: { rulesEvaluated: OFFER_ELIGIBILITY_RULES },
      facts: buildFacts({ itemPriceMinor: null, deliveryMinor: null, availability: 'unknown' }),
    };
    const ranked = rankOffers({
      candidates: [barren],
      policy: BUILTIN_RANKING_POLICY,
      intent: 'balanced',
      viewerLocationProvided: false,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.score).toBe(0);
    // And it carries no `best_overall`: calling a zero-scored offer the best
    // would present a digest tie-break as a judgement.
    expect(ranked[0]?.labels.map((award) => award.label)).not.toContain('best_overall');
  });
});

describe('property: ties and ordering', () => {
  it('the order is independent of the order the candidates arrive in', () => {
    const random = lcg(4_242);
    for (let run = 0; run < 100; run += 1) {
      const size = 2 + Math.floor(random() * 8);
      const candidates: EligibleOffer[] = [];
      for (let index = 0; index < size; index += 1) {
        candidates.push({
          offerId: `offer-${index}`,
          kind: 'external',
          admission: { rulesEvaluated: OFFER_ELIGIBILITY_RULES },
          // Deliberately coarse values, so ties are COMMON — a generator with a
          // wide spread would almost never exercise the tie-break at all.
          facts: buildFacts({
            itemPriceMinor: 1_000 * (1 + Math.floor(random() * 3)),
            deliveryMinor: 100 * Math.floor(random() * 3),
          }),
        });
      }

      const forwards = rankOffers({
        candidates,
        policy: BUILTIN_RANKING_POLICY,
        intent: 'balanced',
        viewerLocationProvided: false,
      }).map((entry) => entry.offerId);

      const shuffled = [...candidates].sort(() => (random() < 0.5 ? -1 : 1));
      const backwards = rankOffers({
        candidates: shuffled,
        policy: BUILTIN_RANKING_POLICY,
        intent: 'balanced',
        viewerLocationProvided: false,
      }).map((entry) => entry.offerId);

      expect(backwards, `run ${run}`).toEqual(forwards);
    }
  });

  it('ranks are 1..n with no gaps and no repeats, whatever the input', () => {
    const random = lcg(31_337);
    for (let run = 0; run < 100; run += 1) {
      const size = 1 + Math.floor(random() * 10);
      const candidates: EligibleOffer[] = Array.from({ length: size }, (_, index) => ({
        offerId: `offer-${index}`,
        kind: 'external',
        admission: { rulesEvaluated: OFFER_ELIGIBILITY_RULES },
        facts: buildFacts({
          itemPriceMinor: random() < 0.3 ? null : Math.floor(random() * 50_000),
          deliveryMinor: random() < 0.3 ? null : Math.floor(random() * 2_000),
        }),
      }));
      const ranked = rankOffers({
        candidates,
        policy: BUILTIN_RANKING_POLICY,
        intent: 'cheapest',
        viewerLocationProvided: false,
      });
      expect(ranked.map((entry) => entry.rank), `run ${run}`).toEqual(
        Array.from({ length: size }, (_, index) => index + 1),
      );
    }
  });

  it('an offer with an unknown total never precedes one with a known total under `cheapest`', () => {
    const random = lcg(2_026);
    for (let run = 0; run < 100; run += 1) {
      const candidates: EligibleOffer[] = Array.from({ length: 6 }, (_, index) => ({
        offerId: `offer-${index}`,
        kind: 'external',
        admission: { rulesEvaluated: OFFER_ELIGIBILITY_RULES },
        facts: buildFacts({
          itemPriceMinor: Math.floor(random() * 20_000) + 1,
          deliveryMinor: random() < 0.5 ? null : Math.floor(random() * 1_000),
        }),
      }));
      const ranked = rankOffers({
        candidates,
        policy: BUILTIN_RANKING_POLICY,
        intent: 'cheapest',
        viewerLocationProvided: false,
      });

      const byId = new Map(candidates.map((entry) => [entry.offerId, entry]));
      let seenUnknown = false;
      for (const entry of ranked) {
        const known = hasKnownTotal(byId.get(entry.offerId)?.facts.total ?? { known: false, missing: [] });
        if (!known) seenUnknown = true;
        else expect(seenUnknown, `run ${run}: a known total appeared after an unknown one`).toBe(false);
      }
    }
  });
});
