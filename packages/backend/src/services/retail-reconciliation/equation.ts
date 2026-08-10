/**
 * #128's zero-profit reconciliation equation — PURE.
 *
 * ```text
 * final attributable cost
 *   = final supplier item cost
 *   + final allowed fulfilment/direct costs
 *   + applicable customer tax/duty components
 *   + allowed actual provider/FX costs
 *
 * cost variance
 *   = customer amount before explicit Mercaria subsidy
 *   - final attributable cost
 * ```
 *
 * Verbatim from the issue, and the only place either line is written. Money in,
 * a verdict out: no database, no clock, no configuration and no FX service —
 * which is what lets the four interpretations be table-tested against worked
 * examples the way `enforcement-plan.ts` is, and what keeps a live exchange rate
 * out of a historical answer.
 *
 * ## The sign convention, and why it is the opposite of #120's
 *
 * Here a POSITIVE variance means the buyer paid MORE than the order cost, so the
 * surplus is theirs. `classifyRetailCostVariance` in #120 computes
 * `actual − locked` and reads a NEGATIVE number the same way. The two are not
 * inconsistent, they are two subtractions of one pair, and this file uses the
 * issue's own spelling because this is where the number is stored and booked:
 * `retail_reconciliations.cost_variance_minor` and #123's
 * `retail_cost_variance_records.delta_amount` both mean "the customer amount
 * minus the actual", and a CHECK re-computes each of them from its own operands.
 *
 * ## Which components enter which side is a property of the COMPONENT
 *
 * `RETAIL_COMPONENT_ROLES` decides, and every stored amount is a non-negative
 * magnitude. A signed column would let one writer record a supplier credit as a
 * negative cost and another as a positive recovery, and both would balance while
 * meaning opposite things. The two `variance_disposition` components are OUTPUTS
 * and are excluded from both sides by the same map — feeding a disposition back
 * in as if it were a cost is the arithmetic that would make an adjustment
 * recognized twice.
 *
 * ## An unevidenced term is never a zero
 *
 * `classifyRetailReconciliation` returns a `missing_evidence` verdict with NO
 * amounts on it when any blocking exception is present. The union's incomplete
 * branch has no `outcome`, no `costVarianceMinor` and no `finalAttributableCost`
 * property at all, so a caller cannot read a confident number off an incomplete
 * answer — the `deriveOfferDelivery` device, applied to money. #128 acceptance 7
 * is that shape plus the biconditional CHECK the row carries.
 */

import type {
  CurrencyCode,
  Money,
  RetailAccountingComponent,
  RetailComponentRole,
  RetailReconciliationExceptionKind,
  RetailReconciliationOutcome,
} from '@mercaria/shared-types';
import {
  assertSafeMoneyAmount,
  RETAIL_COMPONENT_ROLES,
  RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** One component's contribution, already converted into the accounting currency. */
export interface ReconciliationTerm {
  component: RetailAccountingComponent;
  /** A non-negative magnitude in the accounting currency. The role carries the sign. */
  accountingAmountMinor: number;
}

/** Everything the equation needs, and nothing that could make it non-deterministic. */
export interface ReconciliationEquationInput {
  accountingCurrency: CurrencyCode;
  terms: readonly ReconciliationTerm[];
  /** The policy version's tiny, currency-aware tolerance for THIS currency. */
  toleranceMinor: number;
  /**
   * The conditions that left a term of the equation without evidence.
   *
   * Passed IN rather than inferred from a missing term, because "no supplier
   * handling fee was charged" and "the supplier invoice has not arrived" produce
   * exactly the same absence and mean opposite things. Only the gatherer, which
   * knows which documents it looked for, can tell them apart.
   */
  blockedBy: readonly RetailReconciliationExceptionKind[];
}

/**
 * The verdict. A STRING discriminant, not a boolean — this backend compiles with
 * `strict: false`, so without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant and the caller would
 * be left holding both branches.
 */
export type ReconciliationVerdict =
  | {
      readonly completeness: 'missing_evidence';
      /** The blocking conditions, sorted and deduped so two runs agree byte for byte. */
      readonly blockedBy: readonly RetailReconciliationExceptionKind[];
      /** The audit sentence an operator exception shows. */
      readonly explanation: string;
    }
  | {
      readonly completeness: 'complete';
      readonly outcome: RetailReconciliationOutcome;
      readonly accountingCurrency: CurrencyCode;
      /** The equation's left-hand side: what the buyer paid PLUS Mercaria's subsidy. */
      readonly customerAmountBeforeSubsidyMinor: number;
      /** The equation's right-hand side: the four cost terms, net of supplier credits. */
      readonly finalAttributableCostMinor: number;
      /** The subtraction. Positive means the buyer paid more than the order cost. */
      readonly costVarianceMinor: number;
      readonly toleranceMinor: number;
      readonly explanation: string;
    };

/** Sum the magnitudes of every term whose component plays `role`. */
function sumRole(terms: readonly ReconciliationTerm[], role: RetailComponentRole): number {
  return terms.reduce(
    (total, term) =>
      RETAIL_COMPONENT_ROLES[term.component] === role ? total + term.accountingAmountMinor : total,
    0,
  );
}

/**
 * Evaluate the equation and interpret its answer.
 *
 * @throws When a term carries a negative magnitude. The sign belongs to the
 *   component's role, so a negative amount is a caller that has already decided
 *   a direction the map exists to decide — and the two would disagree silently.
 */
export function classifyRetailReconciliation(
  input: ReconciliationEquationInput,
): ReconciliationVerdict {
  const { accountingCurrency, terms, toleranceMinor } = input;

  if (!Number.isInteger(toleranceMinor) || toleranceMinor < 0) {
    throw validationError(
      'A reconciliation tolerance is a non-negative whole number of minor units, received ' +
        `${String(toleranceMinor)}.`,
    );
  }
  for (const term of terms) {
    if (!Number.isInteger(term.accountingAmountMinor) || term.accountingAmountMinor < 0) {
      throw validationError(
        `Reconciliation component '${term.component}' carries ` +
          `${String(term.accountingAmountMinor)}: every component amount is a non-negative ` +
          'magnitude, and which side of the equation it enters is the component’s role, not ' +
          'the sign of the number.',
      );
    }
    assertSafeMoneyAmount(term.accountingAmountMinor, `retail.reconciliation.${term.component}`);
  }

  const blocking = [...new Set(input.blockedBy)]
    .filter((kind) => RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS.includes(kind))
    .sort();
  if (blocking.length > 0) {
    return {
      completeness: 'missing_evidence',
      blockedBy: blocking,
      explanation:
        'This order cannot be reconciled yet: ' +
        `${blocking.join(', ')}. A term of the cost equation has no evidence behind it, and ` +
        'summing it as zero would report a confident total built on a cost nobody documented.',
    };
  }

  // The customer side. The equation's term is the amount BEFORE the subsidy, so
  // what Mercaria funded is added back to what the buyer actually paid — the
  // subsidy is a marketing expense, and netting it out here would make a
  // promoted order look like one that cost less to fulfil.
  const inflow = sumRole(terms, 'customer_inflow');
  const subsidy = sumRole(terms, 'mercaria_funded');
  const outflow = sumRole(terms, 'customer_outflow');
  const customerAmountBeforeSubsidyMinor = inflow + subsidy - outflow;

  // The cost side, net of what came back against it.
  const cost = sumRole(terms, 'attributable_cost');
  const recovered = sumRole(terms, 'cost_recovery');
  const finalAttributableCostMinor = cost - recovered;

  assertSafeMoneyAmount(customerAmountBeforeSubsidyMinor, 'retail.reconciliation.customerAmount');
  assertSafeMoneyAmount(finalAttributableCostMinor, 'retail.reconciliation.attributableCost');

  // Both sides are sums of magnitudes minus other sums of magnitudes, so either
  // can go negative on evidence that is internally inconsistent — refunds
  // exceeding the charge, credits exceeding the invoice. That is a MISMATCH and
  // not a variance: a negative cost would make the buyer look owed the whole
  // charge back, and a negative customer amount would make Mercaria look owed
  // money by the buyer, which is the surcharge D8.4 forbids outright.
  if (customerAmountBeforeSubsidyMinor < 0 || finalAttributableCostMinor < 0) {
    return {
      completeness: 'missing_evidence',
      blockedBy: ['duplicate_customer_credit'],
      explanation:
        'The evidence is internally inconsistent: the customer side came to ' +
        `${String(customerAmountBeforeSubsidyMinor)} and the cost side to ` +
        `${String(finalAttributableCostMinor)} ${accountingCurrency} minor units, and neither ` +
        'can be negative. A refund or credit has been counted more than once, or one it ' +
        'reverses is missing.',
    };
  }

  const costVarianceMinor = customerAmountBeforeSubsidyMinor - finalAttributableCostMinor;
  assertSafeMoneyAmount(costVarianceMinor, 'retail.reconciliation.variance');
  const outcome = interpret(costVarianceMinor, toleranceMinor);

  return {
    completeness: 'complete',
    outcome,
    accountingCurrency,
    customerAmountBeforeSubsidyMinor,
    finalAttributableCostMinor,
    costVarianceMinor,
    toleranceMinor,
    explanation: explain(costVarianceMinor, toleranceMinor, outcome, accountingCurrency),
  };
}

/**
 * #128's four interpretations, in its own order.
 *
 * Exactly zero is checked FIRST and separately from the tolerance, because
 * "orders reconciled exactly to cost" is the issue's first metric and a count
 * that included rounded-off orders would report a precision the reconciliation
 * does not have.
 */
function interpret(varianceMinor: number, toleranceMinor: number): RetailReconciliationOutcome {
  if (varianceMinor === 0) return 'cost_recovered_exactly';
  if (Math.abs(varianceMinor) <= toleranceMinor) return 'within_rounding_tolerance';
  // The buyer paid MORE than the order finally cost. The surplus is theirs.
  if (varianceMinor > 0) return 'customer_adjustment_required';
  // The order cost MORE than the buyer paid. Mercaria absorbs it, and there is
  // no surcharge path (ADR 0004 D8.4).
  return 'mercaria_absorbed';
}

/** The audit sentence the reconciliation row and the operator trace both show. */
function explain(
  varianceMinor: number,
  toleranceMinor: number,
  outcome: RetailReconciliationOutcome,
  currency: CurrencyCode,
): string {
  const magnitude = String(Math.abs(varianceMinor));
  switch (outcome) {
    case 'cost_recovered_exactly':
      return (
        'The customer amount before subsidy equals the final attributable cost exactly. Cost ' +
        'recovered; nothing is owed in either direction.'
      );
    case 'within_rounding_tolerance':
      return (
        `The customer amount and the final attributable cost differ by ${magnitude} ` +
        `${currency} minor units, within the ${String(toleranceMinor)}-unit tolerance. Closed ` +
        'as rounding variance. The difference is RECORDED, not discarded: the tolerance bounds ' +
        'what happens automatically and never whether a difference occurred.'
      );
    case 'customer_adjustment_required':
      return (
        `The buyer paid ${magnitude} ${currency} minor units MORE than the order finally cost. ` +
        'The surplus is theirs and becomes a customer adjustment. It is not Mercaria revenue ' +
        'and there is no account in which it could be recognized as one.'
      );
    case 'mercaria_absorbed':
      return (
        `The order finally cost ${magnitude} ${currency} minor units MORE than the buyer paid. ` +
        'Mercaria absorbs it: the charged amount was frozen before payment and never rises, ' +
        'and no surcharge path exists.'
      );
  }
}

/** `Money` for one side of the equation, for a caller composing a projection. */
export function reconciliationMoney(minor: number, currency: CurrencyCode): Money {
  assertSafeMoneyAmount(minor, 'retail.reconciliation.money');
  return { amount: minor, currency };
}
