import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { useColorScheme } from "../../lib/useColorScheme";

export interface PurchaseOptionsProps {
  canBuy: boolean;
  isPending: boolean;
  /** A selected unavailable variant is sold out, not an incomplete selection. */
  hasSelection?: boolean;
  added?: boolean;
  onAddToCart: () => void;
  onBuyNow: () => void;
}

/** The standard Shop purchase stack. Selling plans must come from commerce
 * data; a decorative subscription selector cannot promise a recurring order. */
export function PurchaseOptions({
  canBuy,
  isPending,
  hasSelection = true,
  added = false,
  onAddToCart,
  onBuyNow,
}: PurchaseOptionsProps) {
  const t = useSharedUiTranslation();
  const { colors } = useColorScheme();
  const label = !canBuy
    ? t(hasSelection ? "ui.purchase.soldOut" : "ui.purchase.selectOptions")
    : t(added ? "ui.purchase.added" : "ui.purchase.addToCart");
  return (
    <View className="gap-space-8" testID="product-purchase-actions">
      <Button
        material="flat"
        accessibilityLabel={label}
        disabled={!canBuy || isPending}
        loading={isPending}
        onPress={onAddToCart}
        style={{ minHeight: 52, borderRadius: 999 }}
        colors={{
          background: colors.primary,
          foreground: colors.primaryForeground,
        }}
      >
        {label}
      </Button>
      {canBuy ? (
        <Button
          material="flat"
          accessibilityLabel={t("ui.purchase.buyNow")}
          disabled={isPending}
          onPress={onBuyNow}
          style={{ minHeight: 52, borderRadius: 999 }}
          colors={{
            background: colors.foreground,
            foreground: colors.background,
          }}
        >
          {t("ui.purchase.buyNow")}
        </Button>
      ) : null}
      {added ? (
        <Text
          accessibilityLiveRegion="polite"
          className="text-caption text-text-secondary"
        >
          {t("ui.purchase.added")}
        </Text>
      ) : null}
    </View>
  );
}
