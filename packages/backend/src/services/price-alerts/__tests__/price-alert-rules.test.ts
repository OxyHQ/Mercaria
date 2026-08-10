/**
 * The pure rules of #79 — the repeat policies, quiet hours, the trigger key and
 * the qualification.
 *
 * The FIXTURES are chosen to exercise the distinctions the rules exist to make,
 * which is the only form of this test that is worth having:
 *
 *  - a `known_total` alert against an offer whose delivery cost is UNKNOWN and
 *    one whose delivery cost is ZERO, because "nobody published it" and "it is
 *    free" are the two readings acceptance 2 keeps apart and a fixture with a
 *    real delivery cost distinguishes neither;
 *  - a `reset_threshold` alert that was re-armed BEFORE its last trigger and one
 *    re-armed AFTER, because a comparison written the wrong way round passes for
 *    both;
 *  - a `cooldown_better_low` case whose cooldown has elapsed and whose price is
 *    one minor unit better, because the "material" half of the rule is invisible
 *    to a fixture that improves by half;
 *  - a quiet window that WRAPS midnight, because the non-wrapping form passes
 *    under both the correct and the naive comparison;
 *  - a zero-decimal and an eight-decimal currency in the improvement floor,
 *    because a percentage that rounds to nothing is the case the floor exists
 *    for.
 */

import { describe, expect, it } from 'vitest';
import type { EligibleOffer, Offer, OfferRankingFacts } from '@mercaria/shared-types';
import {
  materialImprovementCeiling,
  priceAlertTriggerKey,
  quietHoursReleaseAt,
  repeatPolicySatisfied,
  withinQuietHours,
} from '@mercaria/shared-types';
import type { PriceAlertRow } from '../../../db/priceAlerts/priceAlertRepository.js';
import { qualifyAlert, type AlertCandidate } from '../qualification.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');

/** A minimal alert row. Every case names only the fields it is about. */
function alert(overrides: Partial<PriceAlertRow> = {}): PriceAlertRow {
  return {
    id: 'alert-1',
    oxyUserId: 'oxy-1',
    canonicalProductId: 'product-1',
    canonicalVariantId: null,
    targetAmount: 50_000,
    targetCurrency: 'EUR',
    basis: 'item_price',
    conditionGroups: [],
    market: null,
    sellerScope: 'any',
    proximityScope: 'any',
    merchantId: null,
    storefrontId: null,
    availabilityRequirement: 'any',
    minimumAvailableQuantity: null,
    requirePickupAvailable: false,
    state: 'enabled',
    repeatPolicy: 'once',
    resetThresholdAmount: null,
    cooldownSeconds: null,
    rearmedAt: null,
    quietHoursStartMinute: null,
    quietHoursEndMinute: null,
    quietHoursTimeZone: null,
    locale: null,
    emailOptIn: false,
    resolutionState: 'resolved',
    splitJobId: null,
    splitTargetCanonicalProductId: null,
    rehomedFromCanonicalProductId: null,
    rehomedAt: null,
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    lastDeliveredAt: null,
    lastTriggeredAmount: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PriceAlertRow;
}

function facts(overrides: Partial<OfferRankingFacts> = {}): OfferRankingFacts {
  return {
    itemPrice: {
      known: true,
      amount: { amount: 40_000, currency: 'EUR' },
      fx: { from: 'EUR', to: 'EUR', rate: 1, provider: 'static', asOf: NOW.toISOString() },
    },
    deliveryCost: { known: false, reason: 'not_published' },
    total: { known: false, missing: ['delivery_cost'] },
    taxInclusion: 'unknown',
    availability: 'unknown',
    nativeCheckoutEligible: false,
    ...overrides,
  } as OfferRankingFacts;
}

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-1',
    kind: 'external',
    status: 'active',
    canonicalVariantId: 'variant-1',
    sellerRole: 'unknown',
    price: { amount: 40_000, currency: 'EUR' },
    availability: 'unknown',
    condition: { key: 'new', group: 'new', mappingState: 'declared' },
    customerEligibility: 'unknown',
    delivery: { known: false, pickup: 'unknown' },
    provenance: {},
    freshness: { level: 'current' },
    qualitySignals: [],
    checkout: { eligible: false, reasons: ['not_native'] },
    ...overrides,
  } as Offer;
}

function candidate(input: {
  offer?: Partial<Offer>;
  facts?: Partial<OfferRankingFacts>;
  observedPriceVersion?: string | null;
}): AlertCandidate {
  const built = offer(input.offer ?? {});
  const admitted: EligibleOffer = {
    offerId: built.id,
    kind: built.kind,
    admission: { rulesEvaluated: [] },
    facts: facts(input.facts ?? {}),
  };
  return {
    offer: built,
    admitted,
    ...(input.observedPriceVersion === null
      ? {}
      : { observedPriceVersion: input.observedPriceVersion ?? 'snapshot-1' }),
  };
}

describe('the trigger key names four facts and no fifth', () => {
  it('is stable for one observation and differs on each of the four', () => {
    const base = {
      alertId: 'a',
      offerId: 'o',
      observedPriceVersion: 's',
      policyVersion: 'p',
    };
    expect(priceAlertTriggerKey(base)).toBe(priceAlertTriggerKey({ ...base }));
    expect(priceAlertTriggerKey({ ...base, alertId: 'a2' })).not.toBe(priceAlertTriggerKey(base));
    expect(priceAlertTriggerKey({ ...base, offerId: 'o2' })).not.toBe(priceAlertTriggerKey(base));
    expect(priceAlertTriggerKey({ ...base, observedPriceVersion: 's2' })).not.toBe(
      priceAlertTriggerKey(base),
    );
    expect(priceAlertTriggerKey({ ...base, policyVersion: 'p2' })).not.toBe(
      priceAlertTriggerKey(base),
    );
  });
});

describe('the repeat policies', () => {
  it('a never-triggered alert may always fire, whatever the policy', () => {
    for (const policy of ['once', 'always', 'reset_threshold', 'cooldown_better_low'] as const) {
      expect(
        repeatPolicySatisfied({ policy, candidateAmountMinor: 1, now: NOW }),
        `${policy} refused a first notification`,
      ).toBe(true);
    }
  });

  it('`once` never fires twice', () => {
    expect(
      repeatPolicySatisfied({
        policy: 'once',
        lastTriggeredAt: new Date(NOW.getTime() - 10_000),
        candidateAmountMinor: 1,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('`always` fires again — the explicit user selection', () => {
    expect(
      repeatPolicySatisfied({
        policy: 'always',
        lastTriggeredAt: new Date(NOW.getTime() - 10_000),
        candidateAmountMinor: 1,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('`reset_threshold` fires only when the re-arm is AFTER the last trigger', () => {
    const triggered = new Date(NOW.getTime() - 60_000);
    // Re-armed BEFORE the trigger: the price went up, came down, notified — and
    // has not been back above the threshold since. A comparison written the
    // wrong way round passes the case below and fails this one.
    expect(
      repeatPolicySatisfied({
        policy: 'reset_threshold',
        lastTriggeredAt: triggered,
        rearmedAt: new Date(triggered.getTime() - 60_000),
        candidateAmountMinor: 1,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      repeatPolicySatisfied({
        policy: 'reset_threshold',
        lastTriggeredAt: triggered,
        rearmedAt: new Date(triggered.getTime() + 1),
        candidateAmountMinor: 1,
        now: NOW,
      }),
    ).toBe(true);
    // Never re-armed at all.
    expect(
      repeatPolicySatisfied({
        policy: 'reset_threshold',
        lastTriggeredAt: triggered,
        candidateAmountMinor: 1,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('`cooldown_better_low` needs BOTH halves, and either alone is refused', () => {
    const triggered = new Date(NOW.getTime() - 3_600_000);
    const base = {
      policy: 'cooldown_better_low' as const,
      lastTriggeredAt: triggered,
      lastTriggeredAmountMinor: 10_000,
      now: NOW,
    };
    // Cooldown NOT elapsed, price much better.
    expect(
      repeatPolicySatisfied({ ...base, cooldownSeconds: 7_200, candidateAmountMinor: 5_000 }),
    ).toBe(false);
    // Cooldown elapsed, price only ONE minor unit better — below the material
    // floor, which is the half a fixture improving by 50% cannot see.
    expect(
      repeatPolicySatisfied({ ...base, cooldownSeconds: 60, candidateAmountMinor: 9_999 }),
    ).toBe(false);
    // Both halves.
    expect(
      repeatPolicySatisfied({ ...base, cooldownSeconds: 60, candidateAmountMinor: 9_900 }),
    ).toBe(true);
  });
});

describe('the material-improvement floor', () => {
  it('is one percent on an ordinary amount', () => {
    expect(materialImprovementCeiling(10_000)).toBe(9_900);
  });

  it('is at least ONE minor unit when a percentage would round to nothing', () => {
    // 1% of 50 is 0 after flooring. Without the floor the ceiling would be 50
    // itself and every re-observation of an unchanged price would be "better".
    expect(materialImprovementCeiling(50)).toBe(49);
    expect(materialImprovementCeiling(1)).toBe(0);
  });

  it('scales on an eight-decimal currency without losing the floor', () => {
    // 1 FAIR is 100_000_000 minor units; one percent is a million of them.
    expect(materialImprovementCeiling(100_000_000)).toBe(99_000_000);
  });
});

describe('quiet hours', () => {
  const window = { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'Europe/Madrid' };

  it('holds across midnight, which the non-wrapping form gets wrong', () => {
    // 23:30 Madrid is 21:30 UTC in August (CEST, UTC+2).
    expect(withinQuietHours(window, new Date('2026-08-10T21:30:00.000Z'))).toBe(true);
    // 03:00 Madrid — after midnight, still inside.
    expect(withinQuietHours(window, new Date('2026-08-11T01:00:00.000Z'))).toBe(true);
    // 12:00 Madrid — outside.
    expect(withinQuietHours(window, new Date('2026-08-10T10:00:00.000Z'))).toBe(false);
  });

  it('releases at the END of the window and never drops', () => {
    const at = new Date('2026-08-10T21:30:00.000Z');
    const release = quietHoursReleaseAt(window, at);
    expect(release.getTime()).toBeGreaterThan(at.getTime());
    expect(withinQuietHours(window, release)).toBe(false);
  });

  it('a zone the runtime cannot evaluate answers FALSE rather than withholding forever', () => {
    expect(
      withinQuietHours({ ...window, timeZone: 'Mars/Olympus_Mons' }, new Date()),
    ).toBe(false);
  });

  it('an empty window is not a window', () => {
    expect(withinQuietHours({ startMinute: 60, endMinute: 60, timeZone: 'UTC' }, NOW)).toBe(false);
  });
});

describe('qualifying an alert', () => {
  it('an item-price alert qualifies on the CHEAPEST in-scope offer', () => {
    const result = qualifyAlert({
      alert: alert(),
      candidates: [
        candidate({
          offer: { id: 'expensive', price: { amount: 49_000, currency: 'EUR' } },
          facts: {
            itemPrice: {
              known: true,
              amount: { amount: 49_000, currency: 'EUR' },
              fx: { from: 'EUR', to: 'EUR', rate: 1, provider: 'static', asOf: NOW.toISOString() },
            },
          },
        }),
        candidate({ offer: { id: 'cheap' } }),
      ],
    });
    expect(result.outcome).toBe('qualified');
    if (result.outcome !== 'qualified') return;
    expect(result.offerId).toBe('cheap');
    expect(result.amount).toEqual({ amount: 40_000, currency: 'EUR' });
    // Nothing was converted, so nothing is recorded as having been.
    expect(result.quotes).toEqual([]);
  });

  it('a known-total alert cannot be satisfied by an offer whose delivery is UNPUBLISHED', () => {
    const result = qualifyAlert({
      alert: alert({ basis: 'known_total' }),
      candidates: [candidate({})],
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') return;
    expect(result.reasons).toContain('delivery_cost_unknown');
  });

  it('…and IS satisfied by one whose delivery is published as ZERO', () => {
    // The fixture that distinguishes "free" from "nobody said". A test using a
    // non-zero delivery cost would pass under a `?? 0` coercion.
    const result = qualifyAlert({
      alert: alert({ basis: 'known_total' }),
      candidates: [
        candidate({
          offer: { delivery: { known: true, cost: { amount: 0, currency: 'EUR' }, pickup: 'unknown' } },
          facts: {
            deliveryCost: {
              known: true,
              amount: { amount: 0, currency: 'EUR' },
              fx: { from: 'EUR', to: 'EUR', rate: 1, provider: 'static', asOf: NOW.toISOString() },
            },
            total: { known: true, amount: { amount: 40_000, currency: 'EUR' } },
          },
        }),
      ],
    });
    expect(result.outcome).toBe('qualified');
    if (result.outcome !== 'qualified') return;
    expect(result.nativeDeliveryAmount).toBe(0);
  });

  it('a converted amount RETAINS the quote, and a same-currency one records none', () => {
    const converted = qualifyAlert({
      alert: alert(),
      candidates: [
        candidate({
          offer: { price: { amount: 34_000, currency: 'GBP' } },
          facts: {
            itemPrice: {
              known: true,
              amount: { amount: 40_000, currency: 'EUR' },
              fx: {
                from: 'GBP',
                to: 'EUR',
                rate: 1.176,
                provider: 'static',
                asOf: NOW.toISOString(),
              },
            },
          },
        }),
      ],
    });
    expect(converted.outcome).toBe('qualified');
    if (converted.outcome !== 'qualified') return;
    expect(converted.quotes).toEqual([
      {
        component: 'item_price',
        snapshot: { from: 'GBP', to: 'EUR', rate: 1.176, provider: 'static', asOf: NOW.toISOString() },
      },
    ]);
    expect(converted.nativeItemCurrency).toBe('GBP');
    expect(converted.nativeItemAmount).toBe(34_000);
  });

  it('a price above the target BLOCKS and still reports what it saw', () => {
    const result = qualifyAlert({
      alert: alert({ targetAmount: 30_000 }),
      candidates: [candidate({})],
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') return;
    expect(result.reasons).toEqual(['above_target']);
    // The re-arm reads this, so its absence would make `reset_threshold`
    // unreachable — see `applyReset`.
    expect(result.bestInScopeAmount).toEqual({ amount: 40_000, currency: 'EUR' });
  });

  it('a qualifying price with NO observation behind it blocks rather than triggering', () => {
    const result = qualifyAlert({
      alert: alert(),
      candidates: [candidate({ observedPriceVersion: null })],
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') return;
    expect(result.reasons).toEqual(['no_observed_price_version']);
  });

  it('an UNMAPPED condition never satisfies a segment-scoped alert', () => {
    // #90 records an unmapped source wording as no group at all. Reading that as
    // matching would tell a buyer watching `used` about an unclassified item.
    const result = qualifyAlert({
      alert: alert({ conditionGroups: ['used'] }),
      candidates: [
        candidate({ offer: { condition: { key: 'unknown', mappingState: 'unmapped' } } }),
      ],
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') return;
    expect(result.reasons).toEqual(['no_offer_in_scope']);
  });

  it('an UNKNOWN availability never satisfies an in-stock requirement', () => {
    const result = qualifyAlert({
      alert: alert({ availabilityRequirement: 'in_stock' }),
      candidates: [candidate({ offer: { availability: 'unknown' } })],
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') return;
    expect(result.reasons).toEqual(['no_offer_in_scope']);
  });

  it('an UNPUBLISHED quantity never satisfies a minimum', () => {
    const result = qualifyAlert({
      alert: alert({ minimumAvailableQuantity: 2 }),
      candidates: [candidate({})],
    });
    expect(result.outcome).toBe('blocked');
    // …and a published one that is large enough does.
    const enough = qualifyAlert({
      alert: alert({ minimumAvailableQuantity: 2 }),
      candidates: [candidate({ offer: { availableQuantity: 2 } })],
    });
    expect(enough.outcome).toBe('qualified');
  });

  it('`official_only` needs a VERIFIED relationship and not an absent one', () => {
    const absent = qualifyAlert({
      alert: alert({ sellerScope: 'official_only' }),
      candidates: [candidate({})],
    });
    expect(absent.outcome).toBe('blocked');
    const verified = qualifyAlert({
      alert: alert({ sellerScope: 'official_only' }),
      candidates: [candidate({ facts: { relationship: 'official_channel' } })],
    });
    expect(verified.outcome).toBe('qualified');
    // An AUTHORIZED reseller is a different relationship and does not satisfy it.
    const reseller = qualifyAlert({
      alert: alert({ sellerScope: 'official_only' }),
      candidates: [candidate({ facts: { relationship: 'authorized_reseller' } })],
    });
    expect(reseller.outcome).toBe('blocked');
  });

  it('a proximity-scoped alert is refused BY NAME — the #93 seam', () => {
    const result = qualifyAlert({
      alert: alert({ proximityScope: 'nearby_pickup' }),
      candidates: [candidate({})],
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') return;
    expect(result.reasons).toEqual(['proximity_scope_unsupported']);
  });

  it('no eligible offer at all is a different answer from none in scope', () => {
    const empty = qualifyAlert({ alert: alert(), candidates: [] });
    expect(empty.outcome).toBe('blocked');
    if (empty.outcome !== 'blocked') return;
    expect(empty.reasons).toEqual(['no_eligible_offer']);

    const outOfScope = qualifyAlert({
      alert: alert({ canonicalVariantId: 'other-variant' }),
      candidates: [candidate({})],
    });
    expect(outOfScope.outcome).toBe('blocked');
    if (outOfScope.outcome !== 'blocked') return;
    expect(outOfScope.reasons).toEqual(['no_offer_in_scope']);
  });

  it('the winner is deterministic when two offers tie', () => {
    // Ties break by offer id, so two evaluations of one unchanged set agree.
    // Array order is what actually varies between runs.
    const first = candidate({ offer: { id: 'aaa' } });
    const second = candidate({ offer: { id: 'bbb' } });
    const forwards = qualifyAlert({ alert: alert(), candidates: [first, second] });
    const backwards = qualifyAlert({ alert: alert(), candidates: [second, first] });
    expect(forwards.outcome).toBe('qualified');
    expect(backwards.outcome).toBe('qualified');
    if (forwards.outcome !== 'qualified' || backwards.outcome !== 'qualified') return;
    expect(forwards.offerId).toBe('aaa');
    expect(backwards.offerId).toBe('aaa');
  });

  it('states WHICH variant qualified — issue evaluation 7', () => {
    const result = qualifyAlert({
      alert: alert(),
      candidates: [candidate({ offer: { canonicalVariantId: 'variant-256gb' } })],
    });
    expect(result.outcome).toBe('qualified');
    if (result.outcome !== 'qualified') return;
    expect(result.canonicalVariantId).toBe('variant-256gb');
  });
});
