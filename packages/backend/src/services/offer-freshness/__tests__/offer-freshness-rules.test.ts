/**
 * The PURE rules of #68, against exact inputs and an exact clock.
 *
 * Every function under test takes `now` as a parameter and reads nothing, which
 * is what lets a fixture sit exactly ON a boundary instead of racing it. The
 * fixture rule `~/Oxy/AGENTS.md` (E) states is what shapes the choices below:
 *
 * - The freshness assessment gets an instant one millisecond BEFORE and exactly
 *   ON each threshold, because an off-by-one in `>=` versus `>` is invisible to
 *   a fixture in the middle of an interval.
 * - The policy-mismatch case uses a policy that is otherwise PERFECTLY VALID and
 *   differs only in `sourceId`. A malformed policy would be refused for an
 *   unrelated reason and prove nothing about the guard.
 * - The anomaly detectors get a LEGITIMATE SALE (a halved median) beside a
 *   minor/major units error (a hundredfold one), because a detector that cannot
 *   tell those apart is one whoever hits it next switches off.
 * - `rollUpOfferAvailability` gets a mix containing `unknown` beside a known
 *   value, since a fixture of all-unknown or all-known cannot distinguish
 *   "unknown survives" from "unknown is dropped".
 */

import { describe, expect, it } from 'vitest';
import {
  assessOfferFreshness,
  detectSourceAnomalies,
  effectiveOfferLifetimeSeconds,
  highestRefreshPriority,
  mayAppearInComparison,
  nativeOfferFreshness,
  offerRetirementDueAt,
  rollUpOfferAvailability,
  sourceHealthGrantsGrace,
  CATALOG_SOURCE_ANOMALY_KINDS,
  OFFER_REFRESH_PRIORITY_CLASSES,
  OFFER_REFRESH_PRIORITY_RANK,
  type OfferFreshnessObservation,
  type SourceAnomalyThresholds,
  type SourceFreshnessPolicy,
  type SourceObservationDistribution,
} from '@mercaria/shared-types';
import { chooseRefreshMode, supportsTargetedRefresh } from '../refresh-scheduler.js';
import { mergeDistributions, summariseObservations } from '../distribution.js';

const SOURCE = 'source-ebay';
const LAST_SEEN = new Date('2026-08-09T00:00:00.000Z');

/** A policy with distinct, non-round thresholds so no two can be confused. */
function policy(overrides: Partial<SourceFreshnessPolicy> = {}): SourceFreshnessPolicy {
  return {
    sourceId: SOURCE,
    basis: 'source_policy',
    policyVersion: 3,
    expectedRefreshIntervalSeconds: 3_600,
    warningAfterSeconds: 7_200,
    expiryAfterSeconds: 21_600,
    outageGraceSeconds: 7_200,
    cacheCapSeconds: null,
    retireOnSourceUnavailable: true,
    ...overrides,
  };
}

function observation(
  overrides: Partial<OfferFreshnessObservation> = {},
): OfferFreshnessObservation {
  return {
    sourceId: SOURCE,
    observedAt: LAST_SEEN,
    firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
    lastSeenAt: LAST_SEEN,
    lastConfirmedAt: LAST_SEEN,
    declaredUnavailableAt: null,
    // The offer's OWN deadline, only ever read when no source policy resolves.
    // Deliberately DIFFERENT from every threshold in `policy()`, so a case that
    // accidentally fell through to the fallback would produce a wrong answer
    // rather than the right one for the wrong reason.
    storedExpiresAt: new Date(LAST_SEEN.getTime() + 300_000),
    ...overrides,
  };
}

function at(offsetSeconds: number): Date {
  return new Date(LAST_SEEN.getTime() + offsetSeconds * 1_000);
}

describe('assessOfferFreshness — the thresholds are the SOURCE’s, not a global one', () => {
  it('is current one millisecond BEFORE the warning threshold and warning ON it', () => {
    const before = assessOfferFreshness(observation(), policy(), new Date(at(7_200).getTime() - 1));
    expect(before.level).toBe('current');
    expect(assessOfferFreshness(observation(), policy(), at(7_200)).level).toBe('warning');
  });

  it('is warning one millisecond BEFORE the expiry and expired ON it', () => {
    const before = assessOfferFreshness(observation(), policy(), new Date(at(21_600).getTime() - 1));
    expect(before.level).toBe('warning');
    expect(assessOfferFreshness(observation(), policy(), at(21_600)).level).toBe('expired');
  });

  it('runs the clock from the last CHECK, not from the last CHANGE', () => {
    // A feed that republishes the same price every hour: the terms last CHANGED
    // a month ago and the source confirmed the offer exists a minute ago.
    // Running the deadlines from `observedAt` would expire every stable price
    // in a catalogue, which is most of one.
    const stableButChecked = observation({
      observedAt: new Date('2026-07-09T00:00:00.000Z'),
      lastSeenAt: LAST_SEEN,
    });
    const assessment = assessOfferFreshness(stableButChecked, policy(), at(60));
    expect(assessment.level).toBe('current');
    // Both ages are reported, because a buyer wants the second and a merchant
    // debugging a feed wants the first.
    expect(assessment.ageSeconds).toBeGreaterThan(2_500_000);
    expect(assessment.checkedAgeSeconds).toBe(60);
  });

  it('a CONTRACTUAL cache cap can only shorten the lifetime, never lengthen it', () => {
    // 24 hours is an Amazon-style caching term; this source's own policy would
    // have given six. The cap is a `min`, so the shorter one wins in one
    // direction and cannot win in the other.
    const capped = policy({ cacheCapSeconds: 3_600 });
    expect(effectiveOfferLifetimeSeconds(capped)).toBe(3_600);
    const expired = assessOfferFreshness(observation(), capped, at(3_600));
    expect(expired.level).toBe('expired');
    if (expired.level !== 'expired') throw new Error('unreachable: narrowed above');
    expect(expired.reason).toBe('cache_cap_elapsed');

    const longCap = policy({ cacheCapSeconds: 999_999 });
    expect(effectiveOfferLifetimeSeconds(longCap)).toBe(21_600);
    expect(assessOfferFreshness(observation(), longCap, at(21_600)).level).toBe('expired');
  });

  it('REFUSES a policy that names a different source, however valid it is', () => {
    // The structural half of "there is no global TTL": a policy value names the
    // source whose row it came from, so one shared object cannot serve two.
    // The policy below is otherwise identical and perfectly usable — only its
    // `sourceId` differs, which is the one thing that must decide the answer.
    const foreign = policy({ sourceId: 'source-awin' });
    const assessment = assessOfferFreshness(observation(), foreign, at(60));
    expect(assessment.level).toBe('unknown');
    if (assessment.level !== 'unknown') throw new Error('unreachable: narrowed above');
    expect(assessment.reason).toBe('policy_source_mismatch');
    // And the unknown branch has no deadline to read, so nothing downstream can
    // compute a countdown for an offer whose contract could not be resolved.
    expect('expiry' in assessment).toBe(false);
  });

  it('falls back to the OFFER’s own deadline when the source has no contract', () => {
    // A bare provenance registry row — #60's backfill source, an operator's —
    // ingests nothing and has no policy to resolve, but the offers written
    // against it carry a `stale_at` somebody chose. Answering `unknown` would
    // withdraw every one of them from comparison on the deploy that adds #68.
    //
    // The fallback is PER OFFER: five minutes here, six hours in `policy()`.
    const current = assessOfferFreshness(observation(), null, at(60));
    expect(current.level).toBe('current');
    if (current.level !== 'current') throw new Error('unreachable: narrowed above');
    expect(current.basis).toBe('offer_deadline');
    expect(mayAppearInComparison(current)).toBe(true);

    const expired = assessOfferFreshness(observation(), null, at(300));
    expect(expired.level).toBe('expired');
  });

  it('answers unknown for an offer that names no source at all', () => {
    const assessment = assessOfferFreshness(observation({ sourceId: null }), null, at(0));
    expect(assessment.level).toBe('unknown');
    if (assessment.level !== 'unknown') throw new Error('unreachable: narrowed above');
    expect(assessment.reason).toBe('source_missing');
    expect(mayAppearInComparison(assessment)).toBe(false);
  });

  it('an EXPLICIT unavailability beats the clock, and carries no last-checked time', () => {
    // A source that says the object is gone has said something a TTL cannot
    // contradict. The branch deliberately withholds `lastCheckedAt`: #68 grants
    // that field to the WARNING state alone, because an offer that has left
    // comparison must not be rendered with a reassurance beside it.
    const declared = observation({ declaredUnavailableAt: at(30) });
    const assessment = assessOfferFreshness(declared, policy(), at(60));
    expect(assessment.level).toBe('unavailable');
    expect('lastCheckedAt' in assessment).toBe(false);
    expect(mayAppearInComparison(assessment)).toBe(false);
  });

  it('the WARNING branch is the only one that carries a last-checked time', () => {
    const warning = assessOfferFreshness(observation(), policy(), at(7_200));
    expect(warning.level).toBe('warning');
    if (warning.level !== 'warning') throw new Error('unreachable: narrowed above');
    expect(warning.lastCheckedAt).toBe(LAST_SEEN.toISOString());
    expect(warning.expiry.bounded).toBe(true);
    expect(mayAppearInComparison(warning)).toBe(true);
  });

  it('clamps a published warning threshold that a cache cap put past the expiry', () => {
    // A reviewer publishes "warn after 2h, expire after 6h" and the provider's
    // contract caps caching at one hour. Without the clamp the offer would be
    // expired while claiming to warn later, and `warnsAt > expiresAt` would be
    // a state no reader could make sense of.
    const capped = policy({ cacheCapSeconds: 1_800 });
    const current = assessOfferFreshness(observation(), capped, at(0));
    expect(current.level).toBe('current');
    if (current.level !== 'current') throw new Error('unreachable: narrowed above');
    if (!current.expiry.bounded) throw new Error('a source-backed offer is always bounded');
    expect(new Date(current.expiry.warnsAt).getTime()).toBeLessThanOrEqual(
      new Date(current.expiry.expiresAt).getTime(),
    );
  });
});

describe('nativeOfferFreshness — a listing has no source deadline', () => {
  it('is current and UNBOUNDED however old the convergence is', () => {
    const ancient = observation({
      sourceId: null,
      observedAt: new Date('2020-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const assessment = nativeOfferFreshness(ancient, at(0));
    expect(assessment.level).toBe('current');
    if (assessment.level !== 'current') throw new Error('unreachable: narrowed above');
    // `bounded: false` has no `expiresAt` property at all, so a sweep cannot
    // read a deadline off a native offer even by mistake — expiring one on the
    // converger's clock would delist a healthy catalogue during a dispatcher
    // outage, which is #68's own failure pointed at ourselves.
    expect(assessment.expiry.bounded).toBe(false);
    expect('expiresAt' in assessment.expiry).toBe(false);
  });
});

describe('offerRetirementDueAt — grace delays the RETIREMENT, never the display', () => {
  it('grants the outage grace for a FETCH failure and not for a parse one', () => {
    const plain = offerRetirementDueAt(observation(), policy(), 'full_feed_success');
    const outage = offerRetirementDueAt(observation(), policy(), 'source_outage');
    const drift = offerRetirementDueAt(observation(), policy(), 'schema_drift');
    expect(plain?.getTime()).toBe(at(21_600).getTime());
    expect(outage?.getTime()).toBe(at(28_800).getTime());
    // Mercaria read the feed perfectly well and did not like what was in it.
    // Granting grace there keeps serving prices the source has had every chance
    // to correct.
    expect(drift?.getTime()).toBe(at(21_600).getTime());
  });

  it('grants NO grace to a rights suspension, which is the exclusion that matters', () => {
    // A withdrawn right is a decision to STOP showing the data, so extending
    // its life is precisely what the grace must never do.
    expect(sourceHealthGrantsGrace('rights_suspended')).toBe(false);
    const suspended = offerRetirementDueAt(observation(), policy(), 'rights_suspended');
    expect(suspended?.getTime()).toBe(at(21_600).getTime());
  });

  it('an offer inside its grace is ALREADY out of comparison', () => {
    // The two instants are different on purpose: display stops at the deadline,
    // derived, with no sweep involved, and only the durable retirement waits.
    // So a transient outage costs the catalogue nothing AND presents nothing
    // old as fresh.
    const duringGrace = at(24_000);
    expect(assessOfferFreshness(observation(), policy(), duringGrace).level).toBe('expired');
    const dueAt = offerRetirementDueAt(observation(), policy(), 'source_outage');
    expect(dueAt !== null && duringGrace.getTime() < dueAt.getTime()).toBe(true);
  });

  it('has no answer for an offer whose policy names another source', () => {
    expect(offerRetirementDueAt(observation(), policy({ sourceId: 'other' }), 'unknown')).toBeNull();
    expect(offerRetirementDueAt(observation(), null, 'unknown')).toBeNull();
  });
});

describe('the refresh priority order', () => {
  it('ranks the tuple in its declared order and derives the rank from it', () => {
    expect(OFFER_REFRESH_PRIORITY_RANK.alerted).toBe(0);
    expect(OFFER_REFRESH_PRIORITY_RANK.scheduled).toBe(OFFER_REFRESH_PRIORITY_CLASSES.length - 1);
  });

  it('takes the WORST of several reasons, in either presentation order', () => {
    // An offer can be popular AND alerted; the queue orders on one number.
    // Order-independence is the property, since the reasons arrive from
    // different signals at different times.
    expect(highestRefreshPriority(['popular', 'alerted'])).toBe('alerted');
    expect(highestRefreshPriority(['alerted', 'popular'])).toBe('alerted');
    expect(highestRefreshPriority(['scheduled', 'comparison'])).toBe('comparison');
    expect(highestRefreshPriority([])).toBeUndefined();
  });
});

describe('chooseRefreshMode — capability first, and a policy can only narrow', () => {
  it('never schedules a snapshot for an adapter that cannot enumerate', () => {
    // An eBay-style Browse adapter: no call it has enumerates a marketplace, so
    // a snapshot it was scheduled for would either lie about completeness or
    // retire a catalogue on a search result.
    const mode = chooseRefreshMode({
      adapterModes: ['query_driven', 'targeted'],
      permittedModes: [],
      wantsSnapshot: true,
    });
    expect(mode).toBe('query_driven');
  });

  it('a policy listing a mode does NOT give the adapter the capability', () => {
    expect(
      chooseRefreshMode({
        adapterModes: ['incremental'],
        permittedModes: ['full_snapshot'],
        wantsSnapshot: true,
      }),
    ).toBeUndefined();
  });

  it('an EMPTY permitted list means unrestricted, not forbidden', () => {
    expect(
      chooseRefreshMode({
        adapterModes: ['full_snapshot'],
        permittedModes: [],
        wantsSnapshot: true,
      }),
    ).toBe('full_snapshot');
    expect(supportsTargetedRefresh({ adapterModes: ['targeted'], permittedModes: [] })).toBe(true);
    expect(
      supportsTargetedRefresh({ adapterModes: ['targeted'], permittedModes: ['incremental'] }),
    ).toBe(false);
  });
});

describe('summariseObservations — the distribution a page publishes', () => {
  it('takes the median WITHIN the dominant currency, not across all of them', () => {
    // A feed serving mostly EUR with a HUF tail has a stable EUR median and a
    // mixed-currency one that jumps whenever the mix moves — which would make
    // the scale detector fire on a change in the FEED's composition rather than
    // in its prices.
    const summary = summariseObservations({
      sampleSize: 6,
      prices: [
        { amount: 1_000, currency: 'EUR' },
        { amount: 1_200, currency: 'EUR' },
        { amount: 1_400, currency: 'EUR' },
        { amount: 1_600, currency: 'EUR' },
        { amount: 400_000, currency: 'HUF' },
        { amount: 500_000, currency: 'HUF' },
      ],
    });
    expect(summary.dominantCurrency).toBe('EUR');
    expect(summary.medianPriceMinor).toBe(1_200);
    expect(summary.dominantCurrencyShare).toBeCloseTo(4 / 6, 6);
  });

  it('counts a sample that carried no prices at all without inventing one', () => {
    const summary = summariseObservations({ sampleSize: 100, prices: [] });
    expect(summary.sampleSize).toBe(100);
    expect(summary.pricedCount).toBe(0);
    expect(summary.medianPriceMinor).toBeNull();
    expect(summary.dominantCurrency).toBeNull();
  });

  it('merges two pages by taking the median of the LARGER sample', () => {
    const left = summariseObservations({
      sampleSize: 2,
      prices: [{ amount: 100, currency: 'EUR' }],
    });
    const right = summariseObservations({
      sampleSize: 8,
      prices: [
        { amount: 900, currency: 'EUR' },
        { amount: 1_100, currency: 'EUR' },
      ],
    });
    const merged = mergeDistributions(left, right);
    expect(merged.sampleSize).toBe(10);
    expect(merged.pricedCount).toBe(3);
    expect(merged.medianPriceMinor).toBe(900);
  });
});

describe('detectSourceAnomalies — a sale is not a scale error', () => {
  const thresholds: SourceAnomalyThresholds = {
    minimumSampleSize: 50,
    zeroPriceShare: 0.5,
    priceScaleFactor: 10,
    disappearanceShare: 0.5,
  };

  function distribution(
    overrides: Partial<SourceObservationDistribution> = {},
  ): SourceObservationDistribution {
    return {
      sampleSize: 200,
      pricedCount: 200,
      zeroPricedCount: 0,
      medianPriceMinor: 1_999,
      dominantCurrency: 'EUR',
      dominantCurrencyShare: 1,
      ...overrides,
    };
  }

  it('does NOT fire on a legitimate half-price sale', () => {
    // The fixture that makes the threshold meaningful: a catalogue-wide sale
    // moves the median by 2x, which is well inside the factor. A detector that
    // quarantined this is one whoever hits it next switches off.
    const findings = detectSourceAnomalies({
      current: distribution({ medianPriceMinor: 999 }),
      prior: distribution(),
      thresholds,
      unseenPriorObjects: null,
      priorObjectCount: 200,
    });
    expect(findings).toEqual([]);
  });

  it('fires on a minor/major units error, which moves the median a HUNDREDFOLD', () => {
    const findings = detectSourceAnomalies({
      current: distribution({ medianPriceMinor: 19 }),
      prior: distribution(),
      thresholds,
      unseenPriorObjects: null,
      priorObjectCount: 200,
    });
    expect(findings.map((finding) => finding.kind)).toEqual(['price_scale_shift']);
    expect(findings[0]?.baseline).toBe(10);
  });

  it('fires on a currency change however plausible the numbers are', () => {
    // A price that changed DENOMINATION is not a price that changed — #62's
    // per-record rule, restated for a whole feed.
    const findings = detectSourceAnomalies({
      current: distribution({ dominantCurrency: 'USD' }),
      prior: distribution(),
      thresholds,
      unseenPriorObjects: null,
      priorObjectCount: 200,
    });
    expect(findings.map((finding) => finding.kind)).toEqual(['currency_change']);
  });

  it('fires on a feed that went to zero prices, with NO prior at all', () => {
    // The one detector that needs no baseline: "almost every price is zero" is
    // a statement about the run alone, so a first run can still trip it.
    const findings = detectSourceAnomalies({
      current: distribution({ zeroPricedCount: 150 }),
      prior: null,
      thresholds,
      unseenPriorObjects: null,
      priorObjectCount: 0,
    });
    expect(findings.map((finding) => finding.kind)).toEqual(['feed_wide_zero_price']);
  });

  it('fires on mass disappearance ONLY when the caller supplies an unseen count', () => {
    // `null` is what an incremental pass passes, and it is #68 acceptance 3 one
    // layer up: an incremental feed that did not mention nine tenths of the
    // catalogue has said nothing about them.
    const silent = detectSourceAnomalies({
      current: distribution(),
      prior: distribution(),
      thresholds,
      unseenPriorObjects: null,
      priorObjectCount: 200,
    });
    expect(silent).toEqual([]);

    const snapshot = detectSourceAnomalies({
      current: distribution(),
      prior: distribution(),
      thresholds,
      unseenPriorObjects: 180,
      priorObjectCount: 200,
    });
    expect(snapshot.map((finding) => finding.kind)).toEqual(['mass_disappearance']);
  });

  it('says nothing about the PRICES of a sample below the floor', () => {
    // The vacuity floor: a distribution over nine rows is not evidence about a
    // catalogue's prices, and firing on one is how a thin category page ends up
    // on the quarantine board.
    const findings = detectSourceAnomalies({
      current: distribution({ sampleSize: 9, pricedCount: 9, zeroPricedCount: 9, medianPriceMinor: 1 }),
      prior: distribution(),
      thresholds,
      unseenPriorObjects: null,
      priorObjectCount: 200,
    });
    expect(findings).toEqual([]);
  });

  it('still reports MASS DISAPPEARANCE from a page that returned nothing at all', () => {
    // The ordering that makes the floor safe. A pass which fails to mention
    // EVERYTHING is the one that returns zero records, so gating the
    // disappearance detector on the price-sample size would make the worst case
    // the one case it is silent about — silent in the direction that retires a
    // whole catalogue. Measured: an empty final page produced `sampleSize: 0`
    // and, before the reordering, no finding at all.
    const findings = detectSourceAnomalies({
      current: distribution({
        sampleSize: 0,
        pricedCount: 0,
        zeroPricedCount: 0,
        medianPriceMinor: null,
        dominantCurrency: null,
        dominantCurrencyShare: 0,
      }),
      prior: distribution(),
      thresholds,
      unseenPriorObjects: 200,
      priorObjectCount: 200,
    });
    expect(findings.map((finding) => finding.kind)).toEqual(['mass_disappearance']);
  });

  it('has a detector for every kind in the tuple', () => {
    // The enumeration floor: a kind added to the vocabulary with no detector
    // behind it would make the board claim a coverage it does not have.
    const seen = new Set<string>();
    for (const findings of [
      detectSourceAnomalies({
        current: distribution({ zeroPricedCount: 200 }),
        prior: distribution(),
        thresholds,
        unseenPriorObjects: null,
        priorObjectCount: 200,
      }),
      detectSourceAnomalies({
        current: distribution({ dominantCurrency: 'USD', medianPriceMinor: 1 }),
        prior: distribution(),
        thresholds,
        unseenPriorObjects: 200,
        priorObjectCount: 200,
      }),
    ]) {
      for (const finding of findings) seen.add(finding.kind);
    }
    expect([...seen].sort()).toEqual([...CATALOG_SOURCE_ANOMALY_KINDS].sort());
  });
});

describe('rollUpOfferAvailability — unknown survives (public behaviour 4)', () => {
  it('never answers in_stock from silence', () => {
    expect(rollUpOfferAvailability(['unknown', 'unknown'])).toBe('unknown');
  });

  it('a known value beside an unknown one wins, and the mix is the fixture that proves it', () => {
    expect(rollUpOfferAvailability(['unknown', 'in_stock'])).toBe('in_stock');
    expect(rollUpOfferAvailability(['unknown', 'out_of_stock'])).toBe('out_of_stock');
  });

  it('an EMPTY set is unknown, never out of stock (public behaviour 7)', () => {
    // "Every offer expired" is a statement about Mercaria's information, not
    // about the retailer's shelves.
    expect(rollUpOfferAvailability([])).toBe('unknown');
  });
});
