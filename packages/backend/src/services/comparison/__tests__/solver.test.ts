/**
 * The basket solver (#96 §"Solver design").
 *
 * Every case here is about arithmetic or about determinism, because those are
 * the two things the issue asks the solver to be and the two a language model
 * cannot be asked for.
 */

import { describe, expect, it } from 'vitest';
import {
  hasKnownPlanTotal,
  type BasketReasonCode,
  type BasketRequestLine,
} from '@mercaria/shared-types';
import {
  distinctionKeyOf,
  dominates,
  pruneBasketCandidates,
  renderCandidateTerms,
} from '../basket/candidates.js';
import { solveBasket } from '../basket/solver.js';
import { composeBasketPlan } from '../basket/plan.js';
import { resolveOfferTaxInclusion } from '../../ranking/seams.js';
import { candidate, EUR, eur, unknownMoney } from './fixtures.js';

function line(lineId: string, quantity = 1): BasketRequestLine {
  return { lineId, canonicalProductId: `prod-${lineId}`, quantity };
}

/** Solve with everything admitted and nothing pruned away. */
function solve(
  lines: readonly BasketRequestLine[],
  candidates: readonly ReturnType<typeof candidate>[],
  overrides: Partial<Parameters<typeof solveBasket>[0]> = {},
) {
  const pruned = pruneBasketCandidates({
    lines,
    candidates,
    channelPolicy: 'mixed',
    excludedMerchantIds: [],
  });
  return solveBasket({
    lines,
    candidates: pruned.candidates,
    objective: 'cheapest_known_item_prices',
    currency: EUR,
    refusals: pruned.refusals,
    candidatesTruncated: pruned.truncated,
    ...overrides,
  });
}

describe('per-merchant delivery couples the lines', () => {
  it('consolidating with ONE merchant beats three cheaper items from three', () => {
    // Three items: merchant A is 1 c dearer on each and charges one delivery;
    // B, C and D are each a cent cheaper and each charge their own. The naive
    // per-line minimum picks three merchants and pays three deliveries.
    const lines = [line('l1'), line('l2'), line('l3')];
    const candidates = [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(10001), delivery: eur(400) }),
      candidate({ lineId: 'l2', offerId: 'a2', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(10001), delivery: eur(400) }),
      candidate({ lineId: 'l3', offerId: 'a3', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(10001), delivery: eur(400) }),
      candidate({ lineId: 'l1', offerId: 'b1', merchantKey: 'B', merchantRef: 'B', unitItemPrice: eur(10000), delivery: eur(400) }),
      candidate({ lineId: 'l2', offerId: 'c1', merchantKey: 'C', merchantRef: 'C', unitItemPrice: eur(10000), delivery: eur(400) }),
      candidate({ lineId: 'l3', offerId: 'd1', merchantKey: 'D', merchantRef: 'D', unitItemPrice: eur(10000), delivery: eur(400) }),
    ];

    const cheapestTotal = solve(lines, candidates, { objective: 'cheapest_known_total' });
    expect(cheapestTotal.plan.merchantCount).toBe(1);
    expect(hasKnownPlanTotal(cheapestTotal.plan.deliveredTotal)).toBe(true);
    if (hasKnownPlanTotal(cheapestTotal.plan.deliveredTotal)) {
      // 3 × 100.01 + one 4.00 delivery.
      expect(cheapestTotal.plan.deliveredTotal.amount.amount).toBe(30003 + 400);
    }
    expect(cheapestTotal.optimality.status).toBe('proven_optimal');

    // …and the item-price objective legitimately picks the three, because that
    // is what it compares. Naming them differently is the whole point.
    const cheapestItems = solve(lines, candidates);
    expect(cheapestItems.plan.merchantCount).toBe(3);
  });
});

describe('a shipping threshold is applied to the MERCHANT subtotal', () => {
  it('reaching the threshold makes that merchant ship free', () => {
    const lines = [line('l1'), line('l2')];
    const candidates = [
      candidate({
        lineId: 'l1',
        offerId: 'a1',
        merchantKey: 'A',
        merchantRef: 'A',
        unitItemPrice: eur(3000),
        delivery: eur(500),
        deliveryFreeOver: eur(5000),
      }),
      candidate({
        lineId: 'l2',
        offerId: 'a2',
        merchantKey: 'A',
        merchantRef: 'A',
        unitItemPrice: eur(3000),
        delivery: eur(500),
        deliveryFreeOver: eur(5000),
      }),
    ];
    const outcome = solve(lines, candidates, { objective: 'cheapest_known_total' });
    expect(outcome.plan.merchants).toHaveLength(1);
    expect(outcome.plan.merchants[0].delivery).toEqual(eur(0));
    if (hasKnownPlanTotal(outcome.plan.deliveredTotal)) {
      expect(outcome.plan.deliveredTotal.amount.amount).toBe(6000);
    }
  });

  it('a threshold met only by ANOTHER merchant’s items does not apply', () => {
    const lines = [line('l1'), line('l2')];
    const candidates = [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(3000), delivery: eur(500), deliveryFreeOver: eur(5000) }),
      candidate({ lineId: 'l2', offerId: 'b1', merchantKey: 'B', merchantRef: 'B', unitItemPrice: eur(3000), delivery: eur(500) }),
    ];
    const plan = composeBasketPlan({
      assignments: [
        { line: lines[0], candidate: candidates[0] },
        { line: lines[1], candidate: candidates[1] },
      ],
      unresolved: [],
      currency: EUR,
    });
    // 30.00 with A is under A's own 50.00 threshold, whatever B's items cost.
    expect(plan.merchants.find((merchant) => merchant.merchantRef === 'A')?.delivery).toEqual(
      eur(500),
    );
  });

  it('two DISAGREEING shipping quotes from one merchant make its delivery unknown', () => {
    // Mercaria has observed two shipping policies from one seller and does not
    // know which applies to a combined order. Picking one would invent it.
    const lines = [line('l1'), line('l2')];
    const candidates = [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A', delivery: eur(400) }),
      candidate({ lineId: 'l2', offerId: 'a2', merchantKey: 'A', merchantRef: 'A', delivery: eur(900) }),
    ];
    const plan = composeBasketPlan({
      assignments: [
        { line: lines[0], candidate: candidates[0] },
        { line: lines[1], candidate: candidates[1] },
      ],
      unresolved: [],
      currency: EUR,
    });
    expect(plan.merchants[0].delivery.state).toBe('unknown');
    expect(hasKnownPlanTotal(plan.deliveredTotal)).toBe(false);
  });
});

describe('unknown costs never become a known total', () => {
  it('an unknown delivery leaves the delivered total unknown with the component named', () => {
    const lines = [line('l1')];
    const outcome = solve(lines, [
      candidate({ lineId: 'l1', offerId: 'a1', delivery: unknownMoney() }),
    ]);
    expect(hasKnownPlanTotal(outcome.plan.deliveredTotal)).toBe(false);
    if (!hasKnownPlanTotal(outcome.plan.deliveredTotal)) {
      expect(outcome.plan.deliveredTotal.missing).toContain('delivery_cost');
      // The known part is still reported, so a surface can say "at least …".
      expect(outcome.plan.deliveredTotal.knownFloor.amount).toBe(10000);
    }
  });

  it('an unknown TAX INCLUSION leaves the delivered total unknown too', () => {
    const lines = [line('l1')];
    const outcome = solve(lines, [
      candidate({ lineId: 'l1', offerId: 'a1', taxInclusion: 'unknown' }),
    ]);
    if (!hasKnownPlanTotal(outcome.plan.deliveredTotal)) {
      expect(outcome.plan.deliveredTotal.missing).toContain('tax_inclusion');
    } else {
      throw new Error('an unknown tax treatment produced a known delivered total');
    }
  });

  it('two merchants disagreeing about tax inclusion answer unknown, never one of them', () => {
    const lines = [line('l1'), line('l2')];
    const outcome = solve(lines, [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A', taxInclusion: 'inclusive' }),
      candidate({ lineId: 'l2', offerId: 'b1', merchantKey: 'B', merchantRef: 'B', taxInclusion: 'exclusive' }),
    ]);
    expect(outcome.plan.taxInclusion).toBe('unknown');
  });
});

describe('pruning never removes a distinct option', () => {
  it('a cheaper offer dominates a dearer one from the SAME merchant and condition', () => {
    const cheap = candidate({ lineId: 'l1', offerId: 'a1', unitItemPrice: eur(9000) });
    const dear = candidate({ lineId: 'l1', offerId: 'a2', unitItemPrice: eur(11000) });
    expect(dominates(cheap, dear)).toBe(true);
    const pruned = pruneBasketCandidates({
      lines: [line('l1')],
      candidates: [cheap, dear],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    expect(pruned.candidates.map((entry) => entry.offerId)).toEqual(['a1']);
  });

  it('a dearer REFURBISHED offer is not dominated by a cheaper NEW one', () => {
    const used = candidate({
      lineId: 'l1',
      offerId: 'a1',
      unitItemPrice: eur(11000),
      conditionGroup: 'refurbished',
    });
    const fresh = candidate({ lineId: 'l1', offerId: 'a2', unitItemPrice: eur(9000), conditionGroup: 'new' });
    expect(distinctionKeyOf(used)).not.toBe(distinctionKeyOf(fresh));
    expect(dominates(fresh, used)).toBe(false);
    const pruned = pruneBasketCandidates({
      lines: [line('l1')],
      candidates: [used, fresh],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    expect(pruned.candidates).toHaveLength(2);
  });

  it('an offer with an UNKNOWN delivery is a different bucket from one that quoted it', () => {
    const quoted = candidate({ lineId: 'l1', offerId: 'a1', unitItemPrice: eur(9000) });
    const silent = candidate({ lineId: 'l1', offerId: 'a2', unitItemPrice: eur(11000), delivery: unknownMoney() });
    expect(dominates(quoted, silent)).toBe(false);
    const pruned = pruneBasketCandidates({
      lines: [line('l1')],
      candidates: [quoted, silent],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    expect(pruned.candidates).toHaveLength(2);
  });

  it('an unquoted delivery WINDOW is incomparable in both directions', () => {
    const withWindow = candidate({ lineId: 'l1', offerId: 'a1', unitItemPrice: eur(9000), deliveryMaxDays: 2 });
    const without = candidate({ lineId: 'l1', offerId: 'a2', unitItemPrice: eur(11000) });
    expect(dominates(withWindow, without)).toBe(false);
    expect(dominates(without, withWindow)).toBe(false);
  });

  it('a DEARER offer never dominates a cheaper one, whatever its delivery', () => {
    // The axis-by-axis gate has to cover ITEM PRICE like every other axis.
    // Without it a marginally cheaper delivery buys a dominance the offer has
    // not earned: X at 100.00 + 0.10 delivery would delete Y at 50.00 + 0.11,
    // which is ordinary marketplace data and would corrupt every objective.
    const dear = candidate({
      lineId: 'l1',
      offerId: 'x',
      unitItemPrice: eur(10000),
      delivery: eur(10),
    });
    const cheap = candidate({
      lineId: 'l1',
      offerId: 'y',
      unitItemPrice: eur(5000),
      delivery: eur(11),
    });
    expect(dominates(dear, cheap)).toBe(false);
    // …and the cheaper one does not dominate either: it is worse on delivery,
    // so the pair is INCOMPARABLE and both must survive.
    expect(dominates(cheap, dear)).toBe(false);

    const pruned = pruneBasketCandidates({
      lines: [line('l1')],
      candidates: [dear, cheap],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    expect(pruned.candidates.map((entry) => entry.offerId).sort()).toEqual(['x', 'y']);
  });

  it('the solver then picks the cheaper delivered plan, not the pruned survivor', () => {
    // The consequence the gate protects: with both candidates alive the
    // delivered optimum is 50.11, not 100.10.
    const outcome = solve(
      [line('l1')],
      [
        candidate({ lineId: 'l1', offerId: 'x', unitItemPrice: eur(10000), delivery: eur(10) }),
        candidate({ lineId: 'l1', offerId: 'y', unitItemPrice: eur(5000), delivery: eur(11) }),
      ],
      { objective: 'cheapest_known_total' },
    );
    expect(hasKnownPlanTotal(outcome.plan.deliveredTotal)).toBe(true);
    if (hasKnownPlanTotal(outcome.plan.deliveredTotal)) {
      expect(outcome.plan.deliveredTotal.amount.amount).toBe(5011);
    }
  });

  it('a NATIVE offer is never dominated by an external one', () => {
    const native = candidate({
      lineId: 'l1',
      offerId: 'a1',
      unitItemPrice: eur(12000),
      merchantKey: 'native',
      channel: 'native_checkout',
      nativeCheckoutEligible: true,
    });
    const external = candidate({ lineId: 'l1', offerId: 'a2', unitItemPrice: eur(9000) });
    expect(dominates(external, native)).toBe(false);
  });
});

describe('the answer does not depend on the order candidates arrived in', () => {
  it('a shuffled candidate list produces the same plan digest', () => {
    const lines = [line('l1'), line('l2')];
    const candidates = [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A' }),
      candidate({ lineId: 'l1', offerId: 'b1', merchantKey: 'B', merchantRef: 'B' }),
      candidate({ lineId: 'l2', offerId: 'a2', merchantKey: 'A', merchantRef: 'A' }),
      candidate({ lineId: 'l2', offerId: 'b2', merchantKey: 'B', merchantRef: 'B' }),
    ];
    const forwards = solve(lines, candidates);
    const backwards = solve(lines, [...candidates].reverse());
    expect(backwards.plan.planDigest).toBe(forwards.plan.planDigest);
  });

  it('two offers identical on every axis are separated by the stable digest, not by position', () => {
    // Same merchant, same condition, same money: neither dominates, and the
    // tie-break decides. Reversing the input must not change which wins.
    const lines = [line('l1')];
    const first = candidate({ lineId: 'l1', offerId: 'zzz' });
    const second = candidate({ lineId: 'l1', offerId: 'aaa' });
    const forwards = solve(lines, [first, second]);
    const backwards = solve(lines, [second, first]);
    expect(forwards.plan.lines[0].offerRef).toBe(backwards.plan.lines[0].offerRef);
  });
});

describe('coverage, limits and honesty about them', () => {
  it('a line nothing can serve is unresolved, and the rest of the basket still solves', () => {
    const lines = [line('l1'), line('l2')];
    const outcome = solve(lines, [candidate({ lineId: 'l1', offerId: 'a1' })]);
    expect(outcome.plan.coveredLineIds).toEqual(['l1']);
    expect(outcome.plan.unresolved).toEqual([
      { lineId: 'l2', canonicalProductId: 'prod-l2', reasons: ['no_eligible_offer'] },
    ]);
  });

  it('a plan covering more lines beats a cheaper plan covering fewer', () => {
    const lines = [line('l1'), line('l2')];
    const outcome = solve(lines, [
      candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A', unitItemPrice: eur(100) }),
      candidate({ lineId: 'l2', offerId: 'b1', merchantKey: 'B', merchantRef: 'B', unitItemPrice: eur(90000) }),
    ]);
    expect(outcome.plan.coveredLineIds).toHaveLength(2);
  });

  it('a merchant ceiling refuses the line it cannot fit, by name', () => {
    const lines = [line('l1'), line('l2')];
    const outcome = solve(
      lines,
      [
        candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A' }),
        candidate({ lineId: 'l2', offerId: 'b1', merchantKey: 'B', merchantRef: 'B' }),
      ],
      { maxMerchants: 1 },
    );
    expect(outcome.plan.merchantCount).toBe(1);
    expect(outcome.plan.unresolved[0].reasons).toEqual(['merchant_limit_would_be_exceeded']);
  });

  it('the merchant ceiling BINDS on the greedy path too, and says what it cost', () => {
    // Past `MAX_SOLVER_MERCHANTS` the solver leaves the exact enumeration —
    // which enforces the cap by construction — for the greedy pass. A cap the
    // shopper SET is a hard constraint, so the greedy path must satisfy it and
    // report the shortfall, not return a twenty-merchant plan labelled
    // `approximate`. "Could not prove optimal" and "ignored your limit" are
    // different sentences and only one of them is true here.
    const lines = Array.from({ length: 20 }, (_, index) => line(`l${String(index)}`));
    const candidates = lines.map((entry, index) =>
      candidate({
        lineId: entry.lineId,
        offerId: `o${String(index)}`,
        merchantKey: `M${String(index).padStart(2, '0')}`,
        merchantRef: `M${String(index).padStart(2, '0')}`,
      }),
    );

    const outcome = solve(lines, candidates, { maxMerchants: 5 });

    expect(outcome.plan.merchantCount).toBeLessThanOrEqual(5);
    expect(outcome.plan.coveredLineIds).toHaveLength(5);
    expect(outcome.plan.unresolved).toHaveLength(15);
    for (const unresolved of outcome.plan.unresolved) {
      expect(unresolved.reasons).toEqual(['merchant_limit_would_be_exceeded']);
    }
    // Honest about the search, separately from being honest about the cap.
    expect(outcome.optimality.status).toBe('approximate');
  });

  it('the greedy pass keeps the merchant that covers the MOST lines', () => {
    // With a cap of one and a merchant able to serve three of four lines, the
    // enforcement must not simply take the first key it sorted.
    const lines = Array.from({ length: 16 }, (_, index) => line(`l${String(index)}`));
    const candidates = [
      // Sixteen single-line merchants keep the search on the greedy path…
      ...lines.map((entry, index) =>
        candidate({
          lineId: entry.lineId,
          offerId: `solo${String(index)}`,
          merchantKey: `Z${String(index).padStart(2, '0')}`,
          merchantRef: `Z${String(index).padStart(2, '0')}`,
        }),
      ),
      // …and one merchant, sorting LAST, serves three of them.
      ...['l0', 'l1', 'l2'].map((lineId) =>
        candidate({
          lineId,
          offerId: `wide-${lineId}`,
          merchantKey: 'ZZZ',
          merchantRef: 'ZZZ',
          unitItemPrice: eur(12000),
        }),
      ),
    ];

    const outcome = solve(lines, candidates, { maxMerchants: 1 });
    expect(outcome.plan.merchantCount).toBe(1);
    expect(outcome.plan.coveredLineIds).toEqual(['l0', 'l1', 'l2']);
  });

  it('an excluded merchant is refused by name and never quietly skipped', () => {
    const pruned = pruneBasketCandidates({
      lines: [line('l1')],
      candidates: [candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A' })],
      channelPolicy: 'mixed',
      excludedMerchantIds: ['A'],
    });
    expect(pruned.refusals.get('l1')).toEqual(['every_offer_from_excluded_merchant']);
  });

  it('a POSITIVE statement of insufficient stock refuses; silence does not', () => {
    const short = pruneBasketCandidates({
      lines: [line('l1', 3)],
      candidates: [candidate({ lineId: 'l1', offerId: 'a1', availableQuantity: 2 })],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    expect(short.refusals.get('l1')).toEqual(['quantity_exceeds_available_stock']);

    const silent = pruneBasketCandidates({
      lines: [line('l1', 3)],
      candidates: [candidate({ lineId: 'l1', offerId: 'a1' })],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    expect(silent.candidates).toHaveLength(1);
  });

  it('a time budget of zero reports `approximate` with the reason and a lower bound', () => {
    const lines = [line('l1'), line('l2')];
    const outcome = solve(
      lines,
      [
        candidate({ lineId: 'l1', offerId: 'a1', merchantKey: 'A', merchantRef: 'A' }),
        candidate({ lineId: 'l2', offerId: 'b1', merchantKey: 'B', merchantRef: 'B' }),
      ],
      { timeBudgetMs: -1 },
    );
    expect(outcome.optimality.status).toBe('approximate');
    if (outcome.optimality.status === 'approximate') {
      expect(outcome.optimality.reason).toBe('time_limit_reached');
    }
  });

  it('a truncated candidate set is `approximate` even when the search was exhaustive', () => {
    // An exact enumeration over a truncated candidate set is an exact answer to
    // the wrong question, and reporting it proven would be the most misleading
    // output this domain can produce.
    const lines = [line('l1')];
    const pruned = pruneBasketCandidates({
      lines,
      candidates: [candidate({ lineId: 'l1', offerId: 'a1' })],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    const outcome = solveBasket({
      lines,
      candidates: pruned.candidates,
      objective: 'cheapest_known_item_prices',
      currency: EUR,
      refusals: pruned.refusals,
      candidatesTruncated: true,
    });
    expect(outcome.optimality.status).toBe('approximate');
    if (outcome.optimality.status === 'approximate') {
      expect(outcome.optimality.reason).toBe('candidate_limit_reached');
    }
  });
});

describe('the exact search\u2019s decoupling premise', () => {
  it('holds ONLY because the tax-inclusion seam answers `unknown`', () => {
    // `solver.ts` proves its optimum by enumerating merchant subsets and taking
    // each line's best candidate independently. That decoupling is false in
    // general — `plan.ts` makes a merchant's delivery unknown when its assigned
    // offers disagree on cost or threshold, which couples the lines — and it is
    // unreachable today only because no plan ever has a KNOWN delivered total
    // to compare.
    //
    // When this assertion fails, the seam has been closed and the premise has
    // not: `exactSearch` will still explore one assignment per subset and still
    // report `proven_optimal`. Decide what it does about the coupling before
    // shipping the seam — do not simply update this expectation.
    expect(
      resolveOfferTaxInclusion(),
      'the tax-inclusion seam now answers something; see solver.ts \u00a7"The decoupling ' +
        'rests on ONE premise" before changing this',
    ).toBe('unknown');
  });

  it('and the comparator really does collapse to the item subtotal', () => {
    // The other half of the premise, measured rather than asserted: with tax
    // inclusion unknown, a plan's delivered total is unknown even when every
    // delivery cost is published.
    const outcome = solve(
      [line('l1')],
      [
        candidate({
          lineId: 'l1',
          offerId: 'a1',
          delivery: eur(500),
          taxInclusion: resolveOfferTaxInclusion(),
        }),
      ],
      { objective: 'cheapest_known_total' },
    );
    expect(hasKnownPlanTotal(outcome.plan.deliveredTotal)).toBe(false);
  });
});

describe('the terms fingerprint watches every figure a plan shows', () => {
  it('a DELIVERY-only change is a change; the item price alone would miss it', () => {
    // The plan's visible figure is "at least X, plus delivery from N
    // merchants". A merchant raising its delivery fee moves exactly that, and a
    // check that compared only the item price would answer `unchanged`.
    const before = candidate({ lineId: 'l1', offerId: 'a1', delivery: eur(500) });
    const after = candidate({ lineId: 'l1', offerId: 'a1', delivery: eur(900) });
    expect(renderCandidateTerms(after)).not.toBe(renderCandidateTerms(before));
    // …and the item price is genuinely identical, so nothing else caught it.
    expect(after.unitItemPrice).toEqual(before.unitItemPrice);
  });

  it('a THRESHOLD-only change is a change, though both amounts are unmoved', () => {
    // "Free over 50" becoming "free over 80" flips a plan's delivery from zero
    // to charged without either published amount changing.
    const before = candidate({ lineId: 'l1', offerId: 'a1', deliveryFreeOver: eur(5000) });
    const after = candidate({ lineId: 'l1', offerId: 'a1', deliveryFreeOver: eur(8000) });
    expect(renderCandidateTerms(after)).not.toBe(renderCandidateTerms(before));
    expect(after.unitItemPrice).toEqual(before.unitItemPrice);
    expect(after.delivery).toEqual(before.delivery);
  });

  it('a fact APPEARING or disappearing is a change, not a silent match', () => {
    const known = candidate({ lineId: 'l1', offerId: 'a1', delivery: eur(500) });
    const silent = candidate({ lineId: 'l1', offerId: 'a1', delivery: unknownMoney() });
    expect(renderCandidateTerms(silent)).not.toBe(renderCandidateTerms(known));
  });

  it('identical terms fingerprint identically', () => {
    // The floor: a renderer that answered a constant would pass every check
    // above by making everything differ from nothing.
    const left = candidate({ lineId: 'l1', offerId: 'a1' });
    const right = candidate({ lineId: 'l9', offerId: 'zzz' });
    expect(renderCandidateTerms(right)).toBe(renderCandidateTerms(left));
  });
});

describe('a caller-known refusal survives and still counts toward coverage', () => {
  it('an unplannable line is UNRESOLVED with the caller\u2019s reason, not dropped', () => {
    // #81's `ambiguous_after_split` is the case: planning the line would put the
    // wrong product in a basket, and dropping it would make a basket of two
    // silently plan one and report success.
    const lines = [line('l1'), line('l2')];
    const pruned = pruneBasketCandidates({
      lines,
      candidates: [candidate({ lineId: 'l1', offerId: 'a1' })],
      channelPolicy: 'mixed',
      excludedMerchantIds: [],
    });
    const refusals = new Map<string, readonly BasketReasonCode[]>(pruned.refusals);
    refusals.set('l2', ['watchlist_item_unresolved']);

    const outcome = solveBasket({
      lines,
      candidates: pruned.candidates,
      objective: 'cheapest_known_item_prices',
      currency: EUR,
      refusals,
      candidatesTruncated: false,
    });

    expect(outcome.plan.coveredLineIds).toEqual(['l1']);
    expect(outcome.plan.unresolved).toEqual([
      {
        lineId: 'l2',
        canonicalProductId: 'prod-l2',
        reasons: ['watchlist_item_unresolved'],
      },
    ]);
  });
});

describe('quantity is never split across offers', () => {
  it('one line is served by exactly one offer, whatever the quantity', () => {
    const lines = [line('l1', 5)];
    const outcome = solve(lines, [
      candidate({ lineId: 'l1', offerId: 'a1', unitItemPrice: eur(1000) }),
      candidate({ lineId: 'l1', offerId: 'b1', merchantKey: 'B', merchantRef: 'B', unitItemPrice: eur(900) }),
    ]);
    expect(outcome.plan.lines).toHaveLength(1);
    expect(outcome.plan.lines[0].quantity).toBe(5);
    // The line total is the unit price times the quantity, once.
    expect(outcome.plan.lines[0].lineItemPrice).toEqual(eur(4500));
  });
});
