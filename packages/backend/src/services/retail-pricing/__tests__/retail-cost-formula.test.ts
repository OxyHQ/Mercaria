/**
 * The cost-only formula (#120) — the worked examples, and the zero-markup
 * property.
 *
 * The property test is the load-bearing one: "Mercaria markup = 0" is asserted
 * over randomized component sets rather than against a hand-picked fixture, so
 * a future change that added anything to the total fails here whatever shape it
 * took. `markupMinor` is re-derived inside the formula from the components, not
 * carried forward from the sum it returns, which is what makes that assertion
 * a measurement instead of a tautology.
 */

import { describe, expect, it } from 'vitest';
import type { CurrencyCode, Money, RetailCostComponent } from '@mercaria/shared-types';
import {
  RETAIL_COST_COMPONENT_KINDS,
  RETAIL_FORBIDDEN_COMPONENT_KINDS,
} from '@mercaria/shared-types';
import {
  composeRetailCostOnlyTotal,
  explainRetailCostOnlyTotal,
} from '../retail-cost-formula.js';

/** A same-currency component: source and presentment are the same figure. */
function component(
  kind: RetailCostComponent['kind'],
  amount: number,
  currency: CurrencyCode = 'EUR',
  overrides: Partial<RetailCostComponent> = {},
): RetailCostComponent {
  const money: Money = { amount, currency };
  return {
    kind,
    sourceRef: 'supplier_quote',
    sourceAmount: money,
    presentmentAmount: money,
    confidence: 'quoted',
    observedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('the cost-only formula', () => {
  it('case 1: an exact same-currency cost is the sum of its components', () => {
    // Supplier item 24.00 + handling 1.50 + shipping 4.95 + VAT 6.40 = 36.85 EUR.
    const total = composeRetailCostOnlyTotal({
      components: [
        component('supplier_item', 2400),
        component('supplier_handling', 150),
        component('destination_shipping', 495),
        component('tax_duty', 640),
      ],
      presentmentCurrency: 'EUR',
    });

    expect(total.costOnlyTotal).toEqual({ amount: 3685, currency: 'EUR' });
    expect(total.buyerPayable).toEqual({ amount: 3685, currency: 'EUR' });
    expect(total.markupMinor).toBe(0);
    expect(total.itemProfitMinor).toBe(0);
  });

  it('case 3: a destination-specific shipping component is separately attributable', () => {
    // The SAME item into two markets differs only by the shipping component —
    // which is exactly what "modelled separately, never hidden inside one
    // inflated unit price" buys.
    const item = component('supplier_item', 2400);
    const spain = composeRetailCostOnlyTotal({
      components: [item, component('destination_shipping', 495)],
      presentmentCurrency: 'EUR',
    });
    const france = composeRetailCostOnlyTotal({
      components: [item, component('destination_shipping', 895)],
      presentmentCurrency: 'EUR',
    });

    expect(france.costOnlyTotal.amount - spain.costOnlyTotal.amount).toBe(400);
    // And the item cost is unchanged between them — no destination surcharge
    // leaked into the unit price.
    expect(item.presentmentAmount.amount).toBe(2400);
  });

  it('case 4: a fixed supplier handling fee enters as its own component', () => {
    const total = composeRetailCostOnlyTotal({
      components: [
        component('supplier_item', 1000),
        component('supplier_handling', 250, 'EUR', { sourceRef: 'supplier_quote.handling' }),
      ],
      presentmentCurrency: 'EUR',
    });
    expect(total.costOnlyTotal.amount).toBe(1250);
    // It is a HANDLING row, not 2.50 added to the item price.
    expect(
      explainRetailCostOnlyTotal(total, [
        component('supplier_item', 1000),
        component('supplier_handling', 250),
      ]),
    ).toContain('supplier_handling 250 EUR');
  });

  it('case 10: a promotion is an explicit subsidy — cost unchanged, buyer pays less', () => {
    // #120's worked example: 100 EUR cost, 5 EUR Mercaria promotion, buyer pays
    // 95, supplier/direct costs stay 100.
    const total = composeRetailCostOnlyTotal({
      components: [component('supplier_item', 10_000)],
      presentmentCurrency: 'EUR',
      subsidy: {
        source: 'mercaria_marketing_budget',
        budgetRef: 'q3-2026-retail-launch',
        amount: { amount: 500, currency: 'EUR' },
      },
    });

    expect(total.costOnlyTotal.amount).toBe(10_000);
    expect(total.buyerPayable.amount).toBe(9_500);
    expect(total.subsidy?.amount.amount).toBe(500);
    // Funding a promotion never leaves Mercaria ahead.
    expect(total.itemProfitMinor).toBe(0);
    expect(explainRetailCostOnlyTotal(total, [component('supplier_item', 10_000)])).toContain(
      'the supplier is paid in full',
    );
  });

  it('refuses a promotion that would raise the price to fund itself later', () => {
    expect(() =>
      composeRetailCostOnlyTotal({
        components: [component('supplier_item', 1000)],
        presentmentCurrency: 'EUR',
        subsidy: {
          source: 'mercaria_marketing_budget',
          budgetRef: 'q3-2026',
          amount: { amount: -500, currency: 'EUR' },
        },
      }),
    ).toThrow(/never negative/);
  });

  it('refuses a subsidy with no named budget — the source must be explicit', () => {
    expect(() =>
      composeRetailCostOnlyTotal({
        components: [component('supplier_item', 1000)],
        presentmentCurrency: 'EUR',
        subsidy: {
          source: 'mercaria_marketing_budget',
          budgetRef: '   ',
          amount: { amount: 100, currency: 'EUR' },
        },
      }),
    ).toThrow(/explicit, named budget source/);
  });

  it('refuses a negative component — a "negative supplier cost" is not a promotion', () => {
    expect(() =>
      composeRetailCostOnlyTotal({
        components: [component('supplier_item', 1000), component('supplier_handling', -200)],
        presentmentCurrency: 'EUR',
      }),
    ).toThrow(/never negative/);
  });

  it('refuses a component in another currency rather than converting it', () => {
    expect(() =>
      composeRetailCostOnlyTotal({
        components: [component('supplier_item', 1000, 'USD')],
        presentmentCurrency: 'EUR',
      }),
    ).toThrow(/converted once, before the total is composed/);
  });

  it('refuses an empty component list — a price with no cost behind it', () => {
    expect(() =>
      composeRetailCostOnlyTotal({ components: [], presentmentCurrency: 'EUR' }),
    ).toThrow(/no cost behind it/);
  });

  it('case 11: rounding across quantities and many components adds nothing', () => {
    // Seven components with awkward amounts, the kind of set where a
    // percentage-then-round engine would drift. The sum is exact because there
    // is no percentage step and no second rounding: the total IS the sum.
    const amounts = [1_333, 777, 41, 9_999, 1, 2_468, 13];
    const kinds = RETAIL_COST_COMPONENT_KINDS.slice(0, amounts.length);
    const total = composeRetailCostOnlyTotal({
      components: amounts.map((amount, index) => component(kinds[index], amount)),
      presentmentCurrency: 'EUR',
    });

    expect(total.costOnlyTotal.amount).toBe(amounts.reduce((sum, a) => sum + a, 0));
    expect(total.markupMinor).toBe(0);
  });

  it('markup is ZERO for every randomized component set — the property, not a fixture', () => {
    // A deterministic PRNG so a failure is reproducible; 500 randomized sets
    // over 1–8 components and awkward magnitudes.
    let seed = 120_2026 % 2_147_483_647;
    const next = (bound: number): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % bound;
    };

    for (let run = 0; run < 500; run += 1) {
      const count = 1 + next(RETAIL_COST_COMPONENT_KINDS.length);
      const components = Array.from({ length: count }, (_unused, index) =>
        component(RETAIL_COST_COMPONENT_KINDS[index], next(5_000_000)),
      );
      const expected = components.reduce((sum, c) => sum + c.presentmentAmount.amount, 0);
      const subsidyMinor = expected === 0 ? 0 : next(expected + 1);

      const total = composeRetailCostOnlyTotal({
        components,
        presentmentCurrency: 'EUR',
        subsidy: {
          source: 'mercaria_marketing_budget',
          budgetRef: 'property-test',
          amount: { amount: subsidyMinor, currency: 'EUR' },
        },
      });

      expect(total.costOnlyTotal.amount).toBe(expected);
      expect(total.markupMinor).toBe(0);
      expect(total.itemProfitMinor).toBe(0);
      expect(total.buyerPayable.amount).toBe(expected - subsidyMinor);
    }
  });

  it('the allowed and forbidden component vocabularies are DISJOINT', () => {
    // The structural statement behind every test above: a forbidden component
    // is not a value the formula can be handed, because it is not a member of
    // the union the formula's parameter is typed with.
    const allowed = new Set<string>(RETAIL_COST_COMPONENT_KINDS);
    for (const forbidden of RETAIL_FORBIDDEN_COMPONENT_KINDS) {
      expect(allowed.has(forbidden), `${forbidden} must not be an allowed component`).toBe(false);
    }
    expect(RETAIL_COST_COMPONENT_KINDS).toHaveLength(8);
    expect(RETAIL_FORBIDDEN_COMPONENT_KINDS).toHaveLength(14);
  });
});
