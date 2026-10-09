import { useState } from "react";
import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { isImageUrl, useImageResolver } from "@oxy.so/bloom/image-resolver";
import { useReducedMotion } from "react-native-reanimated";
import { cn } from "../../lib/cn";
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
  const { isDarkColorScheme } = useColorScheme();
  const reducedMotion = useReducedMotion();
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
      <View className="flex-row items-center gap-space-4">
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
              accessibilityLabel={`${option.name}: ${value}${inStock ? "" : `, ${t("ui.purchase.soldOut")}`}`}
              pressed={selected}
              material="flat"
              onPress={() => onSelect(value)}
              className={cn(
                "shop-option",
                isDarkColorScheme && "shop-option-dark",
                selected && inStock && (isDarkColorScheme ? "shop-option-selected-dark" : "shop-option-selected"),
                !inStock && (isDarkColorScheme ? "shop-option-unavailable-dark" : "shop-option-unavailable"),
                !inStock && selected && (isDarkColorScheme ? "shop-option-unavailable-selected-dark" : "shop-option-unavailable-selected"),
                !selected && (isDarkColorScheme ? "shop-option-interactive-dark" : "shop-option-interactive"),
                !selected && !reducedMotion && "shop-option-pressable",
                selected && "web:cursor-default",
              )}
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
              <Text numberOfLines={1} className={cn(
                "shrink text-shop-buttonSmall",
                inStock ? (isDarkColorScheme ? "text-white" : "text-black")
                  : isDarkColorScheme ? "text-[#fff6] line-through" : "text-[#0006] line-through",
              )}>
                {value}
              </Text>
            </Button>
          );
        })}
        {overflow ? (
          <Button
            material="flat"
            accessibilityLabel={t(SWATCH_SHOW_MORE_A11Y_KEY, {
              more: hiddenCount,
              option: option.name,
            })}
            onPress={() => setExpanded(true)}
            className={cn(
              "shop-option shop-option-more",
              isDarkColorScheme && "shop-option-dark",
              isDarkColorScheme ? "shop-option-interactive-dark" : "shop-option-interactive",
              !reducedMotion && "shop-option-pressable",
            )}
          >
            <Text className={cn("text-shop-buttonSmall", isDarkColorScheme ? "text-white" : "text-black")}>
              {t(SWATCH_SHOW_MORE_KEY, { more: hiddenCount })}
            </Text>
          </Button>
        ) : null}
      </View>
    </View>
  );
}
