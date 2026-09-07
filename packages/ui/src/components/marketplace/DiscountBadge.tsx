import { View } from "react-native";
import { Text } from "../ui/text";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  DISCOUNT_BADGE_SAVE_A11Y_KEY,
  DISCOUNT_BADGE_SAVE_KEY,
} from "../../lib/marketplace-labels";
import { useFormatters } from "../../lib/use-formatters";
import { formatPercent } from "../../lib/format";
import type { DiscountSummary } from "@mercaria/shared-types";

/** `formatPercent` reads BASIS POINTS; `DiscountSummary.percentOff` is a whole percent. */
const BASIS_POINTS_PER_PERCENT = 100;

export interface DiscountBadgeProps {
  discount: DiscountSummary;
}

/**
 * The brand-filled "Save X" pill over a discounted store's carousel image
 * (the reference's `shop-cash-badge`) — also reused on the deals shelves.
 *
 * Keeps the reference's SPLIT between an abbreviated visible fragment
 * ("Save 20%") and the full sentence a screen reader needs ("Save 20% with
 * your offer") — but not its MECHANISM. The reference hides the full
 * sentence with `sr-only`, a CSS recipe (`position:absolute`, a 1px box,
 * `clip`, `white-space:nowrap`); React Native has neither `clip` nor
 * `white-space`, so on native that text would not be hidden at all — the
 * badge would show both strings stacked. `sr-only` appears nowhere else in
 * this package, and that absence is the tell. The mechanism here instead is
 * `accessibilityLabel` on the (non-interactive, `accessible`) pill
 * container, carrying the full sentence, with the single visible `Text`
 * fragment marked `aria-hidden` so it is not announced a second time —
 * the same shape `MerchantCard.tsx` uses for its own accessible labels.
 * Neither string is composed here — both come from the `ui` namespace with
 * the already-formatted saving (`formatPercent`/`formatMoney`) as their one
 * parameter, so phrasing differences across percent vs. fixed-amount
 * discounts live in the bundles, never in this component.
 *
 * `DiscountSummary` guarantees exactly one of `percentOff`/`amountOff` is set
 * server-side (`toDiscountSummary` in `feed.service.ts`); if a malformed
 * payload carries neither, the badge renders nothing rather than a blank
 * "Save" with no figure.
 */
export function DiscountBadge({ discount }: DiscountBadgeProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();
  const { formatMoney } = useFormatters();

  const amount =
    discount.percentOff !== undefined
      ? formatPercent(discount.percentOff * BASIS_POINTS_PER_PERCENT, locale, 0)
      : discount.amountOff
        ? formatMoney(discount.amountOff)
        : undefined;

  if (amount === undefined) {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      className="absolute start-space-12 top-space-12 z-10 lg:start-space-16 lg:top-space-16"
    >
      <View
        accessible
        accessibilityLabel={t(DISCOUNT_BADGE_SAVE_A11Y_KEY, { amount })}
        className="flex-row items-center justify-center gap-space-2 rounded-radius-max bg-bg-fill-brand px-space-6 py-space-2"
      >
        <Text aria-hidden className="font-badgeBold text-badgeBold text-text-fixed-light">
          {t(DISCOUNT_BADGE_SAVE_KEY, { amount })}
        </Text>
      </View>
    </View>
  );
}
