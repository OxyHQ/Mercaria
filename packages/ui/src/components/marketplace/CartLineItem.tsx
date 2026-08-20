import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import type { CartItemDTO, CartLineReviewReason } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  CART_SAVE_FOR_LATER_KEY,
} from "../../lib/marketplace-labels";
import { PriceDisplay } from "../PriceDisplay";
import { QuantityStepper } from "./QuantityStepper";

/** Tailwind class applied to the outer row when the item is stale. */
const STALE_OPACITY_CLASS = "opacity-60";

/**
 * What a merged line's review flag says to the buyer (#104).
 *
 * A total map over the closed set rather than a lookup with a fallback: adding
 * a reason code to `CART_LINE_REVIEW_REASONS` then fails the build here instead
 * of silently rendering nothing at the one moment a buyer needs to be told
 * something changed. The copy names the CONSEQUENCE, never the mechanism —
 * "merge" and "guest session" are our words, not theirs.
 */
const REVIEW_REASON_MESSAGE: Record<CartLineReviewReason, string> = {
  quantity_clamped_to_stock: "We reduced the quantity — that is all the seller has left.",
  quantity_clamped_to_limit: "We reduced the quantity to the maximum per item.",
  listing_unavailable: "This item is not available right now. Remove it to check out.",
  listing_remapped: "This item moved to a different listing. Check it still looks right.",
};

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
  const t = useSharedUiTranslation();
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

        {item.reviewReason !== undefined ? (
          // `accessibilityRole="alert"` because this is the one thing on the row
          // the buyer did not do themselves: it says what changed while they
          // were signing in, and it must reach a screen reader as such.
          <Text
            accessibilityRole="alert"
            className="mt-1.5 text-xs font-medium text-destructive"
          >
            {REVIEW_REASON_MESSAGE[item.reviewReason]}
          </Text>
        ) : null}

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
            <Text className="text-xs font-medium text-foreground">
              {t(CART_SAVE_FOR_LATER_KEY)}
            </Text>
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
