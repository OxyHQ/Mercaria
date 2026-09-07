import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Text } from "../ui/text";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  MARKETPLACE_VISIT_MERCHANT_KEY,
  STORE_OFFER_HEADER_MINIMUM_KEY,
  STORE_OFFER_HEADER_SAVE_KEY,
} from "../../lib/marketplace-labels";
import { useFormatters } from "../../lib/use-formatters";
import { formatPercent } from "../../lib/format";
import { IncentiveHalo } from "./IncentiveHalo";
import type { DiscountSummary, StoreSummary } from "@mercaria/shared-types";

/** `formatPercent` reads BASIS POINTS; `DiscountSummary.percentOff` is a whole percent — the same conversion `DiscountBadge` applies to the same field. */
const BASIS_POINTS_PER_PERCENT = 100;

export interface StoreOfferHeaderProps {
  store: StoreSummary;
  discount: DiscountSummary;
  onPress?: (handle: string) => void;
}

/**
 * One store's row on the deals page — the reference's per-store offer header:
 * the store's logo (haloed when `discount.exclusive`), its name, and the offer
 * line underneath.
 *
 * ## The offer line is two colours on one line, and neither half is composed here
 *
 * `DiscountSummary` carries `percentOff` XOR `amountOff`, plus an optional
 * `minimumSubtotal`. The saving renders brand-coloured
 * ({@link STORE_OFFER_HEADER_SAVE_KEY}); the threshold that qualifies it
 * renders tertiary ({@link STORE_OFFER_HEADER_MINIMUM_KEY}) — but only beside
 * an AMOUNT-off saving, per the appendix's own reading of the reference: a
 * percentage discount renders the saving alone, never a threshold. Both keys
 * take the already-formatted figure (`formatPercent`/`formatMoney`) as their
 * one parameter, the same shape `DiscountBadge` uses for these same
 * `DiscountSummary` fields — no arithmetic or string composition happens in
 * this component.
 *
 * ## One `<Text>` with two nested runs, not two `View` siblings
 *
 * The reference renders the line as one `<span>` pair kept unwrapped with CSS
 * `whitespace-nowrap`. The installed `react-native-css` compiles no
 * `white-space` declaration at all — the same "recognises the class, emits
 * nothing" failure `bg-bg-overlay-*` already hit — so writing that class here
 * would silently do nothing and leave two `View` siblings free to wrap onto
 * separate lines. Nesting a `<Text>` inside a `<Text>` is React Native's own
 * mechanism for two differently-styled runs that must read as one line, and
 * `numberOfLines={1}` on the OUTER `Text` is what actually keeps the pair
 * together — the guarantee `whitespace-nowrap` was standing in for on web.
 *
 * ## The 44px logo
 *
 * `StoreProductCard`'s own store-row logo is 32px; this one is 44px. Measured
 * from the reference, not shared — a bigger logo is this header's whole job,
 * being the sole visual anchor for a store on the deals page rather than one
 * row under a product carousel.
 */
export function StoreOfferHeader({ store, discount, onPress }: StoreOfferHeaderProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();
  const { formatMoney } = useFormatters();

  const amount =
    discount.percentOff !== undefined
      ? formatPercent(discount.percentOff * BASIS_POINTS_PER_PERCENT, locale, 0)
      : discount.amountOff
        ? formatMoney(discount.amountOff)
        : undefined;

  // A percentage discount renders the saving alone — never the threshold,
  // even when one happens to be present.
  const minimum =
    discount.percentOff === undefined && discount.minimumSubtotal !== undefined
      ? formatMoney(discount.minimumSubtotal)
      : undefined;

  const logo = (
    <View className="h-[44px] w-[44px] items-center justify-center overflow-hidden rounded-radius-max border-[0.5px] border-border-image bg-bg-fill-tertiary">
      {store.logoUrl ? (
        <Image source={{ uri: store.logoUrl }} contentFit="cover" className="size-full" />
      ) : null}
    </View>
  );

  return (
    <View className="w-full flex-row">
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t(MARKETPLACE_VISIT_MERCHANT_KEY, { name: store.name })}
        onPress={() => onPress?.(store.handle)}
        className="w-full flex-1 flex-row items-center gap-space-8"
      >
        {discount.exclusive ? (
          <View className="-my-space-4 overflow-hidden rounded-radius-max p-space-2">
            <IncentiveHalo>{logo}</IncentiveHalo>
          </View>
        ) : (
          logo
        )}

        <View className="min-w-0 flex-1">
          <Text className="font-subtitle text-subtitle text-text md:text-sectionTitle">
            {store.name}
          </Text>

          {amount !== undefined ? (
            <Text numberOfLines={1} className="font-bodySmall text-bodySmall">
              <Text className="text-text-brand">{t(STORE_OFFER_HEADER_SAVE_KEY, { amount })}</Text>
              {minimum !== undefined ? (
                <Text className="text-text-tertiary">
                  {" "}
                  {t(STORE_OFFER_HEADER_MINIMUM_KEY, { minimum })}
                </Text>
              ) : null}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}
