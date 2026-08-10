/**
 * How much of a retail order comes back, split into items, delivery, tax and
 * discount — pure arithmetic over the IMMUTABLE order and its prior refunds
 * (#127 §"Refunds" rules 2 and 4).
 *
 * ## Why the split is explicit rather than one total
 *
 * Rule 4 asks for *item, shipping, tax and discount allocations explicitly*, and
 * "explicitly" is the whole point: a single number cannot say whether delivery
 * came back, and whether delivery comes back is the difference between a
 * cancellation and a return in every consumer regime there is. A buyer who
 * withdraws gets the outbound delivery charge back under the EU CRD; a buyer
 * returning one shirt from a three-shirt parcel does not.
 *
 * ## Everything is computed from the ORDER, never from a request
 *
 * Rule 2 is *"calculate from immutable customer order and prior-refund
 * snapshots"*. The inputs below are the order's own line amounts, its totals and
 * the sum of what has already been refunded — none of which a request can move.
 * A request supplies only WHICH lines and HOW MANY units, and both are frozen by
 * trigger before this ever runs.
 *
 * ## No FX, ever
 *
 * Every figure is in the order's PRESENTMENT currency, which is what the buyer
 * paid and what a refund returns to their card. This module imports no FX
 * service and a scanned gate asserts it: converting a refund would mean the
 * amount returned differed from the amount charged by a rate that moved in
 * between, which is a loss somebody has to absorb and nobody agreed to.
 */

import type { CurrencyCode, RetailRefundAllocation } from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';

/** One order line, as the allocation reads it. */
export interface RetailRefundOrderLine {
  readonly orderItemId: string;
  readonly quantity: number;
  /** The line's own total in presentment minor units, BEFORE its discount. */
  readonly lineTotalMinor: number;
  /** What the line's item-level discount already took off it. */
  readonly discountTotalMinor: number;
  /** Tax attributed to this line, in presentment minor units. */
  readonly taxMinor: number;
}

/** The order-level figures an allocation may draw on. */
export interface RetailRefundOrderTotals {
  readonly currency: CurrencyCode;
  /** What the buyer paid for delivery. Zero on a retail order today (#126). */
  readonly deliveryMinor: number;
  /** What has already been refunded against this order, in the same currency. */
  readonly alreadyRefundedMinor: number;
  /** The order's grand total — the ceiling every allocation is clamped to. */
  readonly grandTotalMinor: number;
}

/** How many units of which line are coming back. */
export interface RetailRefundUnits {
  readonly orderItemId: string;
  readonly quantity: number;
}

/**
 * Whether the outbound delivery charge is returned.
 *
 * A CANCELLATION returns it: the parcel was never carried, so charging for
 * carriage would be charging for nothing. A RETURN does not: the parcel was
 * carried, and whether Mercaria absorbs that is a policy decision nobody has
 * taken — #110 drew the same line for the same reason, and a merchant who wants
 * to be generous issues a further refund rather than having the engine decide.
 *
 * The exception is a SELLER-FAULT return. A buyer who was sent the wrong item, a
 * broken one or nothing at all did not choose to send a parcel back, and making
 * them pay the outbound carriage for Mercaria's mistake is the shape of refund
 * that generates a chargeback. That is a policy Mercaria states rather than one
 * the law forces, which is why it is a named set here rather than a branch.
 */
export const RETAIL_DELIVERY_REFUNDING_KINDS: readonly string[] = [
  'pre_acceptance_cancellation',
  'pre_dispatch_cancellation',
  'withdrawal_return',
  'damaged_on_arrival',
  'wrong_item',
  'missing_item',
  'delivery_failure',
  'return_to_sender',
  'safety_recall',
];

/**
 * Split one refund into its four components.
 *
 * ## Proration is by UNITS, and the residue goes to the last line
 *
 * A line of three units at 1000 minor units refunds 333 per unit and 1000 for
 * all three, never 999 — the whole-line case is computed as the whole line
 * rather than as three thirds. Partial lines prorate `floor(lineTotal * n / q)`
 * and the arithmetic is stated rather than left to a rounding mode, because
 * "the buyer is refunded one minor unit less than they paid" is the class of
 * bug that is discovered by a customer and never by a test.
 *
 * ## The ceiling is what stops a double refund
 *
 * `alreadyRefundedMinor` is subtracted from the grand total and the result is
 * the most this refund may be. #127 acceptance 3 — *"duplicate requests and
 * reordered provider events cannot double-refund"* — has three layers and this
 * is the arithmetic one; the other two are the request's own idempotency key and
 * `refunds.idempotency_key`, and none of the three covers the others.
 */
export function composeRetailRefundAllocation(input: {
  readonly kind: string;
  readonly lines: readonly RetailRefundOrderLine[];
  readonly units: readonly RetailRefundUnits[];
  readonly totals: RetailRefundOrderTotals;
}): RetailRefundAllocation {
  const byId = new Map(input.lines.map((line) => [line.orderItemId, line]));
  let itemsMinor = 0;
  let taxMinor = 0;
  let discountMinor = 0;

  for (const unit of input.units) {
    const line = byId.get(unit.orderItemId);
    if (line === undefined || unit.quantity <= 0) continue;
    const taken = Math.min(unit.quantity, line.quantity);
    if (taken === line.quantity) {
      // The whole line, computed as the whole line. Three thirds of 1000 is 999.
      itemsMinor += line.lineTotalMinor;
      taxMinor += line.taxMinor;
      discountMinor -= line.discountTotalMinor;
      continue;
    }
    // A partial line. Each component is prorated independently; the ITEM side is
    // FLOORED and the DISCOUNT side CEILED, so both roundings move the net
    // downwards. The residue stays with Mercaria, which is the only direction
    // that cannot over-refund — and over-refunding is the one that cannot be
    // corrected without asking a buyer for money back.
    itemsMinor += Math.floor((line.lineTotalMinor * taken) / line.quantity);
    taxMinor += Math.floor((line.taxMinor * taken) / line.quantity);
    discountMinor -= Math.ceil((line.discountTotalMinor * taken) / line.quantity);
  }

  const deliveryMinor = RETAIL_DELIVERY_REFUNDING_KINDS.includes(input.kind)
    ? input.totals.deliveryMinor
    : 0;

  // The four members SUM to what is refunded — `retailRefundAllocationTotal` is
  // the only place that arithmetic is written, and `discountMinor` is negative
  // so a caller cannot add it by mistake. `itemsMinor` is therefore the GROSS
  // line figure: netting it here as well would subtract the discount twice, and
  // the second subtraction is invisible in a breakdown that still adds up.
  const total = itemsMinor + deliveryMinor + taxMinor + discountMinor;
  const ceiling = Math.max(0, input.totals.grandTotalMinor - input.totals.alreadyRefundedMinor);
  if (total <= ceiling) {
    assertSafeMoneyAmount(Math.max(0, total), 'retail refund allocation');
    return { currency: input.totals.currency, itemsMinor, deliveryMinor, taxMinor, discountMinor };
  }

  // Over the ceiling. Clamp the ITEM component, which is the only one a
  // proration could have overstated, and leave delivery and tax intact — a buyer
  // owed the carriage charge is owed all of it or none of it.
  const clampedItems = Math.max(0, ceiling - deliveryMinor - taxMinor - discountMinor);
  assertSafeMoneyAmount(
    Math.max(0, clampedItems + deliveryMinor + taxMinor + discountMinor),
    'retail refund allocation',
  );
  return {
    currency: input.totals.currency,
    itemsMinor: clampedItems,
    deliveryMinor,
    taxMinor,
    discountMinor,
  };
}
