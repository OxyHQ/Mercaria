/**
 * #128's zero-profit equation and its four interpretations — table tests
 * against worked examples, the `enforcement-plan.ts` shape.
 *
 * The accounting is the part that has to be right the first time: a wrong
 * classification is discovered by a buyer who was refunded twice or not at all,
 * months later, rather than by a failing request.
 */

import { describe, expect, it } from 'vitest';
import {
  RETAIL_ACCOUNTING_COMPONENTS,
  RETAIL_COMPONENT_ROLES,
  RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS,
  RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS,
  RETAIL_RECONCILIATION_EXCEPTION_KINDS,
  type RetailAccountingComponent,
} from '@mercaria/shared-types';
import { classifyRetailReconciliation, type ReconciliationTerm } from '../equation.js';

/** A term list from a plain map, so a case reads as the money it describes. */
function terms(amounts: Partial<Record<RetailAccountingComponent, number>>): ReconciliationTerm[] {
  return Object.entries(amounts).map(([component, accountingAmountMinor]) => ({
    component: component as RetailAccountingComponent,
    accountingAmountMinor: accountingAmountMinor ?? 0,
  }));
}

describe('the twelve components and the fourteen prohibitions are disjoint', () => {
  it('shares no member', () => {
    const allowed = new Set<string>(RETAIL_ACCOUNTING_COMPONENTS);
    for (const forbidden of RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS) {
      expect(allowed.has(forbidden)).toBe(false);
    }
    // A vacuity floor: two empty tuples are trivially disjoint.
    expect(RETAIL_ACCOUNTING_COMPONENTS).toHaveLength(12);
    expect(RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS).toHaveLength(14);
  });

  it('gives every allowed component exactly one role', () => {
    for (const component of RETAIL_ACCOUNTING_COMPONENTS) {
      expect(RETAIL_COMPONENT_ROLES[component]).toBeDefined();
    }
    expect(Object.keys(RETAIL_COMPONENT_ROLES)).toHaveLength(RETAIL_ACCOUNTING_COMPONENTS.length);
  });

  it('names no revenue destination for a variance', () => {
    // The two dispositions are the ONLY places a variance can land, and both are
    // outputs excluded from both sides of the equation. If a third role or a
    // third disposition member ever appears, this is where it has to be argued.
    const dispositions = RETAIL_ACCOUNTING_COMPONENTS.filter(
      (component) => RETAIL_COMPONENT_ROLES[component] === 'variance_disposition',
    );
    expect(dispositions).toEqual(['customer_adjustment_payable', 'mercaria_absorbed_variance']);
  });
});

describe('the four interpretations', () => {
  it('1. reports an exact recovery when the two sides are equal', () => {
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 9_000, tax_duty_liability: 1_000 }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness).toBe('complete');
    if (verdict.completeness !== 'complete') return;
    expect(verdict.outcome).toBe('cost_recovered_exactly');
    expect(verdict.costVarianceMinor).toBe(0);
  });

  it('2. owes the customer a material surplus', () => {
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 9_000 }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness).toBe('complete');
    if (verdict.completeness !== 'complete') return;
    expect(verdict.outcome).toBe('customer_adjustment_required');
    // POSITIVE means the buyer paid more than it cost. The sign convention is
    // the issue's own and is the opposite of #120's `actual − locked`.
    expect(verdict.costVarianceMinor).toBe(1_000);
    expect(verdict.explanation).toContain('not Mercaria revenue');
  });

  it('3. absorbs a material shortfall and never surcharges', () => {
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 11_500 }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness).toBe('complete');
    if (verdict.completeness !== 'complete') return;
    expect(verdict.outcome).toBe('mercaria_absorbed');
    expect(verdict.costVarianceMinor).toBe(-1_500);
    expect(verdict.explanation).toContain('no surcharge path exists');
  });

  it('4. closes a sub-tolerance difference as rounding, in EITHER direction', () => {
    for (const cost of [10_001, 9_999]) {
      const verdict = classifyRetailReconciliation({
        accountingCurrency: 'EUR',
        terms: terms({ customer_charge: 10_000, supplier_item_cost: cost }),
        toleranceMinor: 1,
        blockedBy: [],
      });
      expect(verdict.completeness).toBe('complete');
      if (verdict.completeness !== 'complete') continue;
      expect(verdict.outcome).toBe('within_rounding_tolerance');
      // The delta is RECORDED whatever the tolerance says: the tolerance bounds
      // what happens automatically, never whether a difference occurred.
      expect(Math.abs(verdict.costVarianceMinor)).toBe(1);
    }
  });

  it('keeps an EXACT recovery apart from a rounded one', () => {
    // #128's first metric counts orders reconciled exactly. A tolerance of five
    // must not turn a one-unit difference into an exact recovery.
    const rounded = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 9_999 }),
      toleranceMinor: 5,
      blockedBy: [],
    });
    expect(rounded.completeness === 'complete' && rounded.outcome).toBe(
      'within_rounding_tolerance',
    );
  });

  it('is exactly at the boundary on the tolerance itself', () => {
    const atBoundary = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 9_995 }),
      toleranceMinor: 5,
      blockedBy: [],
    });
    expect(atBoundary.completeness === 'complete' && atBoundary.outcome).toBe(
      'within_rounding_tolerance',
    );
    const justOver = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 9_994 }),
      toleranceMinor: 5,
      blockedBy: [],
    });
    expect(justOver.completeness === 'complete' && justOver.outcome).toBe(
      'customer_adjustment_required',
    );
  });
});

describe('the customer term is the amount BEFORE the Mercaria subsidy', () => {
  it('adds the subsidy back rather than netting it out', () => {
    // A promoted order: the buyer paid 95, Mercaria funded 5, the order cost
    // 100. Cost was recovered exactly — the subsidy is a marketing expense and
    // not a discount on what the order cost to fulfil.
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({
        customer_charge: 9_500,
        mercaria_promotion_subsidy: 500,
        supplier_item_cost: 10_000,
      }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness === 'complete' && verdict.outcome).toBe('cost_recovered_exactly');
  });

  it('would report a false shortfall if the subsidy were left out', () => {
    // The mutation of the case above: without the subsidy term the same order
    // reads as Mercaria absorbing 500, which is the arithmetic error the role
    // map exists to prevent.
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 9_500, supplier_item_cost: 10_000 }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness === 'complete' && verdict.outcome).toBe('mercaria_absorbed');
  });
});

describe('refunds, credits and disputes', () => {
  it('leaves the variance unchanged when a return refund and its supplier credit pair up', () => {
    // #128 supplier-credit rule 2: a credit that accompanies a customer return
    // reconciles against the return lifecycle and does not reduce an
    // already-promised refund. Both movements lower opposite sides by the same
    // amount, so the pair changes nothing.
    const before = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 9_000 }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    const after = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({
        customer_charge: 10_000,
        customer_refund: 4_000,
        supplier_item_cost: 9_000,
        supplier_credit: 4_000,
      }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(before.completeness === 'complete' && before.costVarianceMinor).toBe(1_000);
    expect(after.completeness === 'complete' && after.costVarianceMinor).toBe(1_000);
  });

  it('creates a surplus when a credit arrives with no matching refund', () => {
    // Rule 3: a credit UNRELATED to a customer return lowers the final
    // attributable cost on its own, and under the zero-profit policy that is
    // exactly what may create a customer adjustment.
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 10_000, supplier_credit: 800 }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness === 'complete' && verdict.outcome).toBe(
      'customer_adjustment_required',
    );
    expect(verdict.completeness === 'complete' && verdict.costVarianceMinor).toBe(800);
  });

  it('absorbs the unreturned provider fee on a full compensating refund', () => {
    // ADR 0004 D8.7 case (b): the buyer gets 100% back and Mercaria is out the
    // fee, which is already an attributable cost. Procurement never happened, so
    // there is no supplier cost at all.
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({
        customer_charge: 10_000,
        customer_refund: 10_000,
        provider_processing_cost: 320,
      }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness === 'complete' && verdict.outcome).toBe('mercaria_absorbed');
    expect(verdict.completeness === 'complete' && verdict.costVarianceMinor).toBe(-320);
  });
});

describe('missing evidence is never a zero', () => {
  it('withholds the verdict entirely while a blocking condition is present', () => {
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000 }),
      toleranceMinor: 1,
      blockedBy: ['missing_supplier_invoice'],
    });
    expect(verdict.completeness).toBe('missing_evidence');
    // The incomplete branch carries NO outcome and NO amounts, so a caller
    // cannot read a confident surplus off an order whose cost is unknown. A
    // `10_000` surplus is exactly what a zero-cost reading would produce.
    expect('outcome' in verdict).toBe(false);
    expect('costVarianceMinor' in verdict).toBe(false);
  });

  it('ignores a NON-blocking exception kind', () => {
    // `absorbed_variance_over_threshold` is raised ABOUT a completed
    // reconciliation. Treating it as blocking would make an alert prevent the
    // verdict it is an alert about.
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, supplier_item_cost: 10_000 }),
      toleranceMinor: 1,
      blockedBy: ['absorbed_variance_over_threshold'],
    });
    expect(verdict.completeness).toBe('complete');
  });

  it('sorts and dedupes the blocking list so two runs agree byte for byte', () => {
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: [],
      toleranceMinor: 1,
      blockedBy: ['missing_provider_fee', 'missing_supplier_invoice', 'missing_provider_fee'],
    });
    expect(verdict.completeness).toBe('missing_evidence');
    if (verdict.completeness !== 'missing_evidence') return;
    expect(verdict.blockedBy).toEqual(['missing_provider_fee', 'missing_supplier_invoice']);
  });

  it('refuses internally inconsistent evidence rather than reporting a negative side', () => {
    // Refunds exceeding the charge is a MISMATCH and not a variance: reading it
    // as one would make the buyer look owed the whole charge back a second time.
    const verdict = classifyRetailReconciliation({
      accountingCurrency: 'EUR',
      terms: terms({ customer_charge: 10_000, customer_refund: 12_000 }),
      toleranceMinor: 1,
      blockedBy: [],
    });
    expect(verdict.completeness).toBe('missing_evidence');
    if (verdict.completeness !== 'missing_evidence') return;
    expect(verdict.blockedBy).toEqual(['duplicate_customer_credit']);
  });

  it('names every blocking kind as a real exception kind', () => {
    for (const kind of RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS) {
      expect(RETAIL_RECONCILIATION_EXCEPTION_KINDS).toContain(kind);
    }
    // A vacuity floor and the positive control: the blocking set is a strict
    // SUBSET, so an empty one would pass the loop above and mean nothing blocks.
    expect(RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS.length).toBeGreaterThanOrEqual(5);
    expect(RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS.length).toBeLessThan(
      RETAIL_RECONCILIATION_EXCEPTION_KINDS.length,
    );
  });
});

describe('the inputs it refuses', () => {
  it('refuses a negative component magnitude', () => {
    expect(() =>
      classifyRetailReconciliation({
        accountingCurrency: 'EUR',
        terms: [{ component: 'supplier_credit', accountingAmountMinor: -500 }],
        toleranceMinor: 1,
        blockedBy: [],
      }),
    ).toThrow(/non-negative magnitude/);
  });

  it('refuses a negative tolerance', () => {
    expect(() =>
      classifyRetailReconciliation({
        accountingCurrency: 'EUR',
        terms: terms({ customer_charge: 1 }),
        toleranceMinor: -1,
        blockedBy: [],
      }),
    ).toThrow(/non-negative whole number/);
  });
});
