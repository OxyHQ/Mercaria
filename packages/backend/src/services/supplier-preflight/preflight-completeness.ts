/**
 * Turning one supplier answer into a verdict: complete, partial or invalid
 * (#122 response item 16 and its closing rule).
 *
 * PURE. It imports no repository, makes no call and reads no clock beyond what
 * it is handed — the `services/retail-eligibility/eligibility.ts` split, for
 * the same reason: the whole table of cases can run as fixtures AND against a
 * real server through the identical derivation, byte for byte.
 *
 * ## The three answers are not degrees of one answer
 *
 * `complete` means every fact checkout needs is present and the item is
 * orderable. `partial` means the supplier answered honestly and the answer is
 * short of something — it may be SHOWN and may never be charged against.
 * `invalid` means the answer contradicts itself or the request, which is a
 * thing a person has to look at, and it carries the exception kind saying
 * which. They route differently, which is why they are three values and not a
 * boolean plus a comment (`RetailEligibilityVerdict`'s rule, #121).
 *
 * Severity is `invalid` > `partial` > `complete`, applied by construction: an
 * exception is decided first and short-circuits, because an answer that
 * contradicts itself has nothing to be partially right about.
 *
 * ## Only three facts can block a `complete` answer, and that is deliberate
 *
 * #122's closing rule names exactly three: unknown availability, a missing
 * required shipping cost, and an ambiguous SKU identity. A delivery window and
 * a tax treatment are NOT among them, because a made-to-order supplier that
 * publishes neither would otherwise be unable to sell anything at all — so
 * those two block only when the active sourcing policy requires the capability,
 * which is a decision an operator publishes rather than one hard-coded here.
 */

import type {
  CurrencyCode,
  Money,
  SupplierPreflightAnswer,
  SupplierPreflightBlockReason,
  SupplierPreflightCompleteness,
  SupplierPreflightExceptionKind,
  SupplierPreflightFailureKind,
} from '@mercaria/shared-types';
import type { SupplierCapabilityDowngrade } from './adapter.js';

/** Everything the verdict is derived from. Nothing here is read from a row. */
export interface SupplierCompletenessInput {
  answer: SupplierPreflightAnswer;
  requestedQuantity: number;
  requestedCurrency: CurrencyCode;
  /**
   * Claims the adapter made that its declared capabilities did not cover. A
   * non-empty list is a CONTRACT VIOLATION and decides the verdict on its own —
   * see `adapter.ts`.
   */
  contractViolations: readonly SupplierCapabilityDowngrade[];
  /**
   * Reasons decided outside the answer: a kill switch, an ineligible offer, a
   * missing policy, a disabled deployment. They block without being the
   * supplier's fault, and they are stated by the caller because only the caller
   * knows them.
   */
  gateReasons: readonly SupplierPreflightBlockReason[];
  /** How the call itself failed, when it did. A `timeout` is `unknown`, never stock. */
  failureKind: SupplierPreflightFailureKind | null;
  /** Whether the active policy requires a delivery window for this route. */
  requireDeliveryEstimate: boolean;
  /** Whether the active policy requires a stated tax treatment for this route. */
  requireTaxTreatment: boolean;
}

/**
 * Decide the verdict.
 *
 * Never throws: a malformed answer is `invalid` with a named exception, which
 * is an answer an operator can act on, where an exception would be a 500 on a
 * checkout path.
 */
export function deriveSupplierPreflightCompleteness(
  input: SupplierCompletenessInput,
): SupplierPreflightCompleteness {
  const exception = findException(input);
  if (exception) {
    return {
      status: 'invalid',
      blockReasons: sortUnique([...input.gateReasons, exceptionBlockReason(exception)]),
      exceptionKind: exception,
      mayCheckout: false,
    };
  }

  const reasons = new Set<SupplierPreflightBlockReason>(input.gateReasons);
  const { answer } = input;

  if (input.failureKind) reasons.add(failureBlockReason(input.failureKind));

  if (answer.availability === 'unknown') reasons.add('availability_unknown');
  else if (answer.availability !== 'orderable') reasons.add('not_orderable');

  if (answer.identity === 'unknown') reasons.add('identity_unconfirmed');
  else if (answer.identity === 'mismatched') reasons.add('identity_mismatched');

  if (answer.unitCost === null) reasons.add('unit_cost_unknown');

  if (answer.shipping.basis === 'unknown') reasons.add('shipping_cost_unknown');
  if (answer.destinationRestrictions.length > 0) reasons.add('destination_restricted');

  if (
    answer.maxOrderableQuantity !== null &&
    input.requestedQuantity > answer.maxOrderableQuantity
  ) {
    reasons.add('quantity_above_maximum');
  }
  if (
    answer.minimumOrderQuantity !== null &&
    input.requestedQuantity < answer.minimumOrderQuantity
  ) {
    reasons.add('quantity_below_minimum');
  }
  if (answer.packSize !== null && answer.packSize > 1 && input.requestedQuantity % answer.packSize !== 0) {
    reasons.add('pack_size_violated');
  }

  // Policy-gated, not hard-coded: see the module docblock.
  if (input.requireDeliveryEstimate && answer.deliveryDaysMax === null) {
    reasons.add('delivery_estimate_unknown');
  }
  if (input.requireTaxTreatment && answer.tax === null && answer.importResponsibility === null) {
    reasons.add('tax_treatment_unknown');
  }

  const blockReasons = sortUnique([...reasons]);
  return blockReasons.length === 0
    ? { status: 'complete', blockReasons: [], exceptionKind: null, mayCheckout: true }
    : { status: 'partial', blockReasons, exceptionKind: null, mayCheckout: false };
}

/**
 * The contradictions that make an answer `invalid` rather than merely short.
 *
 * Order matters only in that the first match wins, and a contract violation is
 * checked first because it says the adapter itself is not behaving — every
 * later check would be reading numbers from a source already known to be
 * unreliable.
 */
function findException(input: SupplierCompletenessInput): SupplierPreflightExceptionKind | null {
  if (input.contractViolations.length > 0) return 'provider_contract_violation';

  const { answer } = input;

  if (answer.identity === 'ambiguous') return 'ambiguous_sku_identity';

  // An amount denominated in something other than what was asked for is not an
  // answer to this question, and silently converting it here would invent a
  // rate nobody quoted.
  for (const amount of presentAmounts(answer)) {
    if (amount.currency !== input.requestedCurrency) return 'currency_mismatch';
  }

  // "Orderable, and you may order none of it" is not a state the world can be
  // in; it is two facts that cannot both be true.
  if (answer.availability === 'orderable' && answer.maxOrderableQuantity === 0) {
    return 'ambiguous_availability';
  }

  // A minimum above the maximum is a contradiction — but ONLY while the
  // maximum is positive. A `maxOrderableQuantity` of zero is the ordinary way
  // a supplier says "out of stock", and a minimum order quantity is a property
  // of the SKU rather than of today's stock, so the two together are the most
  // common healthy answer in the world and not a provider bug. Reading them as
  // one would file every out-of-stock line as an exception and bury the real
  // contradictions among them.
  if (
    answer.minimumOrderQuantity !== null &&
    answer.maxOrderableQuantity !== null &&
    answer.maxOrderableQuantity > 0 &&
    answer.minimumOrderQuantity > answer.maxOrderableQuantity
  ) {
    return 'quantity_contract_violation';
  }

  // The options and the headline answer must agree about how shipping is
  // priced, because the two bases produce different totals from the same rows
  // (#122 mixed carts 3).
  if (answer.shipping.basis !== 'unknown') {
    const disagreeing = answer.shippingOptions.some(
      (option) => option.basis !== answer.shipping.basis,
    );
    if (disagreeing) return 'conflicting_shipping_basis';
    const selected = answer.shipping.serviceCode;
    const known = answer.shippingOptions.some((option) => option.serviceCode === selected);
    // A selected service that is not among the offered ones cannot be priced
    // from this answer, and picking a different one would be Mercaria choosing
    // a delivery route the supplier did not quote.
    if (answer.shippingOptions.length > 0 && !known) return 'conflicting_shipping_basis';
  }

  return null;
}

/** Every money the answer actually carries, for the currency-coherence check. */
function presentAmounts(answer: SupplierPreflightAnswer): Money[] {
  const amounts: Money[] = [];
  if (answer.unitCost) amounts.push(answer.unitCost);
  if (answer.supplierFees) amounts.push(answer.supplierFees);
  if (answer.tax) amounts.push(answer.tax);
  if (answer.duty) amounts.push(answer.duty);
  if (answer.shipping.basis === 'basket') amounts.push(answer.shipping.cost);
  if (answer.shipping.basis === 'per_item') amounts.push(...answer.shipping.costs);
  for (const option of answer.shippingOptions) amounts.push(option.cost);
  return amounts;
}

/**
 * The block reason that accompanies each exception.
 *
 * An `invalid` answer still carries a non-empty `block_reasons` array, because
 * the column's CHECK requires one for anything that is not `complete` — and a
 * reader filtering on reasons should see the exception rather than an empty
 * list that reads like a clean answer.
 */
function exceptionBlockReason(kind: SupplierPreflightExceptionKind): SupplierPreflightBlockReason {
  switch (kind) {
    case 'ambiguous_sku_identity':
      return 'identity_ambiguous';
    case 'ambiguous_availability':
      return 'availability_unknown';
    case 'currency_mismatch':
      return 'currency_unsupported';
    case 'conflicting_shipping_basis':
      return 'shipping_service_unavailable';
    case 'quantity_contract_violation':
      return 'provider_contract_violation';
    case 'provider_contract_violation':
      return 'provider_contract_violation';
  }
}

/** How a failed call is explained on the quote. */
function failureBlockReason(kind: SupplierPreflightFailureKind): SupplierPreflightBlockReason {
  switch (kind) {
    case 'timeout':
      return 'provider_timeout';
    case 'rate_limited':
      return 'provider_rate_limited';
    case 'authentication_failed':
      return 'provider_unconfigured';
    case 'capability_missing':
      return 'capability_missing';
    case 'contract_violation':
      return 'provider_contract_violation';
    case 'provider_error':
    case 'transport_error':
      return 'provider_error';
  }
}

function sortUnique(
  reasons: readonly SupplierPreflightBlockReason[],
): readonly SupplierPreflightBlockReason[] {
  return [...new Set(reasons)].sort();
}
