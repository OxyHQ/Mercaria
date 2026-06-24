import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import type { CartGroup, CartVendor } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";

/** Logo thumbnail edge length (px). */
const LOGO_SIZE = 32;
/** Stacked item thumbnail edge length (px). */
const THUMB_SIZE = 64;
/** First thumbnail rotation for the stacked cluster visual. */
const ROT_A = "-3deg";
/** Second thumbnail rotation for the stacked cluster visual. */
const ROT_B = "4deg";
/** Count badge minimum edge length (px) and height. */
const BADGE_SIZE = 18;

export interface MerchantCartCardProps {
  group: CartGroup;
  onPressVendor: (vendor: CartVendor) => void;
  onCheckout: (vendor: CartVendor) => void;
}

/**
 * Merchant-grouped cart card rendered in the `CartShelf` carousel. Shows the
 * vendor header (logo + name + subtotal), a stacked thumbnail cluster with a
 * quantity badge, and a "Continue to checkout" button.
 *
 * No nested interactives: the vendor link and the checkout button are siblings
 * at the same level, never nested.
 */
export function MerchantCartCard({ group, onPressVendor, onCheckout }: MerchantCartCardProps) {
  const totalQuantity = group.items.reduce((n, i) => n + i.quantity, 0);
  const thumbA = group.items[0]?.imageUrl;
  const thumbB = group.items[1]?.imageUrl;

  return (
    <View className="w-full overflow-hidden rounded-3xl border border-border bg-card p-4 web:shadow">
      {/* Header row: vendor link (logo + name) and subtotal */}
      <View className="flex-row items-center gap-2">
        {/* Single pressable link wraps logo + name together */}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Visit ${group.vendor.name}`}
          onPress={() => onPressVendor(group.vendor)}
          className="flex-1 flex-row items-center gap-2"
        >
          <View
            className="overflow-hidden rounded-full bg-secondary"
            style={{ width: LOGO_SIZE, height: LOGO_SIZE }}
          >
            {group.vendor.logoUrl ? (
              <Image
                source={{ uri: group.vendor.logoUrl }}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
            ) : null}
          </View>
          <Text numberOfLines={1} className="flex-1 text-sm font-bold text-foreground">
            {group.vendor.name}
          </Text>
        </Pressable>

        {/* Subtotal label + price */}
        <Text className="text-xs text-muted-foreground">Subtotal:</Text>
        <PriceDisplay price={group.subtotal} />
      </View>

      {/* Stacked thumbnail cluster with quantity badge */}
      <View className="mt-4 flex-row items-center">
        {thumbA !== undefined ? (
          <View
            className="overflow-hidden rounded-2xl"
            style={{
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              transform: [{ rotate: ROT_A }],
            }}
          >
            <Image source={{ uri: thumbA }} contentFit="cover" style={StyleSheet.absoluteFill} />
          </View>
        ) : null}
        {thumbB !== undefined ? (
          <View
            className="-ml-4 overflow-hidden rounded-2xl"
            style={{
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              transform: [{ rotate: ROT_B }],
            }}
          >
            <Image source={{ uri: thumbB }} contentFit="cover" style={StyleSheet.absoluteFill} />
          </View>
        ) : null}

        {/* Quantity badge */}
        <View
          className="ml-2 items-center justify-center rounded-full bg-foreground px-1"
          style={{ minWidth: BADGE_SIZE, height: BADGE_SIZE }}
        >
          <Text className="text-[10px] font-bold text-background">{totalQuantity}</Text>
        </View>
      </View>

      {/* Checkout button — sibling to the vendor link, not nested */}
      <Pressable
        accessibilityRole="button"
        onPress={() => onCheckout(group.vendor)}
        className="mt-3 items-center rounded-full bg-secondary py-3"
      >
        <Text className="text-sm font-semibold text-foreground">Continue to checkout</Text>
      </Pressable>
    </View>
  );
}
