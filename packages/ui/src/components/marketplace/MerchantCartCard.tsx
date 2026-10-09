import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import type { CartGroup, CartVendor } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  MARKETPLACE_VISIT_MERCHANT_KEY,
  MERCHANT_CART_CHECKOUT_KEY,
  MERCHANT_CART_SUBTOTAL_KEY,
} from "../../lib/marketplace-labels";
import { commercialSellerLabel } from "../../lib/commercial-copy";
import { PriceDisplay } from "../PriceDisplay";

export interface MerchantCartCardProps {
  group: CartGroup;
  onPressVendor: (vendor: CartVendor) => void;
  onCheckout: (group: CartGroup) => void;
}

/** Shop's 330px cart shelf: seller column, 64px thumbnail stack, pill action. */
export function MerchantCartCard({
  group,
  onPressVendor,
  onCheckout,
}: MerchantCartCardProps) {
  const t = useSharedUiTranslation();
  const totalQuantity = group.items.reduce((n, item) => n + item.quantity, 0);
  const thumbnails = group.items.slice(0, 2);
  const sellerName = commercialSellerLabel(t, group.commercial);
  return (
    <View
      testID="merchant-cart-card"
      className="w-full rounded-[28px] border border-black/10 bg-card p-4 dark:border-white/15"
      style={{ boxShadow: "0px 2px 8px rgba(0,0,0,0.06)" }}
    >
      <View className="mb-4 flex-row gap-2">
        <View className="min-w-0 flex-1 gap-2">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t(MARKETPLACE_VISIT_MERCHANT_KEY, {
              name: group.vendor.name,
            })}
            onPress={() => onPressVendor(group.vendor)}
            className="self-start"
          >
            <View className="h-8 w-8 overflow-hidden rounded-full border border-border bg-muted">
              {group.vendor.logoUrl ? (
                <Image
                  source={{ uri: group.vendor.logoUrl }}
                  contentFit="contain"
                  style={StyleSheet.absoluteFill}
                />
              ) : null}
            </View>
          </Pressable>
          <View className="min-w-0">
            <Pressable
              accessibilityRole="link"
              onPress={() => onPressVendor(group.vendor)}
            >
              <Text
                numberOfLines={1}
                className="text-sm font-semibold leading-[18px] tracking-[-0.2px]"
              >
                {sellerName}
              </Text>
            </Pressable>
            <View className="flex-row flex-wrap items-baseline gap-1">
              <Text className="text-xs leading-4 text-muted-foreground">
                {t(MERCHANT_CART_SUBTOTAL_KEY)}
              </Text>
              <PriceDisplay
                price={group.subtotal}
                primaryClassName="text-xs font-medium leading-4"
              />
            </View>
          </View>
        </View>
        <View
          testID="cart-card-thumbnail-column"
          className="relative h-16 w-[72px] shrink-0"
        >
          {thumbnails.map((item, index) => (
            <View
              key={item.variantId}
              className={`absolute top-0 h-16 w-16 overflow-hidden rounded-[20px] border border-border bg-card web:shadow-sm ${index ? "start-2" : "start-0"}`}
              style={{
                zIndex: 2 - index,
                transform: [
                  {
                    rotate:
                      thumbnails.length === 1
                        ? "0deg"
                        : index
                          ? "4deg"
                          : "-3deg",
                  },
                ],
              }}
            >
              {item.imageUrl ? (
                <Image
                  source={{ uri: item.imageUrl }}
                  accessibilityLabel={item.title}
                  contentFit="cover"
                  style={StyleSheet.absoluteFill}
                />
              ) : null}
            </View>
          ))}
          <View
            testID="cart-card-count"
            className="absolute -start-1.5 top-1 z-10 min-w-[18px] items-center justify-center rounded-full bg-black p-0.5"
          >
            <Text className="text-[10px] font-bold leading-[14px] text-white">
              {totalQuantity}
            </Text>
          </View>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => onCheckout(group)}
        className="min-h-8 items-center justify-center rounded-full bg-black/[0.04] p-2 dark:bg-white/[0.06] web:transition-colors web:hover:opacity-80 active:scale-[0.99]"
      >
        <Text className="text-sm font-medium leading-4">
          {t(MERCHANT_CART_CHECKOUT_KEY)}
        </Text>
      </Pressable>
    </View>
  );
}
