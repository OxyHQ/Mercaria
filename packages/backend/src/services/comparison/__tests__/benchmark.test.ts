/**
 * The benchmark scenarios (#96 §"Evaluation") — all twelve, by number.
 *
 * A GATE and not a fixture dump: every scenario asserts the property the issue
 * names it for, and each one is written so that the wrong answer — the
 * plausible, confident, silently-wrong one — turns the case red.
 *
 * What is measured, per the issue's own list:
 *
 *  - **constraint accuracy** — scenarios 1, 2 (the four states, and a hard
 *    constraint that is never relaxed).
 *  - **arithmetic accuracy** — scenarios 4, 5, 6 (exact minor units, thresholds,
 *    per-merchant delivery).
 *  - **grounding and citation validity** — scenario 12 (`explanation.test.ts`
 *    carries the per-rejection cases; this one drives the whole path).
 *  - **solver objective and completeness** — scenarios 6, 7, 8, 10.
 *  - **latency and approximation status** — scenario 11.
 *  - **fallback behaviour** — scenario 12's second half.
 *
 * Scenarios 3 and 9 are the two whose honest answer is a REFUSAL, and both are
 * asserted as refusals with their reason codes rather than skipped.
 */

import { describe, expect, it } from 'vitest';
import {
  hasKnownPlanTotal,
  type BasketRequest,
  type BasketRequestLine,
} from '@mercaria/shared-types';
import { composePlanActions } from '../basket/actions.js';
import { pruneBasketCandidates } from '../basket/candidates.js';
import { composeBasketResults, type SolvedObjective } from '../basket/results.js';
import { buildBasketSnapshot } from '../basket/snapshot.js';
import { solveBasket } from '../basket/solver.js';
import { buildExplanationPackage } from '../explanation/package.js';
import { validateExplanationDraft } from '../explanation/validation.js';
import { renderTemplateExplanation } from '../explanation/template.js';
import { MAX_SOLVER_MERCHANTS } from '../policy.js';
import { buildComparisonTable } from '../table.js';
import { buildConstraintColumn } from '../constraints.js';
import {
  candidate,
  commerce,
  declared,
  EUR,
  eur,
  fact,
  numberValue,
  subject,
  unknownMoney,
} from './fixtures.js';
import {
  COMPARISON_POLICY_VERSION,
  EXPLANATION_SCHEMA_VERSION,
  type ComparisonInput,
} from '@mercaria/shared-types';

function line(lineId: string, quantity = 1): BasketRequestLine {
  return { lineId, canonicalProductId: `prod-${lineId}`, quantity };
}

function basketRequest(
  lines: readonly BasketRequestLine[],
  overrides: Partial<BasketRequest> = {},
): BasketRequest {
  return {
    lines,
    comparisonCurrency: EUR,
    channelPolicy: 'mixed',
    objectives: ['cheapest_known_item_prices'],
    ...overrides,
  };
}

function solveAll(
  request: BasketRequest,
  candidates: readonly ReturnType<typeof candidate>[],
  timeBudgetMs?: number,
) {
  const pruned = pruneBasketCandidates({
    lines: request.lines,
    candidates,
    channelPolicy: request.channelPolicy,
    excludedMerchantIds: request.excludedMerchantIds ?? [],
    ...(request.conditionGroups === undefined
      ? {}
      : { conditionGroups: request.conditionGroups }),
  });
  const solved: SolvedObjective[] = [];
  for (const objective of [
    'cheapest_known_item_prices',
    'cheapest_known_total',
    'fewest_merchants',
    'all_native',
  ] as const) {
    const outcome = solveBasket({
      lines: request.lines,
      candidates: pruned.candidates,
      objective,
      currency: request.comparisonCurrency,
      refusals: pruned.refusals,
      candidatesTruncated: pruned.truncated,
      ...(request.maxMerchants === undefined ? {} : { maxMerchants: request.maxMerchants }),
      ...(timeBudgetMs === undefined ? {} : { timeBudgetMs }),
    });
    solved.push({ objective, plan: outcome.plan, optimality: outcome.optimality });
  }
  return {
    pruned,
    solved,
    results: composeBasketResults({
      request,
      solved,
      requestedLineCount: request.lines.length,
    }),
  };
}

function resultFor(results: ReturnType<typeof solveAll>['results'], kind: string) {
  const found = results.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no result named ${kind}`);
  return found;
}

/* ── 1. Product comparisons with missing and conflicting attributes ───────── */

describe('scenario 1 — missing and conflicting attributes', () => {
  it('keeps missing, conflicting, not-applicable and recorded facts apart in one table', () => {
    const table = buildComparisonTable([
      subject('p1', {
        declared: new Map([
          ['warranty_months', declared({ label: 'Warranty' })],
          ['battery_life_hours', declared({ label: 'Battery' })],
        ]),
        facts: new Map([
          ['warranty_months', fact({ key: 'warranty_months', value: numberValue(24) })],
          [
            'battery_life_hours',
            fact({
              key: 'battery_life_hours',
              state: 'conflicting',
              candidates: [numberValue(10, 'h'), numberValue(14, 'h')],
            }),
          ],
        ]),
      }),
      subject('p2', {
        // Declares warranty and NOT battery: one absence is unknown, the other
        // is not-applicable, and the table must not blend them.
        declared: new Map([['warranty_months', declared({ label: 'Warranty' })]]),
      }),
    ]);

    const warranty = table.rows.find((row) => row.key === 'warranty_months');
    const battery = table.rows.find((row) => row.key === 'battery_life_hours');
    expect(warranty?.cells.p1.state).toBe('source_backed');
    expect(warranty?.cells.p2).toEqual({ state: 'unknown', reason: 'not_recorded' });
    expect(battery?.cells.p1.state).toBe('conflicting');
    expect(battery?.cells.p2).toEqual({
      state: 'not_applicable',
      reason: 'attribute_out_of_category',
    });
  });
});

/* ── 2. Hard-constraint failures ──────────────────────────────────────────── */

describe('scenario 2 — hard-constraint failures are never relaxed', () => {
  it('a hard constraint #94 failed stays failed, and the verdict stays excluded', () => {
    // The reclassification this domain performs moves an UNKNOWN into
    // `not_applicable`. It must never touch a FAILURE, and it must never
    // recompute the verdict — that is acceptance 5 arriving through a display
    // concern, which is exactly how it would arrive.
    const column = buildConstraintColumn({
      subjectRef: 'p1',
      evaluation: {
        entityKind: 'product',
        entityId: 'prod-1',
        verdict: 'excluded',
        hardOutcomes: [
          {
            constraintId: 'battery',
            strength: 'hard',
            satisfaction: 'failed',
            explanation: 'At least 12 hours of battery',
            reason: 'no recorded value; policy excludes on unknown',
            sourceBacked: false,
          },
        ],
        preferenceOutcomes: [],
        preferenceScore: 1,
        evaluationVersion: 'ce-1',
        normalizationRuleVersion: 'nr-2',
      },
      constraints: [],
      constraintRefs: new Map([['battery', 'c1']]),
      // The attribute is NOT declared for this subject's category — the exact
      // condition that would tempt a reclassification.
      declaredAttributeKeys: new Set<string>(),
    });

    expect(column.verdict).toBe('excluded');
    expect(column.failed.map((entry) => entry.constraintId)).toEqual(['battery']);
    expect(column.notApplicable).toEqual([]);
  });

  it('an UNKNOWN outcome on an out-of-category attribute IS reclassified', () => {
    const column = buildConstraintColumn({
      subjectRef: 'p1',
      evaluation: {
        entityKind: 'product',
        entityId: 'prod-1',
        verdict: 'included',
        hardOutcomes: [],
        preferenceOutcomes: [
          {
            constraintId: 'battery',
            strength: 'preference',
            satisfaction: 'unknown',
            explanation: 'Prefer a long battery',
            reason: 'no recorded value',
            sourceBacked: false,
          },
        ],
        preferenceScore: 0,
        evaluationVersion: 'ce-1',
        normalizationRuleVersion: 'nr-2',
      },
      constraints: [
        {
          kind: 'attribute',
          id: 'battery',
          scope: 'product',
          explanation: 'Prefer a long battery',
          strength: 'preference',
          missingDataPolicy: 'admit_and_report_unknown',
          attributeKey: 'battery_life_hours',
          definitionVersion: 1,
          predicate: { op: 'exists' },
        },
      ],
      constraintRefs: new Map([['battery', 'c1']]),
      declaredAttributeKeys: new Set<string>(),
    });
    expect(column.notApplicable.map((entry) => entry.constraintId)).toEqual(['battery']);
    expect(column.unknown).toEqual([]);
  });
});

/* ── 3. Cross-currency offers ─────────────────────────────────────────────── */

describe('scenario 3 — cross-currency offers', () => {
  it('an unconvertible price REFUSES the line rather than comparing raw minor units', () => {
    const request = basketRequest([line('l1')]);
    const { pruned } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'a1', unitItemPrice: unknownMoney('not_convertible') }),
    ]);
    expect(pruned.candidates).toHaveLength(0);
    expect(pruned.refusals.get('l1')).toEqual(['no_convertible_price']);
  });

  it('a comparison names ONE currency and every plan line is in it', () => {
    const request = basketRequest([line('l1'), line('l2')]);
    const { results } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'a1' }),
      candidate({ lineId: 'l2', offerId: 'a2' }),
    ]);
    const cheapest = resultFor(results, 'cheapest_known_item_prices');
    if (cheapest.state !== 'produced') throw new Error('expected a plan');
    expect(cheapest.plan.currency).toBe('EUR');
    for (const planLine of cheapest.plan.lines) {
      if (planLine.unitItemPrice.state !== 'known') throw new Error('expected a known price');
      expect(planLine.unitItemPrice.amount.currency).toBe('EUR');
    }
  });
});

/* ── 4. Unknown shipping ──────────────────────────────────────────────────── */

describe('scenario 4 — unknown shipping', () => {
  it('prevents a cheapest-known-total claim and names the missing component', () => {
    const request = basketRequest([line('l1')]);
    const { results } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'a1', delivery: unknownMoney() }),
    ]);
    const total = resultFor(results, 'cheapest_known_total');
    expect(total.state).toBe('refused');
    if (total.state === 'refused') {
      expect(total.reasons).toContain('delivery_cost_unknown');
    }
    // …and the item-price plan is still produced, under a name that says
    // exactly what it compared.
    expect(resultFor(results, 'cheapest_known_item_prices').state).toBe('produced');
  });

  it('an UNKNOWN TAX treatment prevents it too, which is today’s production state', () => {
    // #74's `resolveOfferTaxInclusion` always answers `unknown`, so this is not
    // a hypothetical: `cheapest_known_total` is refused on every real basket
    // until an offer-side tax column lands.
    const request = basketRequest([line('l1')]);
    const { results } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'a1', taxInclusion: 'unknown' }),
    ]);
    const total = resultFor(results, 'cheapest_known_total');
    expect(total.state).toBe('refused');
    if (total.state === 'refused') expect(total.reasons).toContain('tax_inclusion_unknown');
  });
});

/* ── 5. Multi-merchant shipping thresholds ────────────────────────────────── */

describe('scenario 5 — multi-merchant shipping thresholds', () => {
  it('crossing a merchant’s threshold changes which plan is cheapest DELIVERED', () => {
    // A: 40.00 each, ships free over 70.00.  B: 38.00 each, always 6.00.
    // Items: A = 80.00, B = 76.00 → B wins on items.
    // Delivered: A = 80.00 + 0 = 80.00, B = 76.00 + 6.00 = 82.00 → A wins.
    const request = basketRequest([line('l1'), line('l2')]);
    const candidates = [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(4000), delivery: eur(600), deliveryFreeOver: eur(7000) }),
      candidate({ lineId: 'l2', offerId: 'a2', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(4000), delivery: eur(600), deliveryFreeOver: eur(7000) }),
      candidate({ lineId: 'l1', offerId: 'b1', merchantKey: 'B', merchantRef: 'B', unitItemPrice: eur(3800), delivery: eur(600) }),
      candidate({ lineId: 'l2', offerId: 'b2', merchantKey: 'B', merchantRef: 'B', unitItemPrice: eur(3800), delivery: eur(600) }),
    ];
    const { results } = solveAll(request, candidates);

    const items = resultFor(results, 'cheapest_known_item_prices');
    if (items.state !== 'produced') throw new Error('expected a plan');
    expect(items.plan.merchants[0].merchantRef).toBe('B');

    const total = resultFor(results, 'cheapest_known_total');
    if (total.state !== 'produced') throw new Error('expected a delivered plan');
    expect(total.plan.merchants[0].merchantRef).toBe('A');
    if (!hasKnownPlanTotal(total.plan.deliveredTotal)) throw new Error('expected a known total');
    expect(total.plan.deliveredTotal.amount.amount).toBe(8000);
  });
});

/* ── 6. Official versus cheapest ──────────────────────────────────────────── */

describe('scenario 6 — official versus cheapest', () => {
  it('names both, and the official plan is refused when any line is not official', () => {
    const request = basketRequest([line('l1'), line('l2')]);
    const { results } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(9000) }),
      candidate({ lineId: 'l1', offerId: 'o1', merchantKey: 'O', merchantRef: 'O', unitItemPrice: eur(11000), relationship: 'official_channel' }),
      candidate({ lineId: 'l2', offerId: 'a2', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(9000) }),
    ]);
    const cheapest = resultFor(results, 'cheapest_known_item_prices');
    if (cheapest.state !== 'produced') throw new Error('expected a plan');
    expect(cheapest.plan.lines.every((planLine) => planLine.relationship === undefined)).toBe(true);

    const official = resultFor(results, 'official_channel_plan');
    expect(official.state).toBe('refused');
    if (official.state === 'refused') {
      expect(official.reasons).toEqual(['objective_requires_official_channel']);
    }
  });

  it('an AUTHORIZED RESELLER is not an official channel', () => {
    // #55 keeps the two kinds, badges and lists apart, and folding them here
    // would publish a distinction the relationship layer refuses to make.
    const request = basketRequest([line('l1')]);
    const { results } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'r1', relationship: 'authorized_reseller' }),
    ]);
    expect(resultFor(results, 'official_channel_plan').state).toBe('refused');
  });
});

/* ── 7. Native and external mixed plans ───────────────────────────────────── */

describe('scenario 7 — mixed native and external plans', () => {
  it('produce SEPARATE actions and never one checkout', () => {
    const request = basketRequest([line('l1'), line('l2'), line('l3')]);
    const candidates = [
      candidate({
        lineId: 'l1',
        offerId: 'n1',
        merchantKey: 'native',
        merchantRef: undefined,
        merchantLabel: 'Mercaria',
        channel: 'native_checkout',
        nativeCheckoutEligible: true,
        productVariantId: 'var-1',
      }),
      candidate({ lineId: 'l2', offerId: 'e1', merchantKey: 'A', merchantRef: 'A', merchantLabel: 'Alpha Retail', destinationHost: 'alpha.example' }),
      candidate({ lineId: 'l3', offerId: 'e2', merchantKey: 'B', merchantRef: 'B', merchantLabel: 'Beta Retail', destinationHost: 'beta.example' }),
    ];
    const { pruned, results } = solveAll(request, candidates);
    const cheapest = resultFor(results, 'cheapest_known_item_prices');
    if (cheapest.state !== 'produced') throw new Error('expected a plan');

    const actions = composePlanActions(
      cheapest.plan,
      new Map(pruned.candidates.map((entry) => [entry.offerRef, entry])),
    );
    expect(actions.nativeCart?.lines).toEqual([
      { lineId: 'l1', productVariantId: 'var-1', quantity: 1 },
    ]);
    expect(actions.externalMerchants).toHaveLength(2);
    expect(actions.externalMerchants.map((entry) => entry.merchantLabel)).toEqual([
      'Alpha Retail',
      'Beta Retail',
    ]);
    // The external side hands over a HOST and never a URL.
    for (const external of actions.externalMerchants) {
      expect(external.destinationHost).not.toContain('http');
    }
    // There is no shape in which this is one transaction.
    expect(Object.keys(actions).sort()).toEqual(['externalMerchants', 'nativeCart']);
  });

  it('`best_native_plan` covers only the native lines and NAMES the rest as unresolved', () => {
    // Not a refusal: "you can buy one of these two here" is useful, and hiding
    // it would be worse than saying it. What must not happen is the plan
    // reading as complete — so the shortfall is in `unresolved` AND in the
    // reason codes, and `partial_coverage` names the same rows again.
    const request = basketRequest([line('l1'), line('l2')]);
    const { results } = solveAll(request, [
      candidate({
        lineId: 'l1',
        offerId: 'n1',
        merchantKey: 'native',
        channel: 'native_checkout',
        nativeCheckoutEligible: true,
        productVariantId: 'var-1',
      }),
      candidate({ lineId: 'l2', offerId: 'e1', merchantKey: 'A', merchantRef: 'A' }),
    ]);
    const native = resultFor(results, 'best_native_plan');
    if (native.state !== 'produced') throw new Error('expected a partial native plan');
    expect(native.plan.lines.map((entry) => entry.channel)).toEqual(['native_checkout']);
    expect(native.plan.unresolved.map((entry) => entry.lineId)).toEqual(['l2']);
    expect(native.reasons).toContain('objective_requires_native_offer');
  });

  it('`best_native_plan` IS refused when nothing at all is natively buyable', () => {
    const request = basketRequest([line('l1')]);
    const { results } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'e1', merchantKey: 'A', merchantRef: 'A' }),
    ]);
    const native = resultFor(results, 'best_native_plan');
    expect(native.state).toBe('refused');
    if (native.state === 'refused') {
      expect(native.reasons).toEqual(['objective_requires_native_offer']);
    }
  });
});

/* ── 8. Used and refurbished constraints ──────────────────────────────────── */

describe('scenario 8 — used and refurbished constraints', () => {
  it('a used-only line refuses a new offer and an UNKNOWN condition alike', () => {
    const request = basketRequest([
      { lineId: 'l1', canonicalProductId: 'prod-1', quantity: 1, conditionGroups: ['used'] },
    ]);
    const { pruned } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'a1', conditionGroup: 'new' }),
      candidate({ lineId: 'l1', offerId: 'a2' }),
    ]);
    expect(pruned.candidates).toHaveLength(0);
    expect(pruned.refusals.get('l1')).toEqual(['no_offer_in_requested_condition']);
  });

  it('a request-level condition filter is a DEFAULT, never an intersection', () => {
    // #95 produces ONE `conditionGroups` for a whole query, so a caller must be
    // able to state it once. A line that named its own keeps them exactly —
    // narrowing further would be a second filter the shopper cannot see.
    const request = basketRequest(
      [
        line('l1'),
        { lineId: 'l2', canonicalProductId: 'prod-l2', quantity: 1, conditionGroups: ['new'] },
      ],
      { conditionGroups: ['used'] },
    );
    const { pruned } = solveAll(request, [
      // l1 inherits `used`, so its NEW offer is refused…
      candidate({ lineId: 'l1', offerId: 'a1', conditionGroup: 'new' }),
      candidate({ lineId: 'l1', offerId: 'a2', conditionGroup: 'used' }),
      // …and l2 keeps its own `new`, which the basket-level `used` does not narrow.
      candidate({ lineId: 'l2', offerId: 'b1', conditionGroup: 'new' }),
    ]);
    expect(pruned.candidates.map((entry) => entry.offerId).sort()).toEqual(['a2', 'b1']);
  });

  it('the request-level filter enters the snapshot digest', () => {
    // It changes the answer, so a snapshot that ignored it would report two
    // different solves as the same input.
    const policy = {
      comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
      rankingPolicyVersion: 'test-policy-v1',
      constraintEvaluationVersion: 'ce-1',
      normalizationRuleVersion: 'nr-2',
    };
    const base = {
      policy,
      evaluatedAt: '2026-08-10T00:00:00.000Z',
      candidates: [candidate({ lineId: 'l1', offerId: 'a1' })],
      rates: [],
    };
    const unfiltered = buildBasketSnapshot({ ...base, request: basketRequest([line('l1')]) });
    const filtered = buildBasketSnapshot({
      ...base,
      request: basketRequest([line('l1')], { conditionGroups: ['used'] }),
    });
    expect(filtered.digest).not.toBe(unfiltered.digest);
  });

  it('a wholly second-hand plan earns the value result; one new line refuses it', () => {
    const secondHand = solveAll(basketRequest([line('l1')]), [
      candidate({ lineId: 'l1', offerId: 'a1', conditionGroup: 'used' }),
    ]);
    expect(resultFor(secondHand.results, 'used_or_refurbished_value').state).toBe('produced');

    const mixed = solveAll(basketRequest([line('l1'), line('l2')]), [
      candidate({ lineId: 'l1', offerId: 'a1', conditionGroup: 'used' }),
      candidate({ lineId: 'l2', offerId: 'a2', conditionGroup: 'new' }),
    ]);
    expect(resultFor(mixed.results, 'used_or_refurbished_value').state).toBe('refused');
  });
});

/* ── 9. Nearby pickup ─────────────────────────────────────────────────────── */

describe('scenario 9 — nearby pickup', () => {
  it('is ALWAYS refused, with or without a preference, and says why', () => {
    // #93 publishes no collection points; a plan claiming one would be the only
    // fabricated fact in the domain. It is refused whether or not the shopper
    // asked, so "we cannot do this" is distinguishable from "you did not ask".
    for (const request of [
      basketRequest([line('l1')]),
      basketRequest([line('l1')], { pickupPreference: { requested: true } }),
    ]) {
      const { results } = solveAll(request, [candidate({ lineId: 'l1', offerId: 'a1' })]);
      const pickup = resultFor(results, 'best_nearby_pickup');
      expect(pickup.state).toBe('refused');
      if (pickup.state === 'refused') {
        expect(pickup.reasons).toEqual(['pickup_data_unavailable']);
      }
    }
  });
});

/* ── 10. No feasible complete plan ────────────────────────────────────────── */

describe('scenario 10 — no complete feasible plan', () => {
  it('returns partial coverage honestly rather than the best two of three', () => {
    const request = basketRequest([line('l1'), line('l2'), line('l3')]);
    const { results } = solveAll(request, [
      candidate({ lineId: 'l1', offerId: 'a1' }),
      candidate({ lineId: 'l2', offerId: 'a2' }),
    ]);
    const partial = resultFor(results, 'partial_coverage');
    expect(partial.state).toBe('produced');
    if (partial.state !== 'produced') return;
    expect(partial.plan.coveredLineIds).toEqual(['l1', 'l2']);
    expect(partial.plan.unresolved.map((entry) => entry.lineId)).toEqual(['l3']);
    expect(partial.reasons).toEqual(['no_eligible_offer']);
  });

  it('a request nothing can serve produces refusals and no fabricated zero total', () => {
    const request = basketRequest([line('l1')]);
    const { results } = solveAll(request, []);
    const cheapest = resultFor(results, 'cheapest_known_item_prices');
    expect(cheapest.state).toBe('refused');
    const partial = resultFor(results, 'partial_coverage');
    if (partial.state !== 'produced') throw new Error('expected the partial result');
    expect(hasKnownPlanTotal(partial.plan.deliveredTotal)).toBe(false);
  });

  it('every named result kind is answered, produced or refused', () => {
    const { results } = solveAll(basketRequest([line('l1')]), [
      candidate({ lineId: 'l1', offerId: 'a1' }),
    ]);
    // A surface that only rendered what succeeded would make an absent pickup
    // plan indistinguishable from a pickup plan nobody asked for.
    for (const kind of [
      'cheapest_known_item_prices',
      'cheapest_known_total',
      'fewest_merchants',
      'best_native_plan',
      'official_channel_plan',
      'best_nearby_pickup',
      'used_or_refurbished_value',
    ]) {
      expect(results.some((entry) => entry.kind === kind), kind).toBe(true);
    }
  });
});

/* ── 11. High candidate counts and solver timeout ─────────────────────────── */

describe('scenario 11 — high candidate counts and the time limit', () => {
  it('an exhaustive search over the merchant cap is PROVEN optimal', () => {
    const lines = Array.from({ length: 6 }, (_, index) => line(`l${String(index)}`));
    const candidates = lines.flatMap((entry, lineIndex) =>
      Array.from({ length: MAX_SOLVER_MERCHANTS }, (_, merchantIndex) =>
        candidate({
          lineId: entry.lineId,
          offerId: `o-${String(lineIndex)}-${String(merchantIndex)}`,
          merchantKey: `M${String(merchantIndex).padStart(2, '0')}`,
          merchantRef: `M${String(merchantIndex).padStart(2, '0')}`,
          unitItemPrice: eur(10000 + merchantIndex * 10 + lineIndex),
          delivery: eur(500),
        }),
      ),
    );

    const started = Date.now();
    const { results } = solveAll(basketRequest(lines), candidates);
    const elapsed = Date.now() - started;

    const cheapest = resultFor(results, 'cheapest_known_item_prices');
    if (cheapest.state !== 'produced') throw new Error('expected a plan');
    expect(cheapest.optimality.status).toBe('proven_optimal');
    expect(cheapest.plan.coveredLineIds).toHaveLength(6);
    // The complexity boundary is documented as affordable; this is the number
    // behind that claim. Generous, because CI shares a runner.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('past the merchant cap it reports `approximate` and still returns a plan', () => {
    const lines = [line('l1'), line('l2')];
    const merchantCount = MAX_SOLVER_MERCHANTS + 2;
    const candidates = lines.flatMap((entry, lineIndex) =>
      Array.from({ length: merchantCount }, (_, merchantIndex) =>
        candidate({
          lineId: entry.lineId,
          offerId: `o-${String(lineIndex)}-${String(merchantIndex)}`,
          merchantKey: `M${String(merchantIndex).padStart(2, '0')}`,
          merchantRef: `M${String(merchantIndex).padStart(2, '0')}`,
          unitItemPrice: eur(10000 + merchantIndex),
        }),
      ),
    );
    // The cap BINDS on the greedy path: sixteen merchants are available and the
    // ceiling of one is SATISFIED, not merely reported. Here it costs no
    // coverage, because every merchant in this fixture can serve both lines —
    // `solver.test.ts` carries the case where the ceiling does cost coverage
    // and every dropped line says so.
    const { results } = solveAll(basketRequest(lines, { maxMerchants: 1 }), candidates);
    const cheapest = resultFor(results, 'cheapest_known_item_prices');
    if (cheapest.state !== 'produced') throw new Error('expected a plan');
    expect(cheapest.optimality.status).toBe('approximate');
    if (cheapest.optimality.status === 'approximate') {
      expect(cheapest.optimality.reason).toBe('merchant_limit_reached');
      expect(cheapest.optimality.lowerBound?.currency).toBe('EUR');
    }
    expect(cheapest.plan.merchantCount).toBe(1);
    expect(cheapest.plan.coveredLineIds).toHaveLength(2);
    expect(cheapest.plan.unresolved).toEqual([]);
  });

  it('an exhausted time budget reports it rather than claiming optimality', () => {
    const lines = [line('l1'), line('l2')];
    const { results } = solveAll(
      basketRequest(lines),
      [
        candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A' }),
        candidate({ lineId: 'l2', offerId: 'b1', merchantKey: 'B', merchantRef: 'B' }),
      ],
      -1,
    );
    const cheapest = resultFor(results, 'cheapest_known_item_prices');
    if (cheapest.state !== 'produced') {
      // A zero budget can legitimately produce nothing; the refusal is the
      // honest answer and is what the partial result then carries.
      expect(resultFor(results, 'partial_coverage').state).toBe('produced');
      return;
    }
    expect(cheapest.optimality.status).toBe('approximate');
  });
});

/* ── 12. Explanation attempts to introduce unsupported facts ──────────────── */

describe('scenario 12 — an explanation that tries to add a fact', () => {
  const input: ComparisonInput = {
    policy: {
      comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
      rankingPolicyVersion: 'test-policy-v1',
      constraintEvaluationVersion: 'ce-1',
      normalizationRuleVersion: 'nr-2',
    },
    evaluatedAt: '2026-08-10T00:00:00.000Z',
    comparisonCurrency: 'EUR',
    conditionGroups: [],
    subjects: [
      {
        ref: 'p1',
        name: 'Alpha',
        acquisition: {
          state: 'purchasable',
          channels: ['external_merchant'],
          leadOfferRef: 'o1',
          eligibleOfferCount: 1,
        },
        offerRefs: ['o1'],
      },
      {
        ref: 'p2',
        name: 'Beta',
        acquisition: {
          state: 'purchasable',
          channels: ['external_merchant'],
          leadOfferRef: 'o2',
          eligibleOfferCount: 1,
        },
        offerRefs: ['o2'],
      },
    ],
    offers: [],
    relationships: [],
    priceSignals: [],
    gaps: [],
    table: buildComparisonTable([
      subject('p1', { commerce: commerce({ lowestItemPrice: eur(29900) }) }),
      subject('p2', { commerce: commerce({ lowestItemPrice: eur(34900) }) }),
    ]),
    rates: [],
    records: [],
  };

  it('rejects an invented figure, a fabricated citation and a forbidden topic', () => {
    const pkg = buildExplanationPackage(input);
    const result = validateExplanationDraft(pkg, {
      schemaVersion: EXPLANATION_SCHEMA_VERSION,
      summary: [
        { text: 'Alpha saves you 50.00 EUR.', citedRefs: ['p1'] },
        { text: 'Beta is preferred by 8 out of 10 buyers.', citedRefs: ['p9'] },
        { text: 'Alpha pays a higher commission.', citedRefs: ['p1'] },
      ],
      points: [],
      constraintEchoes: [],
    });
    expect(result.state).toBe('rejected');
    if (result.state !== 'rejected') return;
    const reasons = new Set(result.rejections.map((entry) => entry.reason));
    expect(reasons).toContain('introduced_number');
    expect(reasons).toContain('unknown_record_reference');
    expect(reasons).toContain('forbidden_topic');
  });

  it('the deterministic table and its templated narrative still render', () => {
    // Acceptance 7: the comparison does not depend on the narrative, and the
    // narrative has a grounded fallback that would itself pass validation.
    const pkg = buildExplanationPackage(input);
    const explanation = renderTemplateExplanation(pkg, [
      { reason: 'introduced_number', detail: '50.00' },
    ]);
    if (explanation.state !== 'template') throw new Error('expected the template branch');
    expect(explanation.summary.length).toBeGreaterThan(0);
    expect(explanation.rejections).toHaveLength(1);
    expect(
      validateExplanationDraft(pkg, {
        schemaVersion: EXPLANATION_SCHEMA_VERSION,
        summary: explanation.summary,
        points: explanation.points,
        constraintEchoes: [],
      }).state,
    ).toBe('accepted');
    // The table beneath it is unaffected.
    expect(input.table.rows.length).toBeGreaterThan(0);
  });
});

/* ── The reproducible snapshot, which every scenario above rests on ───────── */

describe('one reproducible input snapshot per result', () => {
  it('two solves over the same input produce the same digest', () => {
    const request = basketRequest([line('l1')]);
    const candidates = [candidate({ lineId: 'l1', offerId: 'a1' })];
    const policy = {
      comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
      rankingPolicyVersion: 'test-policy-v1',
      constraintEvaluationVersion: 'ce-1',
      normalizationRuleVersion: 'nr-2',
    };
    const first = buildBasketSnapshot({
      policy,
      evaluatedAt: '2026-08-10T00:00:00.000Z',
      request,
      candidates,
      rates: [],
    });
    const second = buildBasketSnapshot({
      policy,
      // A LATER clock over an unchanged catalogue is the same input; folding
      // the clock into the digest would make the whole mechanism decorative.
      evaluatedAt: '2026-08-10T00:05:00.000Z',
      request,
      candidates,
      rates: [],
    });
    expect(second.digest).toBe(first.digest);
  });

  it('a changed price changes the digest', () => {
    const request = basketRequest([line('l1')]);
    const policy = {
      comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
      rankingPolicyVersion: 'test-policy-v1',
      constraintEvaluationVersion: 'ce-1',
      normalizationRuleVersion: 'nr-2',
    };
    const before = buildBasketSnapshot({
      policy,
      evaluatedAt: '2026-08-10T00:00:00.000Z',
      request,
      candidates: [candidate({ lineId: 'l1', offerId: 'a1', unitItemPrice: eur(10000) })],
      rates: [],
    });
    const after = buildBasketSnapshot({
      policy,
      evaluatedAt: '2026-08-10T00:00:00.000Z',
      request,
      candidates: [candidate({ lineId: 'l1', offerId: 'a1', unitItemPrice: eur(9000) })],
      rates: [],
    });
    expect(after.digest).not.toBe(before.digest);
  });
});
