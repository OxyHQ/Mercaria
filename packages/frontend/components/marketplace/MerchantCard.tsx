import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Star } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { formatReviewCount } from "./types";
import type { MerchantSummary } from "@mercaria/shared-types";

/** Fixed card height (px) — the carousel sizes the slot width, the card the height. */
const CARD_HEIGHT = 397;
/** Card corner radius (px). */
const CARD_RADIUS = 28;
/** Rating star size (px). */
const RATING_STAR_SIZE = 11;
/**
 * Featured-thumbnail edge length (px). Fixed so each square cell always has a
 * concrete size — an absolute-fill cover image needs a sized parent to show.
 */
const THUMB_SIZE = 92;
/** Product-thumbnail corner radius (px). */
const THUMB_RADIUS = 16;

/** Fixed gold star fill (documented allowed constant). */
const STAR_COLOR = "#FFB800";
/** Documented dark cover overlay constant (~20%). */
const COVER_DARK_OVERLAY = "rgba(0,0,0,0.20)";
/** Light text tone over a merchant cover (documented data-driven exception). */
const TONE_LIGHT = "#FFFFFF";
/** Dark text tone over a merchant cover (documented data-driven exception). */
const TONE_DARK = "#111111";
/**
 * Bottom brand-color gradient stops: opaque brand color at the bottom (0.2)
 * fading to transparent ~80% up, so the wordmark/rating/thumbnails sit over a
 * brand wash. Paired with `start={bottom}`/`end={top}`.
 */
const GRADIENT_LOCATIONS = [0.2, 0.8] as const;

export interface MerchantCardProps {
  merchant: MerchantSummary;
  onPressMerchant?: (handle: string) => void;
  onPressProduct?: (id: string) => void;
}

/**
 * Editorial "store hero" merchant (shop) card. Layers, back → front: the cover
 * photo (the visual anchor, bleeds the whole card) → a fixed dark tint → a
 * bottom brand-color gradient wash → the foreground content (centered wordmark,
 * bottom-left name + rating, and a row of featured product thumbnails) → a 1px
 * inset border. Foreground text follows the merchant's `textTone`
 * (light/dark); the rating star stays gold.
 *
 * No nested interactives: the store wordmark is one link, and each product
 * thumbnail is its own SIBLING link (never nested inside the store link), so
 * web renders no `<button>`/`<a>` inside another.
 */
export function MerchantCard({
  merchant,
  onPressMerchant,
  onPressProduct,
}: MerchantCardProps) {
  const toneColor = merchant.textTone === "light" ? TONE_LIGHT : TONE_DARK;

  return (
    <View
      className="group w-full overflow-hidden web:shadow-lg"
      style={{ height: CARD_HEIGHT, borderRadius: CARD_RADIUS, backgroundColor: merchant.brandColor }}
    >
      {/* Layer 1 — cover image, bleeds the whole card (the visual anchor). */}
      <Image
        source={{ uri: merchant.coverImageUrl }}
        contentFit="cover"
        pointerEvents="none"
        className="web:transition-transform web:duration-300 web:group-hover:scale-105"
        style={StyleSheet.absoluteFill}
      />

      {/* Layer 2 — fixed dark tint (~20%). */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: COVER_DARK_OVERLAY }]}
      />

      {/* Layer 3 — bottom brand-color gradient: opaque brand at the bottom → transparent ~80% up. */}
      <LinearGradient
        pointerEvents="none"
        colors={[merchant.brandColor, "transparent"]}
        locations={GRADIENT_LOCATIONS}
        start={{ x: 0, y: 1 }}
        end={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Layer 4 — foreground content (above the layers as a later sibling). */}
      <View className="flex-1 p-3">
        {/* Store zone — centered wordmark with the name + rating pinned bottom-left. */}
        <View className="relative flex-1">
          {/* Centered wordmark / logo — the store link. */}
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Visit ${merchant.name}`}
            onPress={() => onPressMerchant?.(merchant.handle)}
            className="absolute inset-0 items-center justify-center"
          >
            {merchant.logoUrl ? (
              <Image
                source={{ uri: merchant.logoUrl }}
                contentFit="contain"
                style={{ maxHeight: 74, maxWidth: 195, width: "70%", height: 74 }}
              />
            ) : (
              <Text
                numberOfLines={1}
                className="text-center text-3xl font-bold"
                style={{ color: toneColor }}
              >
                {merchant.name}
              </Text>
            )}
          </Pressable>

          {/* Name + rating, bottom-left of the store zone. */}
          <View className="absolute bottom-0 left-0">
            <Text
              numberOfLines={1}
              className="text-sm font-bold"
              style={{ color: toneColor }}
            >
              {merchant.name}
            </Text>
            <View className="mt-0.5 flex-row items-center gap-1">
              <Star size={RATING_STAR_SIZE} color={STAR_COLOR} fill={STAR_COLOR} />
              <Text className="text-xs" style={{ color: toneColor }}>
                {`${merchant.rating} (${formatReviewCount(merchant.reviewCount)})`}
              </Text>
            </View>
          </View>
        </View>

        {/* Featured product thumbnails — sibling links (never nested in the store
            link). Each cell has an explicit square size so the cover image
            (which fills it) always has a sized parent to render into. */}
        <View className="mt-3 flex-row justify-center gap-1.5">
          {(merchant.products ?? []).map((thumb) => (
            <Pressable
              key={thumb.id}
              accessibilityRole="link"
              accessibilityLabel={thumb.title}
              onPress={() => onPressProduct?.(thumb.id)}
              className="overflow-hidden web:shadow-sm"
              style={{ width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: THUMB_RADIUS }}
            >
              <Image
                source={{ uri: thumb.imageUrl }}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
              <View
                pointerEvents="none"
                className="absolute inset-0 border border-border"
                style={{ borderRadius: THUMB_RADIUS }}
              />
            </Pressable>
          ))}
        </View>
      </View>

      {/* Layer 5 — 1px inset border (very front, non-interactive). */}
      <View
        pointerEvents="none"
        className="absolute inset-0 border border-border"
        style={{ borderRadius: CARD_RADIUS }}
      />
    </View>
  );
}
