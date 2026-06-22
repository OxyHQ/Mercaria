import { View } from "react-native";
import {
  CURRENCY_PRECISION,
  CURRENCY_SYMBOLS,
  type CurrencyCode,
  type Money,
} from "@mercaria/shared-types";
import { Text } from "./ui/text";
import { cn } from "../lib/cn";
import { formatMoney } from "../lib/format";
import { useFx } from "./FxContext";

/** Radix used to derive a currency's major value from its decimal precision. */
const DECIMAL_RADIX = 10;
/** Fraction digits shown for the secondary fiat figure (clean 2dp display). */
const SECONDARY_FRACTION_DIGITS = 2;
/** Prefix marking the secondary figure as an approximate conversion. */
const APPROX_PREFIX = "≈ ";

export interface PriceDisplayProps {
  /** The canonical price (FAIR). The primary figure is always this amount. */
  price: Money;
  /** Optional classes for the wrapping row. */
  className?: string;
  /** Optional classes for the primary (FAIR) figure. */
  primaryClassName?: string;
  /** Optional classes for the secondary (converted fiat) figure. */
  secondaryClassName?: string;
}

/**
 * Convert the FAIR major value to a secondary currency using a display-side
 * rate (units of the secondary currency per 1 FAIR) and format it with the
 * secondary currency's symbol and 2dp. Presentation-only — never re-quantizes
 * stored money.
 */
function formatSecondary(price: Money, currency: CurrencyCode, rate: number): string {
  const fairMajor = price.amount / DECIMAL_RADIX ** CURRENCY_PRECISION[price.currency];
  const secondaryMajor = fairMajor * rate;
  return `${CURRENCY_SYMBOLS[currency]}${secondaryMajor.toFixed(SECONDARY_FRACTION_DIGITS)}`;
}

/**
 * Dual-currency price label. Always renders the canonical FAIR figure
 * (`⊜X.XX`). When dual display is enabled, a secondary currency is selected,
 * and a rate for it is available, it additionally renders an approximate
 * converted fiat figure (`≈ <symbol>Y.YY`). Purely presentational: it reads the
 * display-side FX state from context and never fetches.
 */
export function PriceDisplay({
  price,
  className,
  primaryClassName,
  secondaryClassName,
}: PriceDisplayProps) {
  const { secondaryCurrency, dualDisplayEnabled, rates } = useFx();

  const rate =
    secondaryCurrency !== null ? rates[secondaryCurrency] : undefined;
  const showSecondary =
    dualDisplayEnabled && secondaryCurrency !== null && rate !== undefined;

  return (
    <View className={cn("flex-row items-baseline gap-1", className)}>
      <Text className={cn("text-sm font-semibold text-foreground", primaryClassName)}>
        {formatMoney(price)}
      </Text>
      {showSecondary ? (
        <Text className={cn("text-xs text-muted-foreground", secondaryClassName)}>
          {`${APPROX_PREFIX}${formatSecondary(price, secondaryCurrency, rate)}`}
        </Text>
      ) : null}
    </View>
  );
}
