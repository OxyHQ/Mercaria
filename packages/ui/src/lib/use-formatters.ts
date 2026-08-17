import { useMemo } from "react";
import type { Money, OfferMoney } from "@mercaria/shared-types";
import { useSharedUiLocale } from "../i18n/ui-translation";
import {
  formatDistance,
  formatMoney,
  formatPercent,
  formatRating,
  formatReviewCount,
  formatSourceMoney,
} from "./format";

/**
 * The display formatters, bound to the locale in force (#500).
 *
 * ## Why a hook and not a locale argument at every call site
 *
 * `./format`'s functions take a REQUIRED `locale`, which is what makes the
 * migration total — `tsc` refuses a call that omits it, so no screen can
 * silently keep rendering English. But a locale threaded by hand through 49
 * call sites is 49 chances to pass the wrong one, and every price would carry a
 * second argument whose value is the same everywhere. Binding it once per
 * component is the same shape `PriceDisplay` already uses for FX: the pure
 * function owns the arithmetic, and the ambient answer comes from context.
 *
 * ## Where the locale comes from, and why not from anywhere else
 *
 * `useSharedUiLocale` reads the value `SharedUiTranslationProvider` was handed
 * at the app root, from the SAME `useTranslation()` call that supplied `t`.
 * That is deliberate: a second source — a context of its own, a module-level
 * slot, or re-deriving it from the platform the way `useIsRtlLayout` reads back
 * `I18nManager.isRTL` — would be a second answer to "what language is this app
 * in", and the two can disagree. `useIsRtlLayout`'s own note is the precedent:
 * it refuses to re-derive direction from a locale for exactly this reason.
 *
 * Outside a provider the locale is `DEFAULT_LOCALE`, so a component rendered
 * off the root tree formats in English — the same fallback its COPY already
 * takes, rather than a different one.
 */
export interface Formatters {
  /** A `Money` in its own currency: `$148.00` in `en`, `$148,00` in `de`. */
  formatMoney: (money: Money) => string;
  /** An offer's own money, or `null` when its precision is unknown. */
  formatSourceMoney: (money: OfferMoney) => string | null;
  /** A coarse distance: `2.5 km` in `en`, `2,5 km` in `de`, `٢٫٥ كم` in `ar`. */
  formatDistance: (metres: number) => string;
  /** A review count, abbreviated as the locale abbreviates: `10.3K`, `1万`. */
  formatReviewCount: (n: number) => string;
  /** Basis points as a positive percentage: `8.2%` in `en`, `8,2 %` in `fr`. */
  formatPercent: (deltaBps: number) => string;
  /** A star rating to one decimal: `4.5` in `en`, `4,5` in `de`. */
  formatRating: (rating: number) => string;
}

export function useFormatters(): Formatters {
  const locale = useSharedUiLocale();
  // Memoised on the locale alone: these are pure functions of (value, locale),
  // so the bound set only has to change when the language does — which is also
  // exactly when every consumer must re-render anyway.
  return useMemo<Formatters>(
    () => ({
      formatMoney: (money) => formatMoney(money, locale),
      formatSourceMoney: (money) => formatSourceMoney(money, locale),
      formatDistance: (metres) => formatDistance(metres, locale),
      formatReviewCount: (n) => formatReviewCount(n, locale),
      formatPercent: (deltaBps) => formatPercent(deltaBps, locale),
      formatRating: (rating) => formatRating(rating, locale),
    }),
    [locale],
  );
}
