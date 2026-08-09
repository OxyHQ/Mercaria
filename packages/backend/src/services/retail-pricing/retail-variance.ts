/**
 * Post-checkout COST VARIANCE, and the eight accounting outputs (#120
 * "Post-checkout variance" and "Ledger / accounting outputs"; ADR 0004 D8) —
 * PURE.
 *
 * ## Why "variance" and not "margin"
 *
 * The expected margin on a retail order is always zero, so a difference between
 * what the buyer was charged and what the order actually cost is not margin
 * performance — it is a cost that moved. `classifyRetailCostVariance` therefore
 * has no branch that produces revenue, and `RETAIL_ACCOUNTING_OUTPUTS` has no
 * member a positive difference could be recognized into. A surplus can only
 * become `customer_adjustment_payable`; a shortfall can only become
 * `absorbed_variance`.
 *
 * ## The tolerance bounds AUTOMATION, never classification
 *
 * `deltaMinor` is recorded whatever the tolerance says. The tolerance decides
 * whether a difference is *worth a customer adjustment*, not whether it
 * happened — which is the difference between "a tiny rounding tolerance" and "a
 * place to hide material variance". The ceiling on what a policy may configure
 * is `RETAIL_MAX_ROUNDING_TOLERANCE_MINOR`, enforced by a CHECK on
 * `retail_pricing_policies`, so the tolerance cannot be widened into that place.
 *
 * ## What this module deliberately does NOT do
 *
 * It books nothing. Turning a `customer_adjustment_payable` into an actual
 * refund, and an `absorbed_variance` into balanced ledger entries, is #128's
 * work through the existing ledger repository — the ONE writer. A second
 * durable record of the same fact is exactly what the ledger rules forbid, so
 * this module hands #123/#128 a typed projection and stops.
 */

import type {
  CurrencyCode,
  Money,
  RetailAccountingEntry,
  RetailCostComponent,
  RetailCostVariance,
  RetailPromotionSubsidy,
  RetailVarianceDisposition,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** What a variance classification compares. */
export interface RetailVarianceInput {
  /** The frozen customer amount — what the buyer was charged. It never rises. */
  lockedCustomerTotal: Money;
  /** The actual attributable cost, once actuals are known (#128's input). */
  actualAttributableCost: Money;
  /** The policy version's tiny minor-unit tolerance. */
  toleranceMinor: number;
}

/**
 * Classify one final-versus-locked difference.
 *
 * @throws When the two amounts are in different currencies. A variance across
 *   currencies is not a variance, it is a missing conversion — and converting
 *   here would make this module a second FX authority whose rate nothing
 *   recorded.
 */
export function classifyRetailCostVariance(input: RetailVarianceInput): RetailCostVariance {
  const { lockedCustomerTotal, actualAttributableCost, toleranceMinor } = input;

  if (lockedCustomerTotal.currency !== actualAttributableCost.currency) {
    throw validationError(
      `A retail cost variance compares ${lockedCustomerTotal.currency} against ` +
        `${actualAttributableCost.currency}; convert the actual through the payment domain's ` +
        'own captured rate first, so the conversion is recorded rather than invented here.',
    );
  }
  if (!Number.isInteger(toleranceMinor) || toleranceMinor < 0) {
    throw validationError(
      `A rounding tolerance is a non-negative whole number of minor units, received ` +
        `${String(toleranceMinor)}.`,
    );
  }
  assertSafeMoneyAmount(lockedCustomerTotal.amount, 'retail.variance.locked');
  assertSafeMoneyAmount(actualAttributableCost.amount, 'retail.variance.actual');

  const deltaMinor = actualAttributableCost.amount - lockedCustomerTotal.amount;
  assertSafeMoneyAmount(deltaMinor, 'retail.variance.delta');

  const disposition = dispose(deltaMinor, toleranceMinor);
  return {
    deltaMinor,
    currency: lockedCustomerTotal.currency,
    disposition,
    toleranceMinor,
    explanation: explain(deltaMinor, toleranceMinor, disposition, lockedCustomerTotal.currency),
  };
}

/** The three-way decision, isolated so the boundary conditions are readable. */
function dispose(deltaMinor: number, toleranceMinor: number): RetailVarianceDisposition {
  if (Math.abs(deltaMinor) <= toleranceMinor) {
    return 'within_rounding_tolerance';
  }
  // Actual cost BELOW the locked amount: the buyer paid more than the order
  // cost. The surplus is theirs — it is not, and can never become, revenue.
  if (deltaMinor < 0) {
    return 'customer_adjustment_owed';
  }
  // Actual cost ABOVE the locked amount: Mercaria absorbs it. There is no
  // surcharge path and none may be built (ADR 0004 D8.4).
  return 'mercaria_absorbed';
}

/** The audit sentence an operator trace and #128's discrepancy row both show. */
function explain(
  deltaMinor: number,
  toleranceMinor: number,
  disposition: RetailVarianceDisposition,
  currency: CurrencyCode,
): string {
  const magnitude = String(Math.abs(deltaMinor));
  switch (disposition) {
    case 'within_rounding_tolerance':
      return (
        `Actual attributable cost differs from the locked customer amount by ${magnitude} ` +
        `${currency} minor units, within the ${String(toleranceMinor)}-unit rounding ` +
        'tolerance. The difference is recorded, not discarded: the tolerance bounds ' +
        'automatic adjustment, it does not reclassify variance out of existence.'
      );
    case 'customer_adjustment_owed':
      return (
        `Actual attributable cost came in ${magnitude} ${currency} minor units BELOW the ` +
        'locked customer amount. The surplus is the customer’s and enters the ' +
        'customer-adjustment/refund path (#128). It is not Mercaria revenue and there is no ' +
        'account in which it could be recognized as one.'
      );
    case 'mercaria_absorbed':
      return (
        `Actual attributable cost came in ${magnitude} ${currency} minor units ABOVE the ` +
        'locked customer amount. Mercaria absorbs it: the charged amount was frozen before ' +
        'payment and never rises, and no surcharge path exists.'
      );
  }
}

/** Everything the accounting projection needs about one settled retail order. */
export interface RetailAccountingInput {
  /** The quote's components — the attributable cost, by kind. */
  components: readonly Pick<RetailCostComponent, 'kind' | 'presentmentAmount'>[];
  /** What the buyer was charged. */
  buyerPayable: Money;
  /** The explicit Mercaria-funded reduction, when one applied. */
  subsidy?: RetailPromotionSubsidy;
  /** The classified variance, once actuals are known. Absent before then. */
  variance?: RetailCostVariance;
}

/**
 * Project one retail order onto the eight accounting components #123 and #128
 * consume.
 *
 * Every entry is derived from a figure the quote already stores, so this adds
 * no arithmetic authority — it groups. The grouping is what makes supplier,
 * shipping, tax, FX and provider costs "separately attributable" (#120
 * acceptance criterion 6) instead of one blended number.
 *
 * A zero-valued entry is OMITTED rather than emitted: an order with no subsidy
 * has no promotion expense, and a zero row in an accounting projection reads as
 * a fact that was measured rather than one that did not occur.
 */
export function projectRetailAccountingOutputs(
  input: RetailAccountingInput,
): RetailAccountingEntry[] {
  const currency = input.buyerPayable.currency;
  const entries: RetailAccountingEntry[] = [];

  const push = (
    output: RetailAccountingEntry['output'],
    amountMinor: number,
  ): void => {
    if (amountMinor === 0) return;
    assertSafeMoneyAmount(amountMinor, `retail.accounting.${output}`);
    entries.push({ output, amount: { amount: amountMinor, currency } });
  };

  const sumOf = (kinds: readonly RetailCostComponent['kind'][]): number =>
    input.components
      .filter((component) => kinds.includes(component.kind))
      .reduce((sum, component) => sum + component.presentmentAmount.amount, 0);

  // 1. What the buyer owes / the provider clears.
  push('customer_receivable', input.buyerPayable.amount);
  // 2. The procurement cost — what the supplier is owed for goods.
  push(
    'supplier_payable',
    sumOf(['supplier_item', 'supplier_variant_surcharge', 'supplier_handling']),
  );
  // 3. Fulfilment.
  push('shipping_fulfilment_cost', sumOf(['destination_shipping', 'other_direct_fulfilment']));
  // 4. The tax/duty Mercaria collects and owes on.
  push('tax_duty_liability', sumOf(['tax_duty']));
  // 5. Provider and FX costs, together: both are the cost of MOVING the money.
  push('provider_fx_cost', sumOf(['fx_cost', 'payment_processing']));
  // 6. The marketing expense funding any promotion.
  push('promotion_subsidy', input.subsidy?.amount.amount ?? 0);

  // 7/8. Variance, and only in the two directions that exist. Note the absence
  // of any third branch: a surplus has no revenue account to reach.
  if (input.variance?.disposition === 'customer_adjustment_owed') {
    push('customer_adjustment_payable', Math.abs(input.variance.deltaMinor));
  }
  if (input.variance?.disposition === 'mercaria_absorbed') {
    push('absorbed_variance', Math.abs(input.variance.deltaMinor));
  }

  return entries;
}
