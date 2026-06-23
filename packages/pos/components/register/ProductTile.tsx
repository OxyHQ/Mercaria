import React from "react";
import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import type { Listing } from "@mercaria/shared-types";
import { Text, PriceDisplay } from "@mercaria/ui";

/** Crossfade duration (ms) for the tile image as it loads. */
const IMAGE_TRANSITION_MS = 150;

interface ProductTileProps {
  listing: Listing;
  /** Resolved thumbnail URL (already passed through the media resolver). */
  imageUri: string | undefined;
  onPress: () => void;
}

/**
 * A single touch tile in the register catalog grid: a square product image, the
 * title clamped to two lines, the "from" price, and a stock label. Out-of-stock
 * listings are disabled and visually dimmed. The tile is a large tap target with
 * a hover affordance on web.
 */
export function ProductTile({ listing, imageUri, onPress }: ProductTileProps) {
  const outOfStock = listing.quantity <= 0;
  return (
    <Pressable
      onPress={onPress}
      disabled={outOfStock}
      accessibilityRole="button"
      accessibilityLabel={listing.title}
      accessibilityState={{ disabled: outOfStock }}
      className={
        outOfStock
          ? "overflow-hidden rounded-2xl border border-border bg-surface opacity-50"
          : "overflow-hidden rounded-2xl border border-border bg-surface active:opacity-80 web:transition-colors web:hover:border-primary"
      }
    >
      <View className="aspect-square w-full bg-secondary">
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
            transition={IMAGE_TRANSITION_MS}
          />
        ) : null}
        {outOfStock ? (
          <View className="absolute left-2 top-2 rounded-full bg-foreground/80 px-2 py-1">
            <Text className="text-[11px] font-semibold text-background">Sold out</Text>
          </View>
        ) : null}
      </View>
      <View className="gap-1 p-3">
        <Text numberOfLines={2} className="min-h-[40px] text-sm font-semibold text-foreground">
          {listing.title}
        </Text>
        <PriceDisplay price={listing.price} primaryClassName="text-sm font-bold" />
        <Text className="text-xs text-muted-foreground">
          {outOfStock ? "Out of stock" : `${listing.quantity} in stock`}
        </Text>
      </View>
    </Pressable>
  );
}
