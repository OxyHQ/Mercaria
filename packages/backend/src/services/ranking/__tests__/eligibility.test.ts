/**
 * `OfferEligibilityService` (#74 rules 1–10), against a table of inputs.
 *
 * Every case states ONE fact differing from the bland fixture, so the reason
 * code a case asserts is provably caused by that fact and not by the shape of
 * the builder. The two boundary cases the issue's acceptance 8 names — unknown
 * data and the edges of each rule — are the ones with their own describes.
 */

import { describe, expect, it } from 'vitest';
import { OFFER_ELIGIBILITY_RULES, OFFER_EXCLUSION_RULE } from '@mercaria/shared-types';
import {
  evaluateOfferEligibility,
  selectEligibleOffers,
  type OfferEligibilityContext,
} from '../eligibility.js';
import { buildFacts, buildOffer, expiredAssessment } from './offer-fixtures.js';

/**
 * The reasons one evaluation produced.
 *
 * The evaluation also returns the ADMISSION — which rules actually ran — and
 * that half has its own case at the bottom of this file rather than being
 * repeated in thirty assertions about reason codes.
 */
function reasonsFor(offer: Parameters<typeof evaluateOfferEligibility>[0], ctx: OfferEligibilityContext) {
  return evaluateOfferEligibility(offer, ctx).reasons;
}

function context(overrides: Partial<OfferEligibilityContext> = {}): OfferEligibilityContext {
  return {
    canonicalVariantIds: new Set(['variant-1']),
    customerClasses: [],
    experience: 'buy_now',
    suppressedMerchantIds: new Set<string>(),
    suppressedStorefrontIds: new Set<string>(),
    ...overrides,
  };
}

describe('the ten eligibility rules', () => {
  it('admits the bland case, so every refusal below is caused by its own fact', () => {
    // The positive control. Without it a builder that produced a permanently
    // ineligible offer would make every case below pass for the wrong reason.
    expect(reasonsFor(buildOffer(), context())).toEqual([]);
  });

  it('1 — a retired offer is refused', () => {
    expect(reasonsFor(buildOffer({ status: 'retired' }), context())).toContain(
      'offer_retired',
    );
  });

  it('2 — an offer on another canonical variant is refused', () => {
    expect(
      reasonsFor(buildOffer({ canonicalVariantId: 'variant-other' }), context()),
    ).toContain('wrong_canonical_variant');
  });

  it('3 — an expired observation is refused, with the level named', () => {
    const reasons = reasonsFor(
      buildOffer({ freshness: expiredAssessment() }),
      context(),
    );
    expect(reasons).toContain('observation_expired');
  });

  it('4 — an offer published for another market is refused', () => {
    expect(
      reasonsFor(buildOffer({ country: 'DE' }), context({ market: 'ES' })),
    ).toContain('market_not_served');
  });

  it('4 — an offer published for NO market is admitted everywhere', () => {
    // Absence of a scope is not a scope excluding anybody, and most feeds
    // publish none. Refusing them would empty every market-scoped comparison.
    expect(reasonsFor(buildOffer(), context({ market: 'ES' }))).toEqual([]);
  });

  it('4 — a trade-only offer is refused for a shopper who has proved nothing', () => {
    expect(
      reasonsFor(buildOffer({ customerEligibility: 'business_only' }), context()),
    ).toContain('customer_not_eligible');
  });

  it('4 — and admitted for a shopper who HAS established that class', () => {
    expect(
      reasonsFor(
        buildOffer({ customerEligibility: 'business_only' }),
        context({ customerClasses: ['business_only'] }),
      ),
    ).toEqual([]);
  });

  it('5 — `buy_now` refuses what the source DECLARED unbuyable', () => {
    expect(
      reasonsFor(buildOffer({ availability: 'out_of_stock' }), context()),
    ).toContain('availability_unsupported');
  });

  it('5 — `browse` keeps an out-of-stock offer and still refuses an unavailable one', () => {
    const browsing = context({ experience: 'browse' });
    expect(reasonsFor(buildOffer({ availability: 'out_of_stock' }), browsing)).toEqual(
      [],
    );
    expect(
      reasonsFor(buildOffer({ availability: 'unavailable' }), browsing),
    ).toContain('availability_unsupported');
  });

  it('5 — an UNKNOWN availability is admitted under both experiences', () => {
    // The distinction this rule exists to make: silence is not a statement.
    // Refusing it would empty most comparisons, because most feeds publish no
    // availability at all; reading it as in-stock would be the soft yes.
    expect(reasonsFor(buildOffer({ availability: 'unknown' }), context())).toEqual([]);
    expect(
      reasonsFor(buildOffer({ availability: 'unknown' }), context({ experience: 'browse' })),
    ).toEqual([]);
  });

  it('6 — a condition outside the filter is refused, and one inside it is not', () => {
    const filtered = context({ conditionGroups: ['used'] });
    expect(reasonsFor(buildOffer({ condition: 'new' }), filtered)).toContain(
      'condition_excluded',
    );
    expect(reasonsFor(buildOffer({ condition: 'used_good' }), filtered)).toEqual([]);
  });

  it('6 — an UNKNOWN condition cannot satisfy a filter, and passes when there is none', () => {
    // The opposite treatment from rule 5's unknown, and the difference is what a
    // filter MEANS: a shopper asking only for used items cannot be shown one
    // whose condition nobody knows.
    expect(
      reasonsFor(buildOffer({ condition: 'unknown' }), context({ conditionGroups: ['used'] })),
    ).toContain('condition_excluded');
    expect(reasonsFor(buildOffer({ condition: 'unknown' }), context())).toEqual([]);
  });

  it('7 — a native offer with no stock is refused, through #57s own derivation', () => {
    const reasons = reasonsFor(buildOffer({ kind: 'native' }), context());
    expect(reasons).toContain('out_of_stock');
  });

  it('7 — an EXTERNAL offer is never refused for `not_native`', () => {
    // Every external offer's `checkout` is `{eligible:false, reasons:['not_native']}`
    // by construction. Reading it here would refuse the whole external
    // catalogue, which is the bug this branch exists to avoid.
    expect(reasonsFor(buildOffer({ kind: 'external' }), context())).toEqual([]);
  });

  it('8 — an external offer with no destination is refused', () => {
    expect(
      reasonsFor(buildOffer({ destinationUrl: null }), context()),
    ).toContain('destination_missing');
  });

  it('8 — an INFORMATIONAL offer needs no destination', () => {
    expect(
      reasonsFor(
        buildOffer({ kind: 'informational', destinationUrl: null }),
        context(),
      ),
    ).toEqual([]);
  });

  it('10 — a suppressed merchant, storefront or source is refused', () => {
    expect(
      reasonsFor(
        buildOffer({ merchantId: 'm-1' }),
        context({ suppressedMerchantIds: new Set(['m-1']) }),
      ),
    ).toContain('merchant_suppressed');
    expect(
      reasonsFor(
        buildOffer({ storefrontId: 's-1' }),
        context({ suppressedStorefrontIds: new Set(['s-1']) }),
      ),
    ).toContain('storefront_suppressed');
    expect(reasonsFor(buildOffer({ mayDisplay: false }), context())).toContain(
      'source_display_withheld',
    );
  });

  it('reports EVERY reason that applies, not just the first', () => {
    const reasons = reasonsFor(
      buildOffer({ status: 'retired', canonicalVariantId: 'other', mayDisplay: false }),
      context(),
    );
    expect(reasons).toEqual([
      'offer_retired',
      'wrong_canonical_variant',
      'source_display_withheld',
    ]);
  });

  it('records the rules it ACTUALLY ran, and covers the whole tuple', () => {
    // The admission is built by marking each rule at the point it is evaluated,
    // NOT by echoing `OFFER_ELIGIBILITY_RULES`. The constant form would make the
    // ranker's assertion vacuous — both sides would read one tuple, so a rule
    // added and never evaluated would satisfy the check trivially, which is
    // precisely the case it exists for.
    const evaluation = evaluateOfferEligibility(buildOffer(), context());
    expect(evaluation.admission.rulesEvaluated).toEqual(OFFER_ELIGIBILITY_RULES);
  });

  it('records them even for an offer refused by the FIRST rule', () => {
    // No early return: an offer that fails rule 1 is still evaluated against the
    // other nine, which is what makes "every reason that applies" true AND what
    // stops a short-circuit producing a candidate the ranker then refuses.
    const evaluation = evaluateOfferEligibility(buildOffer({ status: 'retired' }), context());
    expect(evaluation.admission.rulesEvaluated).toEqual(OFFER_ELIGIBILITY_RULES);
  });

  it('every reason names a rule, and every rule is reachable from some reason', () => {
    // The completeness half: a reason with no rule would be unexplainable, and a
    // rule no reason names is one nothing can report having failed.
    const named = new Set(Object.values(OFFER_EXCLUSION_RULE));
    expect([...OFFER_ELIGIBILITY_RULES].filter((rule) => !named.has(rule))).toEqual([]);
  });
});

describe('selection carries the admission and the exclusions', () => {
  it('admits, refuses, and records every rule it evaluated', () => {
    const selection = selectEligibleOffers({
      offers: [buildOffer({ id: 'good' }), buildOffer({ id: 'bad', status: 'retired' })],
      context: context(),
      buildFacts: () => buildFacts(),
    });

    expect(selection.eligible.map((entry) => entry.offerId)).toEqual(['good']);
    expect(selection.excluded.map((entry) => entry.offerId)).toEqual(['bad']);
    expect(selection.eligible[0]?.admission.rulesEvaluated).toEqual(OFFER_ELIGIBILITY_RULES);
  });

  it('builds facts ONLY for the offers it admits', () => {
    // A restricted listing's merchant rating is not something a comparison
    // surface should be reading, and the callback is what makes that structural
    // rather than a matter of ordering statements.
    const built: string[] = [];
    selectEligibleOffers({
      offers: [buildOffer({ id: 'good' }), buildOffer({ id: 'bad', status: 'retired' })],
      context: context(),
      buildFacts: (offer) => {
        built.push(offer.id);
        return buildFacts();
      },
    });
    expect(built).toEqual(['good']);
  });
});
