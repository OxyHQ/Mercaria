import { View } from "react-native";
import {
  CURRENCY_PRECISION,
  type CurrencyCode,
  type Money,
} from "@mercaria/shared-types";
import { Text } from "./ui/text";
import { cn } from "../lib/cn";
import { formatMoney } from "../lib/format";
import { useFx } from "./FxContext";

/** Radix used to convert between a currency's major value and its minor units. */
const DECIMAL_RADIX = 10;
/** Prefix marking the secondary figure as an approximate conversion. */
const APPROX_PREFIX = "≈ ";
/** The canonical pivot currency — every display rate is quoted per 1 FAIR. */
const FAIR: CurrencyCode = "FAIR";

/**
 * FAIR-pivot rate for `currency`: the number of units of `currency` per 1 FAIR.
 * FAIR is itself the pivot, so its rate is exactly 1; every other code is looked
 * up in the display-side `rates` map. Returns `undefined` when no rate is known.
 */
function fairPivotRate(
  currency: CurrencyCode,
  rates: Record<string, number>,
): number | undefined {
  return currency === FAIR ? 1 : rates[currency];
}

/**
 * Convert a stored `Money` (any native currency) into `target` via the FAIR
 * pivot — `targetMajor = nativeMajor / rate[native] * rate[target]` — then
 * re-quantize to the target currency's integer minor units. Returns the input
 * unchanged when it is already in `target` (no float round-trip), and `null`
 * when a needed rate is missing so the caller can fall back to the native amount
 * rather than fabricate a figure. Presentation-only; never mutates stored money.
 */
function convertMoney(
  price: Money,
  target: CurrencyCode,
  rates: Record<string, number>,
): Money | null {
  if (price.currency === target) {
    return price;
  }
  const nativeRate = fairPivotRate(price.currency, rates);
  const targetRate = fairPivotRate(target, rates);
  if (nativeRate === undefined || targetRate === undefined || nativeRate === 0) {
    return null;
  }
  const nativeMajor = price.amount / DECIMAL_RADIX ** CURRENCY_PRECISION[price.currency];
  const targetMajor = (nativeMajor / nativeRate) * targetRate;
  const targetMinor = Math.round(targetMajor * DECIMAL_RADIX ** CURRENCY_PRECISION[target]);
  return { amount: targetMinor, currency: target };
}

export interface PriceDisplayProps {
  /**
   * The stored price in its NATIVE currency (FAIR, or a store's own fiat). It is
   * converted to the shopper's chosen display currency for the primary figure.
   */
  price: Money;
  /** Optional classes for the wrapping row. */
  className?: string;
  /** Optional classes for the primary (display-currency) figure. */
  primaryClassName?: string;
  /** Optional classes for the secondary (converted fiat) figure. */
  secondaryClassName?: string;
}

/**
 * Dual-currency price label. Renders the stored `price` converted into the
 * shopper's chosen PRIMARY display currency (FAIR by default) as the main
 * figure, and — when dual display is enabled and a distinct secondary currency
 * is chosen — an approximate converted secondary figure (`≈ <symbol>Y.YY`).
 * Conversion pivots through FAIR using the context rates; a missing rate falls
 * back gracefully to the native amount. Purely presentational: it reads the
 * display-side FX state from context and never fetches.
 */
export function PriceDisplay({
  price,
  className,
  primaryClassName,
  secondaryClassName,
}: PriceDisplayProps) {
  const { primaryCurrency, secondaryCurrency, dualDisplayEnabled, rates } = useFx();

  // Primary: convert to the shopper's display currency; if a needed rate is
  // missing, gracefully render the native amount rather than crash or fabricate.
  const primaryMoney = convertMoney(price, primaryCurrency, rates) ?? price;

  // Secondary: only when enabled, a distinct secondary is chosen (no point
  // showing the same currency twice), and it can actually be converted.
  const secondaryMoney =
    dualDisplayEnabled &&
    secondaryCurrency !== null &&
    secondaryCurrency !== primaryMoney.currency
      ? convertMoney(price, secondaryCurrency, rates)
      : null;

  return (
    <View className={cn("flex-row items-baseline gap-1", className)}>
      <Text className={cn("text-sm font-semibold text-foreground", primaryClassName)}>
        {formatMoney(primaryMoney)}
      </Text>
      {secondaryMoney !== null ? (
        <Text className={cn("text-xs text-muted-foreground", secondaryClassName)}>
          {`${APPROX_PREFIX}${formatMoney(secondaryMoney)}`}
        </Text>
      ) : null}
    </View>
  );
}
