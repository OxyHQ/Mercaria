import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { useColorScheme } from "../../lib/useColorScheme";
import { Image } from "expo-image";
import type { ListingOption, ProductVariantDTO } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { SWATCH_SHOW_MORE_A11Y_KEY, SWATCH_SHOW_MORE_KEY } from "../../lib/marketplace-labels";

/** Max values shown before a "+N more" expander appears. */
const MAX_VISIBLE_VALUES = 24;

export interface VariantSwatchesProps {
  /** The option being selected (name + allowed values). */
  option: ListingOption;
  /** All concrete variants — used to compute per-value stock. */
  variants: ProductVariantDTO[];
  /** Currently selected value for this option, if any. */
  selectedValue?: string;
  /** Called with the chosen value when a value is pressed. */
  onSelect: (value: string) => void;
}

/** Whether a given option value is available in at least one in-stock variant. */
function valueInStock(variants: ProductVariantDTO[], optionName: string, value: string): boolean {
  return variants.some(
    (variant) =>
      variant.inStock &&
      variant.optionValues.some((ov) => ov.name === optionName && ov.value === value),
  );
}

/** Option values stay textual unless the server supplies variant-owned photos.
 * Free-text names never determine widget type or invent a colour. A value gets
 * a photo only when all its variants identify the same first photo; otherwise
 * the text pill preserves the distinction between the other option axes. */
function valueImage(variants: ProductVariantDTO[], optionName: string, value: string) {
  const matches = variants.filter((variant) =>
    variant.optionValues.some((option) => option.name === optionName && option.value === value),
  );
  const images = matches.map((variant) =>
    variant.images?.source === "variant" ? variant.images.images[0]?.fileId : undefined,
  );
  return images.length > 0 && images[0] && images.every((image) => image === images[0])
    ? images[0]
    : undefined;
}

export function VariantSwatches({
  option,
  variants,
  selectedValue,
  onSelect,
}: VariantSwatchesProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useSharedUiTranslation();
  const { colors } = useColorScheme();

  const overflow = option.values.length > MAX_VISIBLE_VALUES && !expanded;
  const visibleValues = overflow ? option.values.slice(0, MAX_VISIBLE_VALUES) : option.values;
  const hiddenCount = option.values.length - MAX_VISIBLE_VALUES;

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
        {visibleValues.map((value) => {
          const selected = selectedValue === value;
          const inStock = valueInStock(variants, option.name, value);
          const image = valueImage(variants, option.name, value);

          return (
            <Button
              key={value}
              accessibilityLabel={`${option.name}: ${value}`}
              pressed={selected}
              appearance="plain"
              colors={{ background: colors.card, foreground: colors.foreground }}
              onPress={() => onSelect(value)}
              style={{
                minHeight: 40,
                paddingHorizontal: 16,
                borderRadius: 999,
                borderWidth: 1.5,
                borderColor: selected ? colors.foreground : colors.border,
                opacity: inStock ? 1 : 0.4,
              }}
              textStyle={{ textDecorationLine: inStock ? "none" : "line-through" }}
              leading={
                image ? (
                  <Image
                    source={{ uri: image }}
                    contentFit="cover"
                    style={{ width: 32, height: 32, borderRadius: 8 }}
                  />
                ) : undefined
              }
            >
              {value}
            </Button>
          );
        })}
        {overflow ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(SWATCH_SHOW_MORE_A11Y_KEY, {
              more: hiddenCount,
              option: option.name,
            })}
            onPress={() => setExpanded(true)}
            className="min-h-space-40 items-center justify-center rounded-radius-max border-[1.5px] border-border-secondary px-space-16"
          >
            <Text className="text-buttonMedium text-text">
              {t(SWATCH_SHOW_MORE_KEY, { more: hiddenCount })}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
