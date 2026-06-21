import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { Heart } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { ReviewStars } from "./ReviewStars";
import { formatMoney, formatReviewCount, type ProductSummary } from "./types";

/** Light color used for content drawn over the image (badge text, heart). */
const ON_IMAGE_LIGHT = "#FFFFFF";
/** Subtle dark image overlay (documented allowed overlay constant). */
const IMAGE_OVERLAY = "rgba(0,0,0,0.04)";
/** Opaque-ish dark backdrop for the sale badge (documented overlay constant). */
const SALE_BADGE_BG = "rgba(0,0,0,0.75)";
/** Blur intensity for the native favorite-button backdrop. */
const FAVORITE_BLUR_INTENSITY = 25;
/** Heart icon size for the favorite button. */
const HEART_SIZE = 18;

export interface ProductCardProps {
  product: ProductSummary;
  /**
   * Initial saved/favorited state. Overrides `product.saved` when provided;
   * otherwise the card seeds from the DTO's `saved` flag.
   */
  saved?: boolean;
  onPress?: (id: string) => void;
  onToggleSave?: (id: string, nextSaved: boolean) => void;
}

function isOnSale(product: ProductSummary): boolean {
  return (
    product.compareAtPrice !== undefined &&
    product.compareAtPrice.amount > product.price.amount
  );
}

export function ProductCard({ product, saved, onPress, onToggleSave }: ProductCardProps) {
  const [isSaved, setIsSaved] = useState(saved ?? product.saved ?? false);
  const onSale = isOnSale(product);
  const discountPercent =
    onSale && product.compareAtPrice
      ? Math.round((1 - product.price.amount / product.compareAtPrice.amount) * 100)
      : 0;
  const isNativePlatform = Platform.OS !== "web";

  const handleToggleSave = () => {
    const next = !isSaved;
    setIsSaved(next);
    onToggleSave?.(product.id, next);
  };

  return (
    // The card itself is NOT a button. Navigation lives in two SEPARATE,
    // sibling interactive zones (the image link and the text link), and the
    // favorite button is a SIBLING of the image link — never nested inside
    // another interactive element (avoids invalid `<button>`-in-`<button>` on
    // web). `group` is kept here so the image still scales on hover.
    <View className="group flex flex-col gap-2">
      {/* Image block */}
      <View className="relative aspect-square overflow-hidden rounded-2xl bg-card">
        {/* Image navigation link — fills the block, sits beneath the favorite. */}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={product.title}
          onPress={() => onPress?.(product.id)}
          className="absolute inset-0"
        >
          <Image
            source={{ uri: product.imageUrl }}
            contentFit="cover"
            className="h-full w-full web:transition-transform web:duration-300 web:group-hover:scale-105"
          />
        </Pressable>

        {/* 1px inset border */}
        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-2xl border border-border"
        />

        {/* Subtle dark overlay */}
        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-2xl"
          style={{ backgroundColor: IMAGE_OVERLAY }}
        />

        {/* Sale badge */}
        {onSale ? (
          <View
            pointerEvents="none"
            className="absolute left-3 top-3 rounded-full px-1.5 py-0.5"
            style={{ backgroundColor: SALE_BADGE_BG }}
          >
            <Text
              className="text-[10px] font-bold"
              style={{ color: ON_IMAGE_LIGHT }}
            >
              {`${discountPercent}% off`}
            </Text>
          </View>
        ) : null}

        {/* Favorite button — SIBLING of the image link (rendered last so it
            stacks on top and receives presses). Not nested in any link. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add to saved items"
          onPress={handleToggleSave}
          hitSlop={8}
          className="absolute bottom-3 right-3 overflow-hidden rounded-full"
        >
          {isNativePlatform ? (
            <BlurView
              intensity={FAVORITE_BLUR_INTENSITY}
              tint="dark"
              className="rounded-full p-2"
            >
              <Heart
                size={HEART_SIZE}
                color={ON_IMAGE_LIGHT}
                fill={isSaved ? ON_IMAGE_LIGHT : "transparent"}
              />
            </BlurView>
          ) : (
            <View className="rounded-full bg-black/30 p-2">
              <Heart
                size={HEART_SIZE}
                color={ON_IMAGE_LIGHT}
                fill={isSaved ? ON_IMAGE_LIGHT : "transparent"}
              />
            </View>
          )}
        </Pressable>
      </View>

      {/* Text block — its own separate navigation link. */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={product.title}
        onPress={() => onPress?.(product.id)}
        className="flex flex-col pl-1"
      >
        <Text numberOfLines={1} className="text-xs text-foreground/70">
          {product.brand}
        </Text>
        <Text numberOfLines={1} className="text-sm font-semibold text-foreground">
          {product.title}
        </Text>

        {/* Review row */}
        <View className="flex-row items-center gap-1">
          <ReviewStars rating={product.rating} count={product.reviewCount} />
          <Text className="text-xs text-foreground">
            {`(${formatReviewCount(product.reviewCount)})`}
          </Text>
        </View>

        {/* Price row */}
        <View className="flex-row items-center gap-1">
          <Text className="text-sm font-semibold text-foreground">
            {formatMoney(product.price)}
          </Text>
          {onSale && product.compareAtPrice ? (
            <Text className="text-sm font-normal text-muted-foreground line-through">
              {formatMoney(product.compareAtPrice)}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}
