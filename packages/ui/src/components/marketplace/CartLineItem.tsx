import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import type { CartItemDTO } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";
import { QuantityStepper } from "./QuantityStepper";

/** Tailwind class applied to the outer row when the item is stale. */
const STALE_OPACITY_CLASS = "opacity-60";

export interface CartLineItemProps {
  item: CartItemDTO;
  onChangeQuantity: (variantId: string, qty: number) => void;
  onRemove: (variantId: string) => void;
  onPressItem?: (listingId: string) => void;
  onSaveForLater?: (variantId: string) => void;
}

/**
 * A single line in the cart, rendered as a row: image link | item details +
 * stepper | line total. The image and "Save for later" button are both
 * actionable but are siblings, never nested, to avoid illegal nested interactive
 * elements on web.
 */
export function CartLineItem({
  item,
  onChangeQuantity,
  onRemove,
  onPressItem,
  onSaveForLater,
}: CartLineItemProps) {
  return (
    <View className={`flex-row gap-3${item.stale ? ` ${STALE_OPACITY_CLASS}` : ""}`}>
      {/* Left: image link box */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={item.title}
        onPress={() => onPressItem?.(item.listingId)}
        className="h-20 w-20 overflow-hidden rounded-xl bg-card md:h-28 md:w-28"
      >
        {item.imageUrl ? (
          <Image
            source={{ uri: item.imageUrl }}
            contentFit="cover"
            style={StyleSheet.absoluteFill}
          />
        ) : null}
      </Pressable>

      {/* Middle: title, variant label, stepper, optional save-for-later */}
      <View className="flex-1 min-w-0">
        <Text numberOfLines={2} className="text-sm font-semibold text-foreground md:text-base">
          {item.title}
        </Text>
        <Text numberOfLines={1} className="mt-0.5 text-xs text-muted-foreground">
          {item.variantTitle}
        </Text>

        <View className="mt-3">
          <QuantityStepper
            quantity={item.quantity}
            available={item.available}
            onIncrement={() => onChangeQuantity(item.variantId, item.quantity + 1)}
            onDecrement={() => onChangeQuantity(item.variantId, item.quantity - 1)}
            onRemove={() => onRemove(item.variantId)}
          />
        </View>

        {onSaveForLater !== undefined ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onSaveForLater(item.variantId)}
            className="hidden md:flex mt-2 self-start rounded-full border border-border px-3 py-1.5"
          >
            <Text className="text-xs font-medium text-foreground">Save for later</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Right: line total */}
      <View className="items-end">
        <PriceDisplay price={item.lineTotal} primaryClassName="text-sm font-bold md:text-base" />
      </View>
    </View>
  );
}
