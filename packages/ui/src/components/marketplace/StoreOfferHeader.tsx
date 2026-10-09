import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import type { DiscountSummary, StoreSummary } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { IncentiveHalo } from "./IncentiveHalo";
import { merchantImageSource } from "../../lib/shop-merchant-images";
import { useFormatters } from "../../lib/use-formatters";
import { formatPercent } from "../../lib/format";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";

export interface StoreOfferHeaderProps {
  store: StoreSummary;
  discount: DiscountSummary;
  onPress: () => void;
}

/** Shop's offer shelf header: store identity, saving, then its qualifying
 * subtotal. These are the store discount's native amounts, not item markdowns. */
export function StoreOfferHeader({ store, discount, onPress }: StoreOfferHeaderProps) {
  const t = useSharedUiTranslation();
  const { formatMoney } = useFormatters();
  const locale = useSharedUiLocale();
  // Stored rates have basis-point precision. Preserve fractional rates without
  // forcing a trailing decimal onto whole percentages.
  const digits = Number.isInteger(discount.percentOff) ? 0
    : Number.isInteger((discount.percentOff ?? 0) * 10) ? 1 : 2;
  const saving = discount.percentOff !== undefined
    ? t("ui.productCard.discount", { percent: formatPercent(discount.percentOff * 100, locale, digits) })
    : discount.amountOff
      ? t("ui.storeOffer.amountOff", { amount: formatMoney(discount.amountOff) })
      : undefined;
  const condition = saving && discount.minimumSubtotal
    ? t("ui.storeOffer.minimumSubtotal", { amount: formatMoney(discount.minimumSubtotal) })
    : undefined;
  const logo = (
    <View className="size-space-44 items-center justify-center overflow-hidden rounded-radius-max border-[0.5px] border-border-image bg-bg-fill-secondary">
      {store.logoUrl ? (
        <Image source={merchantImageSource(store.logoUrl)} contentFit="cover"
          style={{ width: 44, height: 44 }} />
      ) : (
        <Text className="text-shop-bodyTitleLarge text-text">{Array.from(store.name)[0]}</Text>
      )}
    </View>
  );

  return (
    <Pressable accessibilityRole="link" onPress={onPress}
      accessibilityLabel={[store.name, saving, condition].filter(Boolean).join(". ")}
      className="w-full flex-row items-center gap-space-12"
      testID="store-offer-header">
      <View className="shrink-0 p-space-4">
        {discount.exclusive ? <IncentiveHalo>{logo}</IncentiveHalo> : logo}
      </View>
      <View className="min-w-0 flex-1 gap-space-4">
        <Text numberOfLines={1} className="text-shop-subtitle text-text md:text-shop-sectionTitle">
          {store.name}
        </Text>
        {saving ? (
          <Text numberOfLines={1} className="text-shop-bodySmall" testID="store-offer-saving">
            <Text className="text-text-brand">{saving}</Text>
            {condition ? <Text className="text-text-tertiary">{` ${condition}`}</Text> : null}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
