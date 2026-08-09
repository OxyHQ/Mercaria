/**
 * Post-checkout cost variance and the eight accounting outputs (#120).
 *
 * The two cases the issue names — positive and negative post-sale variance —
 * plus the tolerance boundary, plus the structural statement underneath all of
 * them: there is no accounting output a surplus could be recognized into as
 * revenue, and nothing in this domain is named for a margin.
 */

import { describe, expect, it } from 'vitest';
import type { RetailCostComponent } from '@mercaria/shared-types';
import {
  RETAIL_ACCOUNTING_OUTPUTS,
  RETAIL_DEFAULT_ROUNDING_TOLERANCE_MINOR,
  RETAIL_MAX_ROUNDING_TOLERANCE_MINOR,
} from '@mercaria/shared-types';
import {
  classifyRetailCostVariance,
  projectRetailAccountingOutputs,
} from '../retail-variance.js';

function component(kind: RetailCostComponent['kind'], amount: number): RetailCostComponent {
  return {
    kind,
    sourceRef: 'supplier_invoice',
    sourceAmount: { amount, currency: 'EUR' },
    presentmentAmount: { amount, currency: 'EUR' },
    confidence: 'final',
    observedAt: '2026-08-09T10:00:00.000Z',
  };
}

describe('retail cost variance', () => {
  it('case 8: a POSITIVE variance (actual cost lower) is owed to the customer, never revenue', () => {
    const variance = classifyRetailCostVariance({
      lockedCustomerTotal: { amount: 3685, currency: 'EUR' },
      actualAttributableCost: { amount: 3485, currency: 'EUR' },
      toleranceMinor: RETAIL_DEFAULT_ROUNDING_TOLERANCE_MINOR,
    });

    expect(variance.deltaMinor).toBe(-200);
    expect(variance.disposition).toBe('customer_adjustment_owed');
    expect(variance.explanation).toContain('not Mercaria revenue');

    const entries = projectRetailAccountingOutputs({
      components: [component('supplier_item', 3485)],
      buyerPayable: { amount: 3685, currency: 'EUR' },
      variance,
    });
    const outputs = entries.map((entry) => entry.output);
    expect(outputs).toContain('customer_adjustment_payable');
    expect(
      entries.find((entry) => entry.output === 'customer_adjustment_payable')?.amount,
    ).toEqual({ amount: 200, currency: 'EUR' });
    // The whole point: nothing recognized it as income.
    expect(outputs).not.toContain('absorbed_variance');
  });

  it('case 9: a NEGATIVE variance (actual cost higher) is absorbed, never recharged', () => {
    const variance = classifyRetailCostVariance({
      lockedCustomerTotal: { amount: 3685, currency: 'EUR' },
      actualAttributableCost: { amount: 4185, currency: 'EUR' },
      toleranceMinor: RETAIL_DEFAULT_ROUNDING_TOLERANCE_MINOR,
    });

    expect(variance.deltaMinor).toBe(500);
    expect(variance.disposition).toBe('mercaria_absorbed');
    expect(variance.explanation).toContain('no surcharge path exists');

    const entries = projectRetailAccountingOutputs({
      components: [component('supplier_item', 4185)],
      buyerPayable: { amount: 3685, currency: 'EUR' },
      variance,
    });
    const absorbed = entries.find((entry) => entry.output === 'absorbed_variance');
    expect(absorbed?.amount).toEqual({ amount: 500, currency: 'EUR' });
    // The buyer's receivable is unchanged — no surcharge was booked.
    expect(entries.find((entry) => entry.output === 'customer_receivable')?.amount).toEqual({
      amount: 3685,
      currency: 'EUR',
    });
  });

  it('a difference within the tiny tolerance is rounding — and is still RECORDED', () => {
    const variance = classifyRetailCostVariance({
      lockedCustomerTotal: { amount: 3685, currency: 'EUR' },
      actualAttributableCost: { amount: 3684, currency: 'EUR' },
      toleranceMinor: 1,
    });
    expect(variance.disposition).toBe('within_rounding_tolerance');
    // No material variance is hidden inside it: the delta is on the record.
    expect(variance.deltaMinor).toBe(-1);
    expect(variance.explanation).toContain('recorded, not discarded');

    // One minor unit past the tolerance is a real variance, not rounding.
    expect(
      classifyRetailCostVariance({
        lockedCustomerTotal: { amount: 3685, currency: 'EUR' },
        actualAttributableCost: { amount: 3683, currency: 'EUR' },
        toleranceMinor: 1,
      }).disposition,
    ).toBe('customer_adjustment_owed');
  });

  it('the tolerance ceiling is small, and is a shared constant rather than a local choice', () => {
    expect(RETAIL_DEFAULT_ROUNDING_TOLERANCE_MINOR).toBe(1);
    expect(RETAIL_MAX_ROUNDING_TOLERANCE_MINOR).toBe(5);
    expect(RETAIL_MAX_ROUNDING_TOLERANCE_MINOR).toBeLessThanOrEqual(5);
  });

  it('refuses a cross-currency comparison rather than converting silently', () => {
    expect(() =>
      classifyRetailCostVariance({
        lockedCustomerTotal: { amount: 3685, currency: 'EUR' },
        actualAttributableCost: { amount: 4000, currency: 'USD' },
        toleranceMinor: 1,
      }),
    ).toThrow(/convert the actual through the payment domain/);
  });

  it('separates supplier, shipping, tax and provider/FX costs (acceptance criterion 6)', () => {
    const entries = projectRetailAccountingOutputs({
      components: [
        component('supplier_item', 2400),
        component('supplier_handling', 150),
        component('destination_shipping', 495),
        component('tax_duty', 640),
        component('fx_cost', 30),
        component('payment_processing', 70),
      ],
      buyerPayable: { amount: 3685, currency: 'EUR' },
      subsidy: {
        source: 'mercaria_marketing_budget',
        budgetRef: 'q3-2026',
        amount: { amount: 100, currency: 'EUR' },
      },
    });
    const byOutput = new Map(entries.map((entry) => [entry.output, entry.amount.amount]));

    expect(byOutput.get('supplier_payable')).toBe(2550);
    expect(byOutput.get('shipping_fulfilment_cost')).toBe(495);
    expect(byOutput.get('tax_duty_liability')).toBe(640);
    expect(byOutput.get('provider_fx_cost')).toBe(100);
    expect(byOutput.get('promotion_subsidy')).toBe(100);
    expect(byOutput.get('customer_receivable')).toBe(3685);
  });

  it('omits a zero-valued entry rather than emitting a measured nothing', () => {
    const entries = projectRetailAccountingOutputs({
      components: [component('supplier_item', 2400)],
      buyerPayable: { amount: 2400, currency: 'EUR' },
    });
    expect(entries.map((entry) => entry.output)).toEqual([
      'customer_receivable',
      'supplier_payable',
    ]);
  });

  it('THERE IS NO item-profit account — the eight outputs are the complete set', () => {
    expect(RETAIL_ACCOUNTING_OUTPUTS).toHaveLength(8);
    expect(RETAIL_ACCOUNTING_OUTPUTS).not.toContain('retail_margin_revenue');
    for (const output of RETAIL_ACCOUNTING_OUTPUTS) {
      expect(
        /margin|profit|markup/.test(output),
        `${output} is named for an item margin; retail has none`,
      ).toBe(false);
    }
  });
});
