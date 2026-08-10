/**
 * The pure half of #127: deadlines, eligibility and refund allocation.
 *
 * All three are total functions over plain values with the clock passed in, so
 * every case here runs with no database and no mock. That is the point of
 * pushing the decisions into pure modules — the alternative is asserting a
 * consumer-rights rule through six services and a Postgres container.
 *
 * The fixtures deliberately exercise the DISTINCTIONS the checks exist to make
 * (`~/Oxy/AGENTS.md` (E)): the statutory/commercial precedence is driven with a
 * pair on each side of the comparison, the delivery anchor is driven both with
 * and without a delivery instant, and the refund allocation is driven with a
 * partial line so the proration path is reached rather than only the whole-line
 * one.
 */

import { describe, expect, it } from 'vitest';
import { resolveEffectiveServiceDeadline } from '@mercaria/shared-types';
import {
  composeRetailRefundAllocation,
  RETAIL_DELIVERY_REFUNDING_KINDS,
} from '../retail-service-requests/allocation.js';
import {
  decidingPolicyBasis,
  deriveRetailServiceDeadlines,
  retailPossessionAnchor,
  RETAIL_UNKNOWN_DELIVERY_GRACE_DAYS,
  type RetailOrderClock,
  type RetailTermsSnapshot,
} from '../retail-service-requests/policy.js';
import {
  deriveRetailServiceEligibility,
  retailOutcomeIsDeliverable,
  type RetailServiceEligibilityInput,
} from '../retail-service-requests/eligibility.js';

const TERMS: RetailTermsSnapshot = {
  customerTermsVersion: '2026-08-10.1',
  cancellationWindowHours: 24,
  withdrawalWindowDays: 14,
  returnWindowDays: 30,
  warrantyMonths: 36,
};

const PLACED = new Date('2026-06-01T00:00:00.000Z');
const DELIVERED = new Date('2026-06-05T00:00:00.000Z');

function clock(overrides: Partial<RetailOrderClock> = {}): RetailOrderClock {
  return { placedAt: PLACED, dispatchedAt: null, deliveredAt: null, ...overrides };
}

function eligibilityInput(
  overrides: Partial<RetailServiceEligibilityInput> = {},
): RetailServiceEligibilityInput {
  return {
    kind: 'withdrawal_return',
    commercialRole: 'mercaria_retail',
    paymentStatus: 'paid',
    dispatched: true,
    delivered: true,
    deadlines: { statutoryAt: null, commercialAt: null },
    openRequestOfKind: false,
    unresolvedUnitsAvailable: true,
    categoryExcluded: false,
    hasEvidence: false,
    now: new Date('2026-06-10T00:00:00.000Z'),
    ...overrides,
  };
}

describe('the statutory floor can only move a deadline outwards', () => {
  it('takes the LATER of the two, whichever side it is on', () => {
    const earlier = new Date('2026-06-10T00:00:00.000Z');
    const later = new Date('2026-06-20T00:00:00.000Z');
    // Both orders of the pair, because a `Math.max` written the wrong way round
    // passes one of them and is the exact bug this function exists to prevent.
    expect(resolveEffectiveServiceDeadline(earlier, later)).toBe(later);
    expect(resolveEffectiveServiceDeadline(later, earlier)).toBe(later);
  });

  it('an absent side leaves the other standing', () => {
    const at = new Date('2026-06-10T00:00:00.000Z');
    expect(resolveEffectiveServiceDeadline(at, null)).toBe(at);
    expect(resolveEffectiveServiceDeadline(null, at)).toBe(at);
    expect(resolveEffectiveServiceDeadline(null, null)).toBeNull();
  });

  it('over randomized pairs it NEVER returns something earlier than either', () => {
    // The property #127 policy rule 3 actually asks for: a commercial policy may
    // extend a statutory right and may never shorten it. Asserting it over a
    // range rather than over two hand-picked dates is what makes "there is no
    // input pair for which this shortens a buyer's rights" a measured claim.
    for (let i = 0; i < 500; i += 1) {
      const a = new Date(PLACED.getTime() + Math.floor(Math.random() * 1e10));
      const b = new Date(PLACED.getTime() + Math.floor(Math.random() * 1e10));
      const resolved = resolveEffectiveServiceDeadline(a, b);
      expect(resolved).not.toBeNull();
      expect(resolved?.getTime()).toBeGreaterThanOrEqual(Math.max(a.getTime(), b.getTime()));
    }
  });

  it('names which basis decided, so a buyer can be told why', () => {
    const statutory = new Date('2026-06-19T00:00:00.000Z');
    const commercial = new Date('2026-07-05T00:00:00.000Z');
    expect(decidingPolicyBasis({ statutoryAt: statutory, commercialAt: commercial })).toBe(
      'commercial',
    );
    expect(decidingPolicyBasis({ statutoryAt: commercial, commercialAt: statutory })).toBe(
      'statutory',
    );
    expect(decidingPolicyBasis({ statutoryAt: null, commercialAt: null })).toBeNull();
  });
});

describe('deadlines are anchored on possession, and ignorance favours the buyer', () => {
  it('a delivered order anchors on the delivery instant', () => {
    const anchor = retailPossessionAnchor(clock({ dispatchedAt: PLACED, deliveredAt: DELIVERED }));
    expect(anchor).toEqual({ at: DELIVERED, delivered: true });

    const deadlines = deriveRetailServiceDeadlines({
      kind: 'withdrawal_return',
      terms: TERMS,
      clock: clock({ dispatchedAt: PLACED, deliveredAt: DELIVERED }),
    });
    // 14 statutory days and 30 commercial ones, both from DELIVERY.
    expect(deadlines.statutoryAt?.toISOString()).toBe('2026-06-19T00:00:00.000Z');
    expect(deadlines.commercialAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');
  });

  it('a DISPATCHED-only order gets the grace, which is strictly more time', () => {
    // The fixture that exercises the distinction: with no delivery instant the
    // anchor is dispatch, which starts the clock EARLIER than the law does — so
    // the grace exists and the test compares the two anchors rather than
    // asserting one number.
    const withDelivery = deriveRetailServiceDeadlines({
      kind: 'withdrawal_return',
      terms: TERMS,
      clock: clock({ dispatchedAt: PLACED, deliveredAt: PLACED }),
    });
    const withoutDelivery = deriveRetailServiceDeadlines({
      kind: 'withdrawal_return',
      terms: TERMS,
      clock: clock({ dispatchedAt: PLACED }),
    });
    expect(retailPossessionAnchor(clock({ dispatchedAt: PLACED }))).toEqual({
      at: PLACED,
      delivered: false,
    });
    const graceMs = RETAIL_UNKNOWN_DELIVERY_GRACE_DAYS * 24 * 60 * 60 * 1000;
    expect(
      (withoutDelivery.statutoryAt?.getTime() ?? 0) - (withDelivery.statutoryAt?.getTime() ?? 0),
    ).toBe(graceMs);
  });

  it('a cancellation runs from the PURCHASE and has no statutory side', () => {
    const deadlines = deriveRetailServiceDeadlines({
      kind: 'pre_dispatch_cancellation',
      terms: TERMS,
      clock: clock(),
    });
    expect(deadlines.statutoryAt).toBeNull();
    expect(deadlines.commercialAt?.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  it('a warranty period is CALENDAR-correct, not 30 days a month', () => {
    // Three years of 30-day months loses five days, and the direction it loses
    // them in takes a right away.
    const deadlines = deriveRetailServiceDeadlines({
      kind: 'warranty_claim',
      terms: TERMS,
      clock: clock({ dispatchedAt: PLACED, deliveredAt: new Date('2026-01-31T00:00:00.000Z') }),
    });
    expect(deadlines.statutoryAt?.toISOString()).toBe('2029-01-31T00:00:00.000Z');
  });

  it('a kind with NO window has neither deadline, so a recall never expires', () => {
    for (const kind of ['safety_recall', 'delivery_failure', 'wrong_item'] as const) {
      const deadlines = deriveRetailServiceDeadlines({
        kind,
        terms: TERMS,
        clock: clock({ dispatchedAt: PLACED, deliveredAt: DELIVERED }),
      });
      if (kind === 'wrong_item') {
        // `wrong_item` IS bounded — it is a return-window kind. Asserting the
        // contrast here is what stops "no window" being read as "no kind has
        // one".
        expect(deadlines.commercialAt).not.toBeNull();
        continue;
      }
      expect(deadlines.statutoryAt).toBeNull();
      expect(deadlines.commercialAt).toBeNull();
    }
  });

  it('an undispatched order has no goods-based deadline at all', () => {
    const deadlines = deriveRetailServiceDeadlines({
      kind: 'withdrawal_return',
      terms: TERMS,
      clock: clock(),
    });
    expect(deadlines.statutoryAt).toBeNull();
    expect(deadlines.commercialAt).toBeNull();
  });
});

describe('eligibility is three-valued and every refusal names a next action', () => {
  it('a marketplace order is refused FIRST, before any window arithmetic', () => {
    const verdict = deriveRetailServiceEligibility(
      eligibilityInput({ commercialRole: 'connected_marketplace' }),
    );
    expect(verdict).toEqual({ verdict: 'ineligible', reason: 'not_a_retail_order' });
  });

  it('a kind a buyer may not raise is refused by name', () => {
    for (const kind of ['safety_recall', 'return_to_sender', 'chargeback_coordination'] as const) {
      expect(deriveRetailServiceEligibility(eligibilityInput({ kind }))).toEqual({
        verdict: 'ineligible',
        reason: 'not_customer_submittable',
      });
    }
  });

  it('a dispatched order refuses a CANCELLATION and the reason offers a return', () => {
    const verdict = deriveRetailServiceEligibility(
      eligibilityInput({ kind: 'pre_dispatch_cancellation', dispatched: true }),
    );
    expect(verdict).toEqual({ verdict: 'ineligible', reason: 'already_dispatched' });
  });

  it('an undelivered order says WAIT, never TOO LATE', () => {
    // The two are opposite facts and collapsing them tells a buyer waiting for
    // a parcel that their return window expired.
    const verdict = deriveRetailServiceEligibility(
      eligibilityInput({ dispatched: false, delivered: false }),
    );
    expect(verdict).toEqual({ verdict: 'ineligible', reason: 'not_yet_delivered' });
  });

  it('a closed window is refused WITH the deadline that passed', () => {
    const deadline = new Date('2026-06-09T00:00:00.000Z');
    const verdict = deriveRetailServiceEligibility(
      eligibilityInput({ deadlines: { statutoryAt: deadline, commercialAt: null } }),
    );
    expect(verdict).toEqual({ verdict: 'ineligible', reason: 'window_closed', deadlineAt: deadline });
  });

  it('the COMMERCIAL side keeps a request alive after the statutory one closes', () => {
    // The pair that makes the precedence load-bearing: the statutory deadline
    // has passed and the commercial one has not. A `min` would refuse this.
    const verdict = deriveRetailServiceEligibility(
      eligibilityInput({
        deadlines: {
          statutoryAt: new Date('2026-06-09T00:00:00.000Z'),
          commercialAt: new Date('2026-06-25T00:00:00.000Z'),
        },
      }),
    );
    expect(verdict.verdict).toBe('eligible');
  });

  it('evidence is asked for LAST, and never for an ordinary withdrawal', () => {
    // #127 policy rule 6. `withdrawal_return` requires none; `damaged_on_arrival`
    // does — the two fixtures are what distinguish "we always ask" from "we ask
    // where it matters".
    expect(deriveRetailServiceEligibility(eligibilityInput()).verdict).toBe('eligible');
    expect(
      deriveRetailServiceEligibility(eligibilityInput({ kind: 'damaged_on_arrival' })).verdict,
    ).toBe('evidence_needed');
    expect(
      deriveRetailServiceEligibility(
        eligibilityInput({ kind: 'damaged_on_arrival', hasEvidence: true }),
      ).verdict,
    ).toBe('eligible');
    // And a buyer past their window is never asked for a photograph of goods
    // they are going to be refused anyway.
    expect(
      deriveRetailServiceEligibility(
        eligibilityInput({
          kind: 'damaged_on_arrival',
          deadlines: { statutoryAt: new Date('2026-06-01T00:00:00.000Z'), commercialAt: null },
        }),
      ).verdict,
    ).toBe('ineligible');
  });

  it('a category exception refuses, and it is checked before the window', () => {
    expect(
      deriveRetailServiceEligibility(eligibilityInput({ categoryExcluded: true })),
    ).toEqual({ verdict: 'ineligible', reason: 'category_exception' });
  });

  it('units already resolved cannot be claimed again', () => {
    expect(
      deriveRetailServiceEligibility(eligibilityInput({ unresolvedUnitsAvailable: false })),
    ).toEqual({ verdict: 'ineligible', reason: 'quantity_already_resolved' });
  });
});

describe('only refund-shaped outcomes are deliverable, and that is stated', () => {
  it('refuses the three that need a second purchase order', () => {
    for (const outcome of ['replacement', 'repair', 'redelivery'] as const) {
      expect(retailOutcomeIsDeliverable(outcome)).toBe(false);
    }
    for (const outcome of [
      'full_refund',
      'partial_refund',
      'price_reduction',
      'cancellation_refund',
      'no_remedy',
    ] as const) {
      expect(retailOutcomeIsDeliverable(outcome)).toBe(true);
    }
  });
});

describe('the refund allocation is explicit, bounded and never over-refunds', () => {
  const lines = [
    { orderItemId: 'item-a', quantity: 3, lineTotalMinor: 3000, discountTotalMinor: 300, taxMinor: 0 },
    { orderItemId: 'item-b', quantity: 1, lineTotalMinor: 1000, discountTotalMinor: 0, taxMinor: 0 },
  ];
  const totals = {
    currency: 'EUR' as const,
    deliveryMinor: 500,
    alreadyRefundedMinor: 0,
    grandTotalMinor: 4200,
  };

  it('a WHOLE line is computed as the whole line, not as N thirds', () => {
    const allocation = composeRetailRefundAllocation({
      kind: 'withdrawal_return',
      lines,
      units: [{ orderItemId: 'item-a', quantity: 3 }],
      totals,
    });
    expect(allocation.itemsMinor).toBe(3000);
    expect(allocation.discountMinor).toBe(-300);
    // Items + delivery + tax + discount is what the buyer gets back.
    expect(
      allocation.itemsMinor +
        allocation.deliveryMinor +
        allocation.taxMinor +
        allocation.discountMinor,
    ).toBe(3200);
  });

  it('a PARTIAL line prorates, and every rounding moves the net DOWN', () => {
    // The fixture that reaches the proration path at all — a whole-line case
    // never divides, so a suite of only whole lines cannot tell a floor from a
    // ceil from a round.
    const allocation = composeRetailRefundAllocation({
      kind: 'withdrawal_return',
      lines: [
        {
          orderItemId: 'item-c',
          quantity: 3,
          // 1000/3 does not divide: floor gives 333 per unit and ceil on the
          // discount gives 34, so the net is 299 rather than 300.
          lineTotalMinor: 1000,
          discountTotalMinor: 100,
          taxMinor: 0,
        },
      ],
      units: [{ orderItemId: 'item-c', quantity: 1 }],
      totals: { ...totals, deliveryMinor: 0 },
    });
    expect(allocation.itemsMinor).toBe(333);
    expect(allocation.discountMinor).toBe(-34);
    expect(allocation.itemsMinor + allocation.discountMinor).toBe(299);
  });

  it('DELIVERY comes back on a cancellation and on a seller fault, not on a change of mind alone', () => {
    // The three fixtures are what make the rule readable: the buyer's own
    // withdrawal, a seller-fault return and a kind that is neither.
    expect(RETAIL_DELIVERY_REFUNDING_KINDS).toContain('pre_dispatch_cancellation');
    expect(RETAIL_DELIVERY_REFUNDING_KINDS).toContain('wrong_item');
    expect(RETAIL_DELIVERY_REFUNDING_KINDS).not.toContain('defective_product');

    const withDelivery = composeRetailRefundAllocation({
      kind: 'wrong_item',
      lines,
      units: [{ orderItemId: 'item-b', quantity: 1 }],
      totals,
    });
    expect(withDelivery.deliveryMinor).toBe(500);

    const withoutDelivery = composeRetailRefundAllocation({
      kind: 'defective_product',
      lines,
      units: [{ orderItemId: 'item-b', quantity: 1 }],
      totals,
    });
    expect(withoutDelivery.deliveryMinor).toBe(0);
  });

  it('the CEILING is what a prior refund leaves, and it clamps the item side', () => {
    const allocation = composeRetailRefundAllocation({
      kind: 'withdrawal_return',
      lines,
      units: [
        { orderItemId: 'item-a', quantity: 3 },
        { orderItemId: 'item-b', quantity: 1 },
      ],
      // 4200 grand total, 4000 already refunded — 200 left, whatever the lines
      // say. This is the arithmetic layer of "cannot double-refund"; the other
      // two are the request's own idempotency key and `refunds.idempotency_key`.
      totals: { ...totals, alreadyRefundedMinor: 4000 },
    });
    const total =
      allocation.itemsMinor +
      allocation.deliveryMinor +
      allocation.taxMinor +
      allocation.discountMinor;
    expect(total).toBeLessThanOrEqual(200);
    expect(allocation.itemsMinor).toBeGreaterThanOrEqual(0);
  });

  it('a line the order does not have contributes nothing', () => {
    const allocation = composeRetailRefundAllocation({
      kind: 'withdrawal_return',
      lines,
      units: [{ orderItemId: 'not-on-this-order', quantity: 5 }],
      totals: { ...totals, deliveryMinor: 0 },
    });
    expect(allocation.itemsMinor).toBe(0);
  });
});
