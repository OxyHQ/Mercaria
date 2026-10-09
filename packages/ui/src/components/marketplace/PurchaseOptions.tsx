import { useEffect } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { Button } from "@oxy.so/bloom/button";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { useShopControlClassName } from "../../lib/useShopControlClassName";

export interface PurchaseOptionsProps {
  canBuy: boolean;
  isPending: boolean;
  /** A selected unavailable variant is sold out, not an incomplete selection. */
  hasSelection?: boolean;
  added?: boolean;
  onAddToCart: () => void;
  onBuyNow: () => void;
}

/** Shop slides two full-height labels inside the purchase button after success.
 * Keep the animated copy decorative: the button's accessible label owns state. */
function AddToCartLabel({ added }: { added: boolean }) {
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
          <Text className="text-shop-buttonLarge text-white">{t("ui.purchase.addToCart")}</Text>
        </View>
        <View style={{ height: 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 }}>
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
            <Path d="M15 9.5L10.5 15L8.5 13M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="white" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          <Text className="text-shop-buttonLarge text-white">{t("ui.purchase.added")}</Text>
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
  const controlClassName = useShopControlClassName();
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
        className={controlClassName("primary", !canBuy, isPending)}
      >
        {canBuy ? <AddToCartLabel added={added} /> : label}
      </Button>
      {canBuy ? (
        <Button
          material="flat"
          accessibilityLabel={t("ui.purchase.buyNow")}
          disabled={isPending}
          onPress={onBuyNow}
          className={controlClassName("secondary", isPending)}
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
