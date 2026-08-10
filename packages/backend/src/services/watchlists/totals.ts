/**
 * The basket arithmetic (#81 item rules 4–6, basket rules 1–2). PURE, and every
 * rule this issue exists for lives here.
 *
 * ## Raw minor units are never added across currencies
 *
 * Every amount reaching this file has ALREADY been converted into the list's
 * display currency by #74's comparison, each carrying the `FxRateSnapshot` that
 * converted it. What this file adds is integer minor units of ONE currency, and
 * {@link composeWatchlistTotal} asserts that: a line whose currency is not the
 * display currency is a defect in the composition, not something to coerce, so
 * it throws rather than being skipped. Skipping it would be the quiet exclusion
 * the whole issue is about, wearing a defensive check's clothing.
 *
 * ## The basis belongs to the TOTAL, not to a line
 *
 * #81 basket rule 1 asks for "only comparable amounts with a named basis". Two
 * lines are comparable when they measure the same thing, so the total picks the
 * strongest basis EVERY contributing line can satisfy:
 *
 *  - every priced line knows its delivery cost → `delivered_total`;
 *  - otherwise → `item_price`, and delivery is excluded from ALL of them.
 *
 * The alternative — take the delivered total where it is known and the bare item
 * price where it is not — produces a number that is neither, and it is the
 * number a buyer would most easily mistake for what they will actually pay.
 * Dropping the lines with unknown delivery instead would quietly shrink the
 * basket, which is the failure #81 item rule 7 names.
 *
 * ## Unknown is never zero, and the types are what say so
 *
 * A line with unknown delivery has no delivery amount to read (#57's
 * `deriveOfferDelivery` shape, carried through #74's `OfferComparisonPrice` and
 * this domain's {@link WatchlistDeliveryComponent}), so `delivered_total` is
 * unreachable for a set containing one without writing a coercion out loud —
 * which nothing here does.
 */

import {
  assertSafeMoneyAmount,
  hasKnownDelivery,
  type CurrencyCode,
  type Money,
  type WatchlistBasketBasis,
  type WatchlistBasketTotal,
  type WatchlistDeliveryComponent,
  type WatchlistItemTarget,
  type WatchlistTargetStatus,
} from '@mercaria/shared-types';

/** One priced line, reduced to what the arithmetic needs. */
export interface WatchlistTotalLine {
  readonly lineItemPrice: Money;
  readonly delivery: WatchlistDeliveryComponent;
}

/**
 * `unit × quantity`, in minor units, asserted representable.
 *
 * The assertion is the point rather than a formality: `Money.amount` is a
 * JavaScript `number`, and a quantity of 999 against a FAIR price at eight
 * decimals is exactly the shape that walks past `Number.MAX_SAFE_INTEGER` while
 * still looking like an integer. `assertSafeMoneyAmount` names the construction
 * site so a breach is traceable to the line that produced it, not to the INSERT
 * that rejected it.
 */
export function multiplyMoneyByQuantity(unit: Money, quantity: number, context: string): Money {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`${context}: quantity must be a positive integer, received ${quantity}`);
  }
  assertSafeMoneyAmount(unit.amount, `${context}.unit`);
  const amount = unit.amount * quantity;
  assertSafeMoneyAmount(amount, `${context}.line`);
  return { amount, currency: unit.currency };
}

/**
 * The strongest basis every priced line can satisfy.
 *
 * An EMPTY set answers `item_price`, which never reaches a total: with no lines
 * there is nothing to sum and {@link composeWatchlistTotal} returns the unknown
 * branch before the basis is used. Answering `delivered_total` for an empty set
 * would be vacuously true and would put the stronger claim on a page describing
 * nothing.
 */
export function resolveWatchlistBasis(
  lines: readonly WatchlistTotalLine[],
): WatchlistBasketBasis {
  if (lines.length === 0) return 'item_price';
  return lines.every((line) => hasKnownDelivery(line.delivery)) ? 'delivered_total' : 'item_price';
}

/** What {@link composeWatchlistTotal} needs to know about the whole list. */
export interface WatchlistTotalInput {
  readonly displayCurrency: CurrencyCode;
  /** Every line that WAS priced, in list order. */
  readonly pricedLines: readonly WatchlistTotalLine[];
  /** How many items the list holds in total — priced and not. */
  readonly totalItems: number;
}

/**
 * Sum the priced lines under one named basis, and say how much of the list that
 * covers.
 *
 * `complete` requires that every item in the list contributed. It is deliberately
 * NOT "every item we could price contributed", which would be true of every
 * basket ever computed and would make the label meaningless at exactly the
 * moment it matters.
 */
export function composeWatchlistTotal(input: WatchlistTotalInput): WatchlistBasketTotal {
  if (input.pricedLines.length === 0) return { known: false, completeness: 'unknown' };

  const basis = resolveWatchlistBasis(input.pricedLines);

  let amount = 0;
  for (const line of input.pricedLines) {
    if (line.lineItemPrice.currency !== input.displayCurrency) {
      throw new Error(
        `Refusing to sum a watchlist line denominated in ${line.lineItemPrice.currency} into a ` +
          `${input.displayCurrency} total. Every amount reaching the total is converted by the ` +
          'comparison that produced it; a line in another currency means the conversion was ' +
          'skipped, and adding its minor units would produce a number in no currency at all.',
      );
    }
    amount += line.lineItemPrice.amount;
    if (basis === 'delivered_total' && hasKnownDelivery(line.delivery)) {
      if (line.delivery.line.currency !== input.displayCurrency) {
        throw new Error(
          `Refusing to sum a watchlist delivery cost denominated in ${line.delivery.line.currency} ` +
            `into a ${input.displayCurrency} total.`,
        );
      }
      amount += line.delivery.line.amount;
    }
  }
  assertSafeMoneyAmount(amount, 'watchlist.basketTotal');

  const excludedItems = input.totalItems - input.pricedLines.length;
  return {
    known: true,
    completeness: excludedItems === 0 ? 'complete' : 'partial',
    basis,
    amount: { amount, currency: input.displayCurrency },
    includedItems: input.pricedLines.length,
    excludedItems,
  };
}

/**
 * Whether one item's target was reached — and whether the question can be asked
 * at all.
 *
 * A target in a currency the list is not displayed in is `not_comparable`, never
 * converted. Converting it would make "you reached your target" depend on a rate
 * movement rather than on a price, which is #80's reference-price rule applied
 * to a threshold: the buyer set a number in a currency they think in, and a
 * notification that fires because the euro moved is a notification about the
 * wrong thing.
 *
 * The comparison is against the UNIT price rather than the line total, because a
 * target is a statement about what one of the things is worth — a buyer who
 * raises the quantity has not raised what they are willing to pay each.
 */
export function resolveWatchlistTarget(
  target: WatchlistItemTarget | undefined,
  currentUnitPrice: Money | undefined,
): WatchlistTargetStatus {
  if (target === undefined) return { state: 'no_target' };
  if (currentUnitPrice === undefined) {
    // A target on an item nothing could price is not "not reached" — nobody
    // measured it. Reporting it as unreached would put a red figure beside an
    // item whose price is simply unknown.
    return { state: 'not_comparable', reason: 'item_not_priced' };
  }
  if (target.currency !== currentUnitPrice.currency) {
    return { state: 'not_comparable', reason: 'target_currency_mismatch' };
  }
  const targetMoney: Money = { amount: target.amount, currency: target.currency };
  return currentUnitPrice.amount <= target.amount
    ? { state: 'reached', target: targetMoney, currentUnitPrice }
    : { state: 'not_reached', target: targetMoney, currentUnitPrice };
}
