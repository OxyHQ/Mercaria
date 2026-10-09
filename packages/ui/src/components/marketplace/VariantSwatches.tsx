import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { isImageUrl, useImageResolver } from "@oxy.so/bloom/image-resolver";
import { useColorScheme } from "../../lib/useColorScheme";
import { Image } from "expo-image";
import type { ListingOption, ProductVariantDTO } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { SWATCH_SHOW_MORE_A11Y_KEY, SWATCH_SHOW_MORE_KEY } from "../../lib/marketplace-labels";
import { chooseListingVariant } from "../../lib/listing-variant-selection";

/** Max values shown before a "+N more" expander appears. */
const MAX_VISIBLE_VALUES = 24;

export interface VariantSwatchesProps {
  /** The option being selected (name + allowed values). */
  option: ListingOption;
  /** All concrete variants — used to compute per-value stock. */
  variants: ProductVariantDTO[];
  /** Currently selected value for this option, if any. */
  selectedValue?: string;
  /** Other axes affect which concrete variant this option will select. */
  selectedVariant?: ProductVariantDTO;
  /** Called with the chosen value when a value is pressed. */
  onSelect: (value: string) => void;
}

/** Stock and artwork describe the configuration that pressing the pill selects.
 * Free-text names never determine widget type or invent a colour. */
export function VariantSwatches({
  option,
  variants,
  selectedValue,
  selectedVariant,
  onSelect,
}: VariantSwatchesProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useSharedUiTranslation();
  const { colors } = useColorScheme();
  const resolveImage = useImageResolver();

  const overflow = option.values.length > MAX_VISIBLE_VALUES && !expanded;
  const initialValues = option.values.slice(0, MAX_VISIBLE_VALUES);
  // A deep link can select a value beyond the collapsed preview. Keep that
  // choice visible, as Shop does with its persisted swatch, without expanding
  // a large option matrix or changing the selected configuration.
  const collapsedValues = selectedValue && option.values.includes(selectedValue) && !initialValues.includes(selectedValue)
    ? [...initialValues.slice(0, -1), selectedValue]
    : initialValues;
  const visibleValues = overflow ? collapsedValues : option.values;
  const hiddenCount = option.values.length - MAX_VISIBLE_VALUES;

  return (
    <View className="gap-space-8">
      <View className="flex-row items-center gap-space-8">
        <Text className="text-shop-captionBold text-text">{option.name}</Text>
        {selectedValue ? (
          <Text numberOfLines={1} className="flex-1 text-shop-caption text-text">
            {selectedValue}
          </Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-space-8">
        {visibleValues.map((value) => {
          const selected = selectedValue === value;
          const target = chooseListingVariant(variants, selectedVariant, option.name, value);
          const inStock = target?.inStock ?? false;
          const fileId = target?.images?.source === "variant"
            ? target.images.images[0]?.fileId : undefined;
          const image = fileId
            ? isImageUrl(fileId) ? fileId : resolveImage?.(fileId, "thumb")
            : undefined;

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
            <Text className="text-shop-buttonMedium text-text">
              {t(SWATCH_SHOW_MORE_KEY, { more: hiddenCount })}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
