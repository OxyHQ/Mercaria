/**
 * Deterministic selection, the substitution guard, and mixed-cart grouping
 * (#122 selection, mixed carts, acceptance 4 and 7).
 *
 * All pure, so every case here is the case production takes.
 */

import { describe, expect, it } from 'vitest';
import {
  assertSubstitutionPermitted,
  selectSourcingOrder,
  type SourcingCandidateFacts,
  type SourcingPolicyFacts,
} from '../selection.js';
import {
  composeDeliveredTotal,
  findGroupQuantityViolations,
  groupRetailLines,
  groupShippingCostMinor,
  type RetailPreflightLine,
} from '../grouping.js';

const EUR = 'EUR' as const;

function candidate(overrides: Partial<SourcingCandidateFacts> = {}): SourcingCandidateFacts {
  return {
    procurementOfferId: 'offer-a',
    supplierId: 'sup-a',
    supplierAccountId: 'acct-a',
    provider: 'p',
    declaredCapabilities: ['live_stock_lookup', 'destination_shipping_quote'],
    landedCostMinor: 1_000,
    currency: EUR,
    destinationEligible: true,
    freshnessSeconds: 60,
    deliveryDaysMax: 5,
    returnsSupported: true,
    healthSuccessBps: 9_000,
    currentShareBps: 0,
    suppression: 'none',
    accountActive: true,
    ...overrides,
  };
}

const POLICY: SourcingPolicyFacts = {
  rankingCriteria: ['total_landed_cost', 'delivery_promise'],
  requiredCapabilities: ['live_stock_lookup'],
  maxSourcingAttempts: 3,
  maxSupplierShareBps: 10_000,
};

describe('selectSourcingOrder', () => {
  it('orders by the policy criteria, cheapest first', () => {
    const { ordered } = selectSourcingOrder(
      [
        candidate({ procurementOfferId: 'b', landedCostMinor: 2_000 }),
        candidate({ procurementOfferId: 'a', landedCostMinor: 1_000 }),
      ],
      POLICY,
    );
    expect(ordered.map((entry) => entry.procurementOfferId)).toEqual(['a', 'b']);
  });

  it('produces a TOTAL order, so the result does not depend on input order', () => {
    // Acceptance 7's "reproducible" reduces to this: two candidates identical
    // on every criterion still compare, on the offer id.
    const left = candidate({ procurementOfferId: 'zzz' });
    const right = candidate({ procurementOfferId: 'aaa' });
    expect(selectSourcingOrder([left, right], POLICY).ordered[0]?.procurementOfferId).toBe('aaa');
    expect(selectSourcingOrder([right, left], POLICY).ordered[0]?.procurementOfferId).toBe('aaa');
  });

  it('sorts an UNKNOWN cost last rather than treating it as zero', () => {
    const { ordered } = selectSourcingOrder(
      [
        candidate({ procurementOfferId: 'unknown-cost', landedCostMinor: null }),
        candidate({ procurementOfferId: 'known-cost', landedCostMinor: 5_000 }),
      ],
      POLICY,
    );
    expect(ordered.map((entry) => entry.procurementOfferId)).toEqual([
      'known-cost',
      'unknown-cost',
    ]);
  });

  it('treats an ABSENT health measurement as neutral, not as bad', () => {
    // #92's rule: restricting on absence turns a brand-new supplier into a
    // permanently unselectable one. `null` must beat a measured 5_000 bps.
    const { ordered } = selectSourcingOrder(
      [
        candidate({ procurementOfferId: 'measured-poor', healthSuccessBps: 5_000 }),
        candidate({ procurementOfferId: 'never-measured', healthSuccessBps: null }),
      ],
      { ...POLICY, rankingCriteria: ['total_landed_cost', 'supplier_health'] },
    );
    expect(ordered[0]?.procurementOfferId).toBe('never-measured');
  });

  it('refuses rather than penalizes: suppression, inactivity, capability, concentration', () => {
    const { ordered, skipped } = selectSourcingOrder(
      [
        candidate({ procurementOfferId: 'suppressed', suppression: 'supplier', landedCostMinor: 1 }),
        candidate({ procurementOfferId: 'market', suppression: 'market', landedCostMinor: 1 }),
        candidate({ procurementOfferId: 'inactive', accountActive: false, landedCostMinor: 1 }),
        candidate({ procurementOfferId: 'ineligible', destinationEligible: false, landedCostMinor: 1 }),
        candidate({ procurementOfferId: 'incapable', declaredCapabilities: [], landedCostMinor: 1 }),
        candidate({ procurementOfferId: 'concentrated', currentShareBps: 10_000, landedCostMinor: 1 }),
        candidate({ procurementOfferId: 'fine', landedCostMinor: 9_999 }),
      ],
      POLICY,
    );
    // Every refusal is cheaper than the one that survives, so a penalty-based
    // implementation would have ranked them first.
    expect(ordered.map((entry) => entry.procurementOfferId)).toEqual(['fine']);
    expect(skipped.map((entry) => entry.reason).sort()).toEqual([
      'account_not_active',
      'capability_missing',
      'concentration_limit',
      'market_suppressed',
      'offer_ineligible',
      'supplier_suppressed',
    ]);
  });

  it('bounds attempts and records the candidates it never tried', () => {
    const many = Array.from({ length: 6 }, (_unused, index) =>
      candidate({ procurementOfferId: `offer-${String(index)}`, landedCostMinor: index }),
    );
    const { ordered, skipped } = selectSourcingOrder(many, { ...POLICY, maxSourcingAttempts: 2 });
    expect(ordered).toHaveLength(2);
    expect(skipped.filter((entry) => entry.reason === 'attempt_limit_reached')).toHaveLength(4);
  });
});

/**
 * The refusals a decision carries, or `null` when it permitted.
 *
 * A helper rather than a `if (!decision.permitted)` narrowing in each case:
 * this repository compiles with `strict: false`, under which truthiness
 * narrowing on a boolean-literal discriminant does not narrow the union — so a
 * test written that way reads as if it were checking the refusals while
 * actually failing to compile. Reading the property through `in` is the form
 * that works in both modes.
 */
function refusalsOf(decision: ReturnType<typeof assertSubstitutionPermitted>): readonly string[] | null {
  return 'refusals' in decision ? [...decision.refusals] : null;
}

describe('assertSubstitutionPermitted', () => {
  const locked = {
    canonicalVariantId: 'variant-1',
    supplierSku: 'SKU-A',
    quantity: 2,
    currency: EUR,
    totalMinor: 5_000,
    deliveryDaysMax: 5,
    returnsSupported: true,
  };

  it('permits a different SUPPLIER SKU for the same canonical variant', () => {
    // A failover supplier legitimately has its own SKU. Refusing on that alone
    // would make failover impossible for every mapped product.
    const decision = assertSubstitutionPermitted(
      locked,
      { ...locked, supplierSku: 'SKU-B' },
      { termsLocked: true },
    );
    expect(decision).toEqual({ permitted: true });
  });

  it('refuses a different canonical variant, locked or not', () => {
    // #122 selection 6 is unconditional.
    for (const termsLocked of [true, false]) {
      const decision = assertSubstitutionPermitted(
        locked,
        { ...locked, canonicalVariantId: 'variant-2' },
        { termsLocked },
      );
      expect(refusalsOf(decision)).toContain('different_canonical_variant');
    }
  });

  it('falls back to the SKU when either side is unmapped', () => {
    // Two different SKUs from two suppliers cannot be PROVEN to be the same
    // product with no canonical identity to compare — which is what stops a
    // refurbished unit silently replacing a new one.
    const unmapped = { ...locked, canonicalVariantId: null };
    const decision = assertSubstitutionPermitted(
      unmapped,
      { ...unmapped, supplierSku: 'SKU-REFURB' },
      { termsLocked: false },
    );
    expect(refusalsOf(decision)).toContain('different_supplier_sku');
  });

  it('checks commercial terms only once they are LOCKED', () => {
    const pricier = { ...locked, totalMinor: 6_000, deliveryDaysMax: 9, returnsSupported: false };
    expect(assertSubstitutionPermitted(locked, pricier, { termsLocked: false })).toEqual({
      permitted: true,
    });
    expect(refusalsOf(assertSubstitutionPermitted(locked, pricier, { termsLocked: true }))).toEqual([
      'higher_total_price',
      'slower_delivery_commitment',
      'weaker_return_capability',
    ]);
  });

  it('treats WITHDRAWING a delivery promise as slower', () => {
    const decision = assertSubstitutionPermitted(
      locked,
      { ...locked, deliveryDaysMax: null },
      { termsLocked: true },
    );
    expect(refusalsOf(decision)).toContain('slower_delivery_commitment');
  });
});

describe('grouping', () => {
  function line(overrides: Partial<RetailPreflightLine> = {}): RetailPreflightLine {
    return {
      procurementOfferId: 'offer-a',
      supplierAccountId: 'acct-a',
      fulfilmentOriginCountry: 'ES',
      currency: EUR,
      supplierSku: 'SKU-A',
      canonicalVariantId: 'v1',
      canonicalProductId: 'p1',
      quantity: 1,
      minimumOrderQuantity: null,
      packSize: null,
      ...overrides,
    };
  }

  it('groups by supplier account, fulfilment origin and currency', () => {
    const groups = groupRetailLines([
      line({ procurementOfferId: 'a' }),
      line({ procurementOfferId: 'b', fulfilmentOriginCountry: 'PL' }),
      line({ procurementOfferId: 'c', supplierAccountId: 'acct-b' }),
      line({ procurementOfferId: 'd', currency: 'USD' }),
      line({ procurementOfferId: 'e' }),
    ]);
    expect(groups).toHaveLength(4);
    const spanish = groups.find((group) => group.key.includes('acct-a') && group.key.includes('ES'));
    expect(spanish?.lines.map((entry) => entry.procurementOfferId)).toEqual(['a', 'e']);
  });

  it('decomposes identically however the lines were ordered', () => {
    const forward = groupRetailLines([line({ procurementOfferId: 'a' }), line({ procurementOfferId: 'b' })]);
    const backward = groupRetailLines([line({ procurementOfferId: 'b' }), line({ procurementOfferId: 'a' })]);
    expect(forward.map((group) => group.key)).toEqual(backward.map((group) => group.key));
    expect(forward[0]?.lines.map((entry) => entry.procurementOfferId)).toEqual(
      backward[0]?.lines.map((entry) => entry.procurementOfferId),
    );
  });

  it('reads a basket price ONCE and sums a per-item one', () => {
    // #122 mixed carts 3. The union is what makes the wrong arithmetic
    // unrepresentable; this pins that the reader takes the right branch.
    expect(
      groupShippingCostMinor({
        basis: 'basket',
        cost: { amount: 500, currency: EUR },
        serviceCode: 's',
        guaranteed: false,
      }),
    ).toBe(500);
    expect(
      groupShippingCostMinor({
        basis: 'per_item',
        costs: [
          { amount: 200, currency: EUR },
          { amount: 300, currency: EUR },
        ],
        serviceCode: 's',
        guaranteed: false,
      }),
    ).toBe(500);
  });

  it('returns NOTHING for an unknown shipping basis, never zero', () => {
    expect(groupShippingCostMinor({ basis: 'unknown', restrictions: [] })).toBeNull();
  });

  it('refuses a delivered total while ANY group is unquoted', () => {
    // #122 mixed carts 8, held by the return type: the incomplete branch has no
    // `total` member to read.
    const delivered = composeDeliveredTotal(
      [
        {
          key: 'g1',
          currency: EUR,
          itemSubtotalMinor: 1_000,
          shipping: { basis: 'basket', cost: { amount: 500, currency: EUR }, serviceCode: 's', guaranteed: true },
          taxMinor: null,
          dutyMinor: null,
          complete: true,
        },
        {
          key: 'g2',
          currency: EUR,
          itemSubtotalMinor: 2_000,
          shipping: { basis: 'unknown', restrictions: [] },
          taxMinor: null,
          dutyMinor: null,
          complete: false,
        },
      ],
      EUR,
    );
    expect(delivered).toEqual({ complete: false, unquotedGroupKeys: ['g2'] });
    // The incomplete branch has no `total` member at all — the return type is
    // what makes "do not claim a complete delivered total" unrepresentable
    // rather than merely unwritten.
    expect(delivered).not.toHaveProperty('total');
  });

  it('sums a fully-quoted cart', () => {
    const delivered = composeDeliveredTotal(
      [
        {
          key: 'g1',
          currency: EUR,
          itemSubtotalMinor: 1_000,
          shipping: { basis: 'basket', cost: { amount: 500, currency: EUR }, serviceCode: 's', guaranteed: true },
          taxMinor: 210,
          dutyMinor: null,
          complete: true,
        },
      ],
      EUR,
    );
    expect(delivered).toEqual({
      complete: true,
      total: { amount: 1_710, currency: EUR },
      groupTotals: [{ amount: 1_710, currency: EUR }],
    });
  });

  it('reports a mixed-currency group as unquoted rather than converting it', () => {
    const delivered = composeDeliveredTotal(
      [
        {
          key: 'usd',
          currency: 'USD',
          itemSubtotalMinor: 1_000,
          shipping: { basis: 'basket', cost: { amount: 500, currency: 'USD' }, serviceCode: 's', guaranteed: true },
          taxMinor: null,
          dutyMinor: null,
          complete: true,
        },
      ],
      EUR,
    );
    expect(delivered.complete).toBe(false);
  });

  it('finds a supplier minimum and a pack-size violation per LINE', () => {
    const [group] = groupRetailLines([
      line({ procurementOfferId: 'small', quantity: 1, minimumOrderQuantity: 5 }),
      line({ procurementOfferId: 'odd', quantity: 3, packSize: 2 }),
      line({ procurementOfferId: 'fine', quantity: 4, packSize: 2, minimumOrderQuantity: 2 }),
    ]);
    expect(group).toBeDefined();
    const violations = findGroupQuantityViolations(
      group ?? { key: '', supplierAccountId: '', fulfilmentOriginCountry: null, currency: EUR, lines: [] },
    );
    expect(violations.map((entry) => entry.procurementOfferId).sort()).toEqual(['odd', 'small']);
  });
});
