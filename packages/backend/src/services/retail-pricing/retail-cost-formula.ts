/**
 * The binding cost-only formula (#120, ADR 0004 D3) — PURE.
 *
 * ```text
 * customer amount
 *   = supplier acquisition cost
 *   + mandatory supplier handling / pick-pack cost
 *   + destination-specific fulfilment and shipping cost
 *   + legally applicable taxes / duties in the customer total
 *   + other approved, unavoidable, directly attributable order costs
 *
 * Mercaria markup = 0
 * Mercaria item profit target = 0
 * ```
 *
 * ## Zero markup is a property of this function's SIGNATURE
 *
 * `composeRetailCostOnlyTotal` takes components, a presentment currency and an
 * optional explicit subsidy. There is no rate parameter, no floor parameter and
 * no policy knob that could add anything — the total is
 * `Σ component.presentmentAmount`, so `total − Σcomponents` is identically zero
 * for every possible input. That difference is RETURNED as `markupMinor` rather
 * than asserted in a comment, which is what lets a randomized property test
 * prove the claim instead of restating it.
 *
 * ## The order of operations, and why quantity is applied in the SOURCE currency
 *
 * A component's `sourceAmount` is already the line figure — unit cost times
 * quantity, computed as exact integer arithmetic in the SUPPLIER's own currency
 * by `retail-cost-quote.service`. Only then is it converted, ONCE, half-even
 * (`fx.convert` → `roundMinorUnits`). Converting per unit and multiplying
 * afterwards would multiply the rounding error by the quantity; this way the
 * only rounding in the whole composition is one half-even step per component.
 *
 * There is deliberately no SECOND rounding at the total: the customer total is
 * the exact integer sum of already-rounded component amounts, so no
 * largest-remainder allocation is needed and no third rounding convention is
 * introduced. (`settlement-shares.apportion` remains the house rule for
 * SPLITTING a total — nothing here splits one.)
 *
 * ## What a subsidy may and may not do
 *
 * A promotion reduces what the BUYER PAYS and never what the order COSTS: the
 * two figures are returned separately, the subsidy is bounded to
 * `[0, costOnlyTotal]`, and the same relationship is a CHECK on
 * `retail_cost_quotes`. A supplier-funded promotion would have to appear as a
 * negative component amount, which the component CHECK refuses, or as a
 * different `RetailSubsidySource`, of which there is exactly one and it is
 * Mercaria's own marketing budget.
 */

import type {
  CurrencyCode,
  Money,
  RetailCostComponent,
  RetailPromotionSubsidy,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** The formula's answer: what the order costs, and what the buyer pays. */
export interface RetailCostOnlyTotal {
  /** The exact sum of the components — the cost-only customer amount. */
  costOnlyTotal: Money;
  /** The explicit Mercaria-funded reduction, when one was given. */
  subsidy?: RetailPromotionSubsidy;
  /** `costOnlyTotal − subsidy`. What the buyer is charged. */
  buyerPayable: Money;
  /**
   * `costOnlyTotal − Σcomponents`, in minor units. Structurally ZERO: it is
   * returned so the zero-markup claim is a value a test can assert over
   * randomized inputs rather than a sentence in a docblock.
   */
  markupMinor: number;
  /**
   * The planned Mercaria item profit, in minor units. Structurally ZERO for the
   * same reason: `buyerPayable + subsidy − costOnlyTotal`.
   */
  itemProfitMinor: number;
}

/**
 * Compose the cost-only customer amount from its components.
 *
 * @throws When a component is denominated in anything but `presentmentCurrency`
 *   (the conversion is the caller's job and must already have happened — a
 *   total that mixed currencies would be meaningless, so this fails rather than
 *   converting and becoming a second FX authority), when the component list is
 *   empty (a price with no cost behind it is not a cost-only price), or when a
 *   subsidy is negative, in the wrong currency, or larger than the cost.
 */
export function composeRetailCostOnlyTotal(input: {
  components: readonly Pick<RetailCostComponent, 'kind' | 'presentmentAmount'>[];
  presentmentCurrency: CurrencyCode;
  subsidy?: RetailPromotionSubsidy;
}): RetailCostOnlyTotal {
  const { components, presentmentCurrency, subsidy } = input;

  if (components.length === 0) {
    throw validationError(
      'A retail cost-only price is the sum of its documented direct costs; a quote with no ' +
        'components would be a price with no cost behind it.',
    );
  }

  let sumMinor = 0;
  components.forEach((component, index) => {
    if (component.presentmentAmount.currency !== presentmentCurrency) {
      throw validationError(
        `Retail cost component ${index} (${component.kind}) is denominated in ` +
          `${component.presentmentAmount.currency} but the quote is presented in ` +
          `${presentmentCurrency}; components are converted once, before the total is composed.`,
      );
    }
    if (component.presentmentAmount.amount < 0) {
      throw validationError(
        `Retail cost component ${index} (${component.kind}) is negative. A direct cost is ` +
          'never negative — a supplier-funded promotion is not representable, and a ' +
          'Mercaria-funded one is an explicit subsidy with a named budget.',
      );
    }
    assertSafeMoneyAmount(
      component.presentmentAmount.amount,
      `retail.component[${String(index)}].${component.kind}`,
    );
    sumMinor += component.presentmentAmount.amount;
  });
  assertSafeMoneyAmount(sumMinor, 'retail.costOnlyTotal');

  const costOnlyTotal: Money = { amount: sumMinor, currency: presentmentCurrency };

  // Re-derived from the components rather than carried forward from `sumMinor`,
  // so this is a genuine measurement of "what did the formula add on top" and
  // not a constant dressed as one. It is zero for every input by construction,
  // and the property test over randomized components is what proves it.
  const componentSumMinor = components.reduce(
    (sum, component) => sum + component.presentmentAmount.amount,
    0,
  );
  const markupMinor = costOnlyTotal.amount - componentSumMinor;

  if (!subsidy) {
    return {
      costOnlyTotal,
      buyerPayable: costOnlyTotal,
      markupMinor,
      itemProfitMinor: costOnlyTotal.amount - componentSumMinor,
    };
  }

  if (subsidy.amount.currency !== presentmentCurrency) {
    throw validationError(
      `A promotion subsidy of ${subsidy.amount.currency} cannot reduce a total presented in ` +
        `${presentmentCurrency}; the subsidy is booked in the currency the buyer is charged in.`,
    );
  }
  assertSafeMoneyAmount(subsidy.amount.amount, 'retail.subsidy');
  if (subsidy.amount.amount < 0) {
    throw validationError(
      'A promotion subsidy is never negative. A negative subsidy would raise the item price ' +
        'to fund a promotion later, which #120 forbids outright.',
    );
  }
  if (subsidy.amount.amount > sumMinor) {
    throw validationError(
      'A promotion subsidy may not exceed the cost it reduces; a buyer cannot be paid to ' +
        'take the item, and the excess would have no expense account to come from.',
    );
  }
  if (subsidy.budgetRef.trim().length === 0) {
    throw validationError(
      'A promotion subsidy needs an explicit, named budget source — it is a Mercaria ' +
        'marketing expense, never a supplier underpayment.',
    );
  }

  const buyerPayableMinor = sumMinor - subsidy.amount.amount;
  assertSafeMoneyAmount(buyerPayableMinor, 'retail.buyerPayable');

  return {
    costOnlyTotal,
    subsidy,
    buyerPayable: { amount: buyerPayableMinor, currency: presentmentCurrency },
    markupMinor,
    // What Mercaria keeps: what the buyer paid, plus what Mercaria's own budget
    // put in, minus what the order cost. Zero for every input — the subsidy is
    // an expense, so funding one can never leave Mercaria ahead.
    itemProfitMinor: buyerPayableMinor + subsidy.amount.amount - componentSumMinor,
  };
}

/**
 * The audit sentence a quote carries into an operator trace and #129's
 * transparent breakdown — composed from the SAME figures the row stores, so it
 * can never describe a different arithmetic from the one that ran.
 */
export function explainRetailCostOnlyTotal(
  total: RetailCostOnlyTotal,
  components: readonly Pick<RetailCostComponent, 'kind' | 'presentmentAmount' | 'confidence'>[],
): string {
  const parts = components.map(
    (component) =>
      `${component.kind} ${String(component.presentmentAmount.amount)} ` +
      `${component.presentmentAmount.currency} (${component.confidence})`,
  );
  const base =
    `${parts.join(' + ')} = ${String(total.costOnlyTotal.amount)} ` +
    `${total.costOnlyTotal.currency} cost-only customer amount; ` +
    'Mercaria markup 0, planned item profit 0';
  if (!total.subsidy) {
    return `${base}.`;
  }
  return (
    `${base}; less a Mercaria promotion subsidy of ${String(total.subsidy.amount.amount)} ` +
    `${total.subsidy.amount.currency} from ${total.subsidy.budgetRef} ` +
    `(${total.subsidy.source}) = ${String(total.buyerPayable.amount)} ` +
    `${total.buyerPayable.currency} payable by the buyer. The subsidy is a Mercaria ` +
    'marketing expense; the supplier is paid in full.'
  );
}
