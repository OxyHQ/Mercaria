/**
 * One comparison, one currency, and a captured quote for every conversion (#74
 * ranking input 1, acceptance 8).
 *
 * PURE: the rates arrive as an argument, so a currency case is a table of inputs
 * rather than a live FX call, and a property test can vary a rate without a
 * network.
 *
 * ## Raw minor units are never compared across currencies
 *
 * An offer's price is `OfferMoney`, whose currency is a STRING the source
 * published and which may sit outside `CurrencyCode` entirely (#57 states that
 * exception deliberately). So every comparison here goes through exactly one
 * path: convert into the comparison currency, or answer that it could not be
 * converted. There is no branch that compares `amount` fields, and none may be
 * added — 12000 JPY and 12000 EUR are not the same number, and a sort that
 * treated them as one would put the cheapest offer last on most product pages
 * without any error anywhere.
 *
 * ## An unconvertible price is UNKNOWN, not excluded and not zero
 *
 * It is not a fact about the offer that Mercaria has no rate for its currency,
 * so the offer keeps its place in the list, its price signal reports
 * `not_convertible`, and it can never carry a `cheapest_*` label — the same
 * treatment every other unknown gets, arrived at through the type rather than
 * through a branch anybody has to remember.
 */

import {
  ALL_CURRENCY_CODES,
  assertSafeMoneyAmount,
  type CurrencyCode,
  type FxRates,
  type FxRateSnapshot,
  type Money,
  type OfferComparisonPrice,
  type OfferComparisonTotal,
  type OfferMoney,
} from '@mercaria/shared-types';
import { convert, pairRate } from '../fx.service.js';

/** Whether a source-published currency string is one Mercaria can price in. */
function asCurrencyCode(currency: string): CurrencyCode | null {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(currency)
    ? (currency as CurrencyCode)
    : null;
}

/**
 * Whether `rates` can quote this currency at all.
 *
 * Asked BEFORE `convert` rather than by catching its throw. `fx.service`
 * deliberately throws instead of fabricating a rate, and a `try`/`catch` around
 * a conversion would make a missing rate indistinguishable from a bug in the
 * arithmetic — which is the shape a silent `catch {}` takes when somebody later
 * tidies it.
 */
function canQuote(currency: CurrencyCode, rates: FxRates): boolean {
  if (currency === rates.base) return true;
  const rate = rates.rates[currency];
  return rate !== undefined && rate > 0;
}

/**
 * Convert one offer money into the comparison currency, capturing the quote.
 *
 * The `known` branch carries the {@link Money} AND the `FxRateSnapshot` that
 * produced it, so the comparison a shopper saw stays reproducible after the rate
 * moves — #44's rule for a stored amount, applied to a derived one.
 */
export function convertOfferMoney(
  money: OfferMoney | undefined,
  target: CurrencyCode,
  rates: FxRates,
): OfferComparisonPrice {
  if (money === undefined) return { known: false, reason: 'not_published' };

  const source = asCurrencyCode(money.currency);
  if (source === null) return { known: false, reason: 'not_convertible' };
  if (!canQuote(source, rates) || !canQuote(target, rates)) {
    return { known: false, reason: 'not_convertible' };
  }

  const amount = convert({ amount: money.amount, currency: source }, target, rates);
  return {
    known: true,
    amount,
    fx: {
      from: source,
      to: target,
      rate: pairRate(source, target, rates),
      provider: rates.provider,
      asOf: rates.asOf,
    },
  };
}

/**
 * Item plus delivery, or an honest statement of which half is missing.
 *
 * This is the function `cheapest_known_total` depends on, and its unknown branch
 * has no `amount` — so an offer with unknown shipping produces a value the label
 * writer's parameter type will not accept. That is #74 acceptance 2 held by the
 * compiler rather than by a guard somebody could invert.
 */
export function composeComparisonTotal(
  itemPrice: OfferComparisonPrice,
  deliveryCost: OfferComparisonPrice,
): OfferComparisonTotal {
  if (!itemPrice.known || !deliveryCost.known) {
    return {
      known: false,
      missing: [
        ...(itemPrice.known ? [] : (['item_price'] as const)),
        ...(deliveryCost.known ? [] : (['delivery_cost'] as const)),
      ],
    };
  }

  const amount = itemPrice.amount.amount + deliveryCost.amount.amount;
  assertSafeMoneyAmount(amount, `ranking.composeComparisonTotal(${itemPrice.amount.currency})`);
  const total: Money = { amount, currency: itemPrice.amount.currency };
  return { known: true, amount: total };
}

/**
 * Deduplicate the snapshots a comparison used, one per distinct pair.
 *
 * A page of forty offers from six currencies captures six quotes, not forty —
 * and the reader of a comparison needs to see every rate that was applied, which
 * is what makes it reproducible.
 */
export function collectRateSnapshots(
  prices: readonly OfferComparisonPrice[],
): readonly FxRateSnapshot[] {
  const seen = new Map<string, FxRateSnapshot>();
  for (const price of prices) {
    if (!price.known) continue;
    seen.set(`${price.fx.from}->${price.fx.to}`, price.fx);
  }
  return [...seen.values()];
}
