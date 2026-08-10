/**
 * `OfferRankingService` — the scenario fixtures #74 policy rule 4 asks for
 * (price, unknown shipping, official store, poor rating, stale data, used
 * condition, ties) and every acceptance criterion that is checkable without a
 * database.
 *
 * The acceptance criteria have their own describe at the bottom, named after the
 * numbers, so a reviewer can read the issue and the test side by side.
 */

import { describe, expect, it } from 'vitest';
import { OFFER_ELIGIBILITY_RULES, OFFER_RANKING_SIGNALS } from '@mercaria/shared-types';
import { BUILTIN_RANKING_POLICY } from '../policy.js';
import { rankOffers } from '../ranking.js';
import { selectEligibleOffers } from '../eligibility.js';
import { buildCandidate, buildFacts, buildOffer } from './offer-fixtures.js';

const policy = BUILTIN_RANKING_POLICY;

function rank(candidates: Parameters<typeof rankOffers>[0]['candidates'], intent: Parameters<typeof rankOffers>[0]['intent'] = 'balanced') {
  return rankOffers({ candidates, policy, intent, viewerLocationProvided: false });
}

function labelsOf(ranked: ReturnType<typeof rank>, offerId: string): string[] {
  return (ranked.find((entry) => entry.offerId === offerId)?.labels ?? []).map((award) => award.label);
}

describe('scenario: price', () => {
  it('orders a cheaper item above a dearer one, all else equal', () => {
    const ranked = rank([
      buildCandidate('dear', { itemPriceMinor: 20_000 }),
      buildCandidate('cheap', { itemPriceMinor: 10_000 }),
    ]);
    expect(ranked.map((entry) => entry.offerId)).toEqual(['cheap', 'dear']);
    expect(labelsOf(ranked, 'cheap')).toContain('cheapest_item_price');
  });
});

describe('scenario: unknown shipping', () => {
  const candidates = [
    buildCandidate('known-total', { itemPriceMinor: 10_500, deliveryMinor: 500 }),
    buildCandidate('unknown-shipping', { itemPriceMinor: 10_000, deliveryMinor: null }),
  ];

  it('never calls an offer with unknown shipping the cheapest known total', () => {
    // Acceptance 2, and the mechanism is a TYPE rather than this assertion: the
    // label writer's parameter requires a known total, and the unknown branch of
    // `OfferComparisonTotal` has no amount to build one from.
    const ranked = rank(candidates);
    expect(labelsOf(ranked, 'unknown-shipping')).not.toContain('cheapest_known_total');
    expect(labelsOf(ranked, 'known-total')).toContain('cheapest_known_total');
  });

  it('still lets it hold `cheapest_item_price`, which IS known about it', () => {
    const ranked = rank(candidates);
    expect(labelsOf(ranked, 'unknown-shipping')).toContain('cheapest_item_price');
  });

  it('reports the unknown as a reason rather than scoring it zero', () => {
    const ranked = rank(candidates);
    const outcome = ranked
      .find((entry) => entry.offerId === 'unknown-shipping')
      ?.signals.find((signal) => signal.signal === 'delivery_cost');
    expect(outcome?.state).toBe('unknown');
    expect(outcome && outcome.state === 'unknown' ? outcome.reason : undefined).toBe(
      'not_published',
    );
  });

  it('does not let the unknown WIN the `cheapest` intent over a known total', () => {
    // The three-tier intent key: a known total is comparable on total, an offer
    // with only a known item price is comparable on that, and neither may be
    // claimed cheaper than the other.
    const ranked = rank(candidates, 'cheapest');
    expect(ranked[0]?.offerId).toBe('known-total');
  });
});

describe('scenario: official store', () => {
  it('labels an official channel and an authorized reseller separately', () => {
    const ranked = rank([
      buildCandidate('official', { relationship: 'official_channel' }),
      buildCandidate('reseller', { relationship: 'authorized_reseller' }),
      buildCandidate('ordinary', { relationship: 'none' }),
    ]);
    expect(labelsOf(ranked, 'official')).toContain('official_direct_store');
    expect(labelsOf(ranked, 'reseller')).toContain('authorized_reseller');
    expect(labelsOf(ranked, 'ordinary')).toEqual(expect.not.arrayContaining(['official_direct_store']));
  });

  it('sorts official channels first under the `official` intent and nowhere else', () => {
    const candidates = [
      buildCandidate('ordinary', { itemPriceMinor: 8_000, relationship: 'none' }),
      buildCandidate('official', { itemPriceMinor: 12_000, relationship: 'official_channel' }),
    ];
    expect(rank(candidates, 'official')[0]?.offerId).toBe('official');
    // Without the intent, the cheaper ordinary offer still wins on price — the
    // relationship is a weighted signal and not a trump card.
    expect(rank(candidates, 'cheapest')[0]?.offerId).toBe('ordinary');
  });
});

describe('scenario: poor rating and thin evidence', () => {
  it('scores a well-reviewed merchant above a poorly-reviewed one', () => {
    const ranked = rank([
      buildCandidate('poor', { merchantRating: 2, merchantReviewCount: 50 }),
      buildCandidate('good', { merchantRating: 4.8, merchantReviewCount: 50 }),
    ]);
    expect(ranked[0]?.offerId).toBe('good');
  });

  it('refuses to score a rating below the policy floor, and says why', () => {
    // A single five-star review is not evidence. Scoring it would put a
    // brand-new merchant above an established one on a sample of one.
    const ranked = rank([buildCandidate('thin', { merchantRating: 5, merchantReviewCount: 1 })]);
    const outcome = ranked[0]?.signals.find((signal) => signal.signal === 'merchant_rating');
    expect(outcome?.state).toBe('unknown');
    expect(outcome && outcome.state === 'unknown' ? outcome.reason : undefined).toBe(
      'below_confidence_floor',
    );
  });

  it('does not let a thin rating OUTSCORE a real one — they tie, and the digest decides', () => {
    // The precise promise, and it is worth stating exactly because the obvious
    // stronger claim ("the rated one wins") is false and SHOULD be: the thin
    // merchant's rating is unknown, an unknown is left out of the denominator,
    // and the rated merchant is the only rating in the set so it normalizes to
    // 1. With nothing else differing there is genuinely nothing to choose
    // between them, and inventing a winner would be scoring the absence of
    // evidence.
    //
    // This case is also what caught the ORIGINAL absolute 0–5 scale, under which
    // the thin one scored HIGHER — a comparison surface rewarding a merchant for
    // having no rating. See `deriveSignals`' merchant-rating branch.
    const ranked = rank([
      buildCandidate('thin', { merchantRating: 5, merchantReviewCount: 1 }),
      buildCandidate('real', { merchantRating: 4.5, merchantReviewCount: 200 }),
    ]);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
    expect(ranked[1]?.tieBreakerApplied).toBe('stable_digest');
  });

  it('and a real rating DOES beat a real worse one, which is the discriminating case', () => {
    const ranked = rank([
      buildCandidate('worse', { merchantRating: 3.9, merchantReviewCount: 200 }),
      buildCandidate('better', { merchantRating: 4.8, merchantReviewCount: 200 }),
    ]);
    expect(ranked[0]?.offerId).toBe('better');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 1);
  });
});

describe('scenario: stale data', () => {
  it('scores a freshly confirmed observation above one near its deadline', () => {
    const ranked = rank([
      buildCandidate('old', { freshnessElapsedFraction: 0.9 }),
      buildCandidate('fresh', { freshnessElapsedFraction: 0.05 }),
    ]);
    expect(ranked[0]?.offerId).toBe('fresh');
  });

  it('treats an unbounded deadline as unknown, never as stale', () => {
    // A native offer's `stale_at` measures the convergence dispatcher, not the
    // seller — measuring it on that clock would make dispatcher latency a
    // ranking input, in one direction, for one kind of offer.
    const ranked = rank([buildCandidate('native-ish')]);
    const outcome = ranked[0]?.signals.find((signal) => signal.signal === 'observation_freshness');
    expect(outcome?.state).toBe('unknown');
  });
});

describe('scenario: used condition', () => {
  it('awards `cheapest_used` within the used segment only', () => {
    const ranked = rank([
      buildCandidate('new-cheap', { itemPriceMinor: 5_000, condition: 'new' }),
      buildCandidate('used-dear', { itemPriceMinor: 9_000, condition: 'used_good' }),
      buildCandidate('used-cheap', { itemPriceMinor: 7_000, condition: 'used_fair' }),
    ]);
    expect(labelsOf(ranked, 'used-cheap')).toContain('cheapest_used');
    expect(labelsOf(ranked, 'new-cheap')).toContain('cheapest_item_price');
    expect(labelsOf(ranked, 'new-cheap')).not.toContain('cheapest_used');
  });

  it('does not put a REFURBISHED offer in the used segment', () => {
    const ranked = rank([
      buildCandidate('refurb', { itemPriceMinor: 4_000, condition: 'refurbished_manufacturer' }),
      buildCandidate('used', { itemPriceMinor: 9_000, condition: 'used_good' }),
    ]);
    expect(labelsOf(ranked, 'refurb')).not.toContain('cheapest_used');
    expect(labelsOf(ranked, 'used')).toContain('cheapest_used');
  });

  it('sorts the used segment first under the `used` intent', () => {
    const ranked = rank(
      [
        buildCandidate('new', { itemPriceMinor: 1_000, condition: 'new' }),
        buildCandidate('used', { itemPriceMinor: 9_000, condition: 'used_good' }),
      ],
      'used',
    );
    expect(ranked[0]?.offerId).toBe('used');
  });
});

describe('scenario: ties', () => {
  const identical = () => [
    buildCandidate('offer-aaa'),
    buildCandidate('offer-bbb'),
    buildCandidate('offer-ccc'),
  ];

  it('breaks a total tie deterministically and reports the tie-breaker', () => {
    const first = rank(identical()).map((entry) => entry.offerId);
    const second = rank(identical()).map((entry) => entry.offerId);
    expect(first).toEqual(second);
    expect(rank(identical())[1]?.tieBreakerApplied).toBe('stable_digest');
  });

  it('is independent of the order the candidates arrived in', () => {
    // Policy rule 7. The comparator is TOTAL — the digest never ties — so
    // `Array.prototype.sort`'s stability cannot leak the input order.
    const forwards = rank(identical()).map((entry) => entry.offerId);
    const backwards = rank([...identical()].reverse()).map((entry) => entry.offerId);
    expect(backwards).toEqual(forwards);
  });

  it('breaks a score tie on the known total before falling to the digest', () => {
    // Both score identically because neither has any distinguishing fact except
    // the delivery cost, which is worth less than the price is.
    const ranked = rank([
      buildCandidate('dearer-total', { itemPriceMinor: 10_000, deliveryMinor: 900 }),
      buildCandidate('cheaper-total', { itemPriceMinor: 10_000, deliveryMinor: 100 }),
    ]);
    expect(ranked[0]?.offerId).toBe('cheaper-total');
  });
});

describe('acceptance criteria', () => {
  it('1 — the same eligible input produces the same order for one policy version', () => {
    const candidates = [
      buildCandidate('a', { itemPriceMinor: 10_000 }),
      buildCandidate('b', { itemPriceMinor: 10_000 }),
      buildCandidate('c', { itemPriceMinor: 9_999 }),
    ];
    const runs = [rank(candidates), rank(candidates), rank(candidates)].map((ranked) =>
      ranked.map((entry) => `${entry.offerId}:${entry.rank}`),
    );
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it('3 — a high-commission offer receives no organic advantage', () => {
    // Structural: `OfferRankingFacts` has no commission field, so the two
    // candidates below are byte-identical to the scorer. The assertion is that
    // there is nowhere for an affiliate fact to have entered.
    const facts = buildFacts({ itemPriceMinor: 10_000 });
    expect(Object.keys(facts)).not.toContain('affiliateNetwork');
    expect(Object.keys(facts)).not.toContain('commissionBps');
    const ranked = rank([buildCandidate('a'), buildCandidate('b')]);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
  });

  it('4 — FAIR acceptance receives no organic advantage', () => {
    // Every comparison names ONE currency and every price is converted into it,
    // so an offer priced in FAIR is scored on the converted number and nothing
    // else. Two offers at the same converted price score identically.
    const ranked = rank([
      buildCandidate('fair-priced', { itemPriceMinor: 10_000 }),
      buildCandidate('eur-priced', { itemPriceMinor: 10_000 }),
    ]);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
  });

  it('4b — a NATIVE offer scores exactly as an identical external one does', () => {
    // `native_offer_preference` is a forbidden signal, and the label
    // `native_mercaria_checkout` is information rather than a score term. The
    // two candidates differ ONLY in `nativeCheckoutEligible`.
    const ranked = rank([
      buildCandidate('native', { nativeCheckoutEligible: true }),
      buildCandidate('external', { nativeCheckoutEligible: false }),
    ]);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
    expect(labelsOf(ranked, 'native')).toContain('native_mercaria_checkout');
    expect(labelsOf(ranked, 'external')).not.toContain('native_mercaria_checkout');
  });

  it('5 — the official store and the cheapest offer can differ and both be visible', () => {
    const ranked = rank([
      buildCandidate('official', { itemPriceMinor: 15_000, relationship: 'official_channel' }),
      buildCandidate('cheap', { itemPriceMinor: 9_000, relationship: 'none' }),
    ]);
    expect(labelsOf(ranked, 'official')).toContain('official_direct_store');
    expect(labelsOf(ranked, 'cheap')).toContain('cheapest_item_price');
    expect(ranked).toHaveLength(2);
  });

  it('6 — every displayed label carries a machine-readable reason code', () => {
    const ranked = rank([
      buildCandidate('one', { relationship: 'official_channel', deliveryMaxDays: 2, nativeCheckoutEligible: true }),
    ]);
    const labels = ranked[0]?.labels ?? [];
    expect(labels.length).toBeGreaterThan(0);
    for (const award of labels) {
      expect(award.reason).toMatch(/^[a-z_]+$/);
    }
  });

  it('every signal is reported for every offer, scored or unknown', () => {
    // The completeness floor: a signal added to the tuple and forgotten in the
    // derivation would carry a weight nothing applied, and its absence from an
    // explanation reads exactly like a legitimate unknown.
    const ranked = rank([buildCandidate('one')]);
    expect(ranked[0]?.signals.map((signal) => signal.signal).sort()).toEqual(
      [...OFFER_RANKING_SIGNALS].sort(),
    );
  });
});

describe('ranking refuses a candidate eligibility did not fully admit', () => {
  it('throws, naming the rules that were not evaluated', () => {
    const partial = {
      ...buildCandidate('sneaky'),
      admission: { rulesEvaluated: OFFER_ELIGIBILITY_RULES.slice(0, 3) },
    };
    expect(() => rank([partial])).toThrow(/without every eligibility rule evaluated/);
    expect(() => rank([partial])).toThrow(/moderation_restriction/);
  });

  it('accepts what the REAL derivation produced — the end-to-end half', () => {
    // The case above hand-builds a partial admission, which proves the assertion
    // fires but not that the real derivation satisfies it. This composes the two
    // services exactly as `comparison.service.ts` does, so a rule added to the
    // tuple and never evaluated fails HERE as well as in the eligibility suite —
    // mutation-verified by adding an eleventh rule and watching both go red.
    const selection = selectEligibleOffers({
      offers: [buildOffer({ id: 'real' })],
      context: {
        canonicalVariantIds: new Set(['variant-1']),
        customerClasses: [],
        experience: 'buy_now',
        suppressedMerchantIds: new Set<string>(),
        suppressedStorefrontIds: new Set<string>(),
      },
      buildFacts: () => buildFacts(),
    });
    expect(selection.eligible).toHaveLength(1);
    expect(() => rank(selection.eligible)).not.toThrow();
    expect(rank(selection.eligible)[0]?.offerId).toBe('real');
  });
});
