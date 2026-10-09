import { useEffect } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
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

const BUTTON_LABEL = { fontSize: 16, fontWeight: "600" as const, letterSpacing: -0.5 };

/** Shop slides two full-height labels inside the purchase button after success.
 * Keep the animated copy decorative: the button's accessible label owns state. */
function AddToCartLabel({ added, color }: { added: boolean; color: string }) {
  const t = useSharedUiTranslation();
  const reduced = useReducedMotion();
  const progress = useSharedValue(added ? 1 : 0);
  useEffect(() => {
    const target = added ? 1 : 0;
    progress.value = reduced ? target : withDelay(150, withTiming(target, {
      duration: 300,
      easing: Easing.bezier(0.42, 0, 0.58, 1),
    }));
  }, [added, progress, reduced]);
  const motion = useAnimatedStyle(() => ({ transform: [{ translateY: -52 * progress.value }] }));
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: 52, width: "100%", overflow: "hidden" }}
    >
      <Animated.View testID="add-to-cart-label-motion" style={[{ height: 104 }, motion]}>
        <View style={{ height: 52, alignItems: "center", justifyContent: "center" }}>
          <Text className="text-shop-buttonLarge" style={{ color }}>{t("ui.purchase.addToCart")}</Text>
        </View>
        <View style={{ height: 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 }}>
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
            <Path d="M15 9.5L10.5 15L8.5 13M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          <Text className="text-shop-buttonLarge" style={{ color }}>{t("ui.purchase.added")}</Text>
        </View>
      </Animated.View>
    </View>
  );
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
        style={{ height: 52, minHeight: 52, borderRadius: 999, padding: 0, overflow: "hidden" }}
        textStyle={BUTTON_LABEL}
        colors={{
          background: colors.primary,
          foreground: colors.primaryForeground,
        }}
      >
        {canBuy ? <AddToCartLabel added={added} color={colors.primaryForeground} /> : label}
      </Button>
      {canBuy ? (
        <Button
          material="flat"
          accessibilityLabel={t("ui.purchase.buyNow")}
          disabled={isPending}
          onPress={onBuyNow}
          style={{ minHeight: 52, borderRadius: 999 }}
          textStyle={BUTTON_LABEL}
          colors={{
            background: colors.foreground,
            foreground: colors.background,
          }}
        >
          {t("ui.purchase.buyNow")}
        </Button>
      ) : null}
      <Text accessibilityLiveRegion="polite" className="sr-only">
        {added ? t("ui.purchase.added") : ""}
      </Text>
    </View>
  );
}
