import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import type { ListingOption, ProductVariantDTO } from "@mercaria/shared-types";
import { Text } from "../ui/text";

/** Max color swatches shown before a "+N more" expander appears. */
const MAX_VISIBLE_SWATCHES = 24;
/** HSL saturation (%) for value-derived fallback swatch colors. */
const SWATCH_FALLBACK_SATURATION = 60;
/** HSL lightness (%) for value-derived fallback swatch colors. */
const SWATCH_FALLBACK_LIGHTNESS = 55;
/** Hue wheel size (degrees) the value hash is folded onto. */
const HUE_DEGREES = 360;
/** Bit-shift used by the value→hue string hash. */
const HASH_SHIFT = 5;

/** Option names that render as round color swatches (vs. text pills). */
const COLOR_OPTION_NAMES = new Set(["color", "colour", "shade"]);

/** A swatch-fallback gallery image: a resolvable URL and optional alt text. */
export interface VariantSwatchImage {
  /** Resolvable image URL. */
  uri: string;
  /** Optional alt text. */
  alt?: string;
}

export interface VariantSwatchesProps {
  /** The option being selected (name + allowed values). */
  option: ListingOption;
  /** All concrete variants — used to compute per-value stock. */
  variants: ProductVariantDTO[];
  /**
   * Gallery images cycled across color swatches as faked per-variant art when a
   * value has no real swatch image; falls back to a deterministic value color.
   */
  images: VariantSwatchImage[];
  /** Currently selected value for this option, if any. */
  selectedValue?: string;
  /** Called with the chosen value when a swatch/pill is pressed. */
  onSelect: (value: string) => void;
}

/** Whether an option renders as round swatches rather than text pills. */
function isColorOption(option: ListingOption): boolean {
  return COLOR_OPTION_NAMES.has(option.name.trim().toLowerCase());
}

/**
 * Deterministically derive an HSL color from an option value string, used as the
 * fallback swatch tone when no gallery image is available.
 */
function valueToColor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = value.charCodeAt(i) + ((hash << HASH_SHIFT) - hash);
  }
  const hue = Math.abs(hash) % HUE_DEGREES;
  return `hsl(${hue}, ${SWATCH_FALLBACK_SATURATION}%, ${SWATCH_FALLBACK_LIGHTNESS}%)`;
}

/** Whether a given option value is available in at least one in-stock variant. */
function valueInStock(
  variants: ProductVariantDTO[],
  optionName: string,
  value: string,
): boolean {
  return variants.some(
    (variant) =>
      variant.inStock &&
      variant.optionValues.some((ov) => ov.name === optionName && ov.value === value),
  );
}

/**
 * One option row: a label + selectable values. Color-like options (`Color`,
 * `Colour`, `Shade`) render as circular swatches with a sold-out diagonal
 * strike and a "+N more" expander past 24 values; every other option renders as
 * text pills. Presentational — the caller owns selection state and the variant
 * matching that follows from it.
 */
export function VariantSwatches({
  option,
  variants,
  images,
  selectedValue,
  onSelect,
}: VariantSwatchesProps) {
  const asSwatches = isColorOption(option);
  const [expanded, setExpanded] = useState(false);

  const overflow = asSwatches && option.values.length > MAX_VISIBLE_SWATCHES && !expanded;
  const visibleValues = overflow
    ? option.values.slice(0, MAX_VISIBLE_SWATCHES)
    : option.values;
  const hiddenCount = option.values.length - MAX_VISIBLE_SWATCHES;

  return (
    <View className="gap-space-8">
      <View className="flex-row items-center gap-space-8">
        <Text className="text-captionBold text-text">{option.name}</Text>
        {selectedValue ? (
          <Text numberOfLines={1} className="flex-1 text-caption text-text">
            {selectedValue}
          </Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-space-8">
        {visibleValues.map((value, i) => {
          const selected = selectedValue === value;
          const inStock = valueInStock(variants, option.name, value);

          if (asSwatches) {
            // Faked per-variant art: cycle the gallery images across swatches;
            // fall back to a deterministic value-derived color.
            const swatchImage = images.length > 0 ? images[i % images.length] : undefined;
            return (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`${option.name}: ${value}`}
                accessibilityState={{ selected, disabled: !inStock }}
                disabled={!inStock}
                onPress={() => onSelect(value)}
                className={`size-space-40 shrink-0 items-center justify-center rounded-radius-max p-space-2 ${
                  selected ? "border-[1.5px] border-border-input-active" : "border border-border-image"
                }`}
              >
                <View className="size-full items-center justify-center overflow-hidden rounded-radius-max border-[0.5px] border-border-image bg-bg-fill-secondary">
                  {swatchImage ? (
                    <Image
                      source={{ uri: swatchImage.uri }}
                      contentFit="cover"
                      style={StyleSheet.absoluteFill}
                    />
                  ) : (
                    <View
                      style={[StyleSheet.absoluteFill, { backgroundColor: valueToColor(value) }]}
                    />
                  )}
                  {!inStock ? (
                    <View className="absolute inset-0 items-center justify-center bg-overlay-fixed-dark-40">
                      <View className="h-4/5 w-px rotate-45 bg-bg-fill" />
                    </View>
                  ) : null}
                </View>
              </Pressable>
            );
          }

          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={`${option.name}: ${value}`}
              accessibilityState={{ selected, disabled: !inStock }}
              disabled={!inStock}
              onPress={() => onSelect(value)}
              className={`min-h-space-40 items-center justify-center rounded-radius-max border-[1.5px] px-space-16 ${
                selected ? "border-border-input-active" : "border-border-secondary"
              } ${!inStock ? "opacity-40" : ""}`}
            >
              <Text className="text-buttonMedium text-text">{value}</Text>
            </Pressable>
          );
        })}
        {overflow ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show ${hiddenCount} more ${option.name} options`}
            onPress={() => setExpanded(true)}
            className="min-h-space-40 items-center justify-center rounded-radius-max border-[1.5px] border-border-secondary px-space-16"
          >
            <Text className="text-buttonMedium text-text">{`+${hiddenCount} more`}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
