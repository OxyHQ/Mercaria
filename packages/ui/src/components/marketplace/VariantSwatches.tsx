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

// Shop's option preview reserves four rows, 8px gaps and 90px for the
// expander. Measure the actual text/artwork on each platform instead of
// estimating every merchant's label from its character count.
const INITIAL_VISIBLE_VALUES = 8;
function previewCount(widths: number[], containerWidth: number, selectedIndex: number) {
  const available = Math.max(1, containerWidth - 20);
  for (let count = widths.length; count > 1; count--) {
    const preview = widths.slice(0, count);
    // A long deep-linked value must fit in the preview too, not create an
    // extra row after replacing the last short option.
    if (selectedIndex >= count) preview[count - 1] = widths[selectedIndex];
    if (count < widths.length) preview.push(90);
    let used = 0;
    let rows = 1;
    for (const measuredWidth of preview) {
      const width = Math.min(measuredWidth, available);
      if (used > 0 && used + 8 + width > available) {
        rows++;
        used = width;
      } else used += (used > 0 ? 8 : 0) + width;
    }
    if (rows <= 4) return count;
  }
  return Math.min(1, widths.length);
}

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
  const [hoveredValue, setHoveredValue] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measuredWidths, setMeasuredWidths] = useState(new Map<string, number>());
  const t = useSharedUiTranslation();
  const { isDarkColorScheme } = useColorScheme();
  const reducedMotion = useReducedMotion();
  const resolveImage = useImageResolver();

  // Even an empty pill takes 35px. Probe only enough candidates to exceed
  // four rows, plus the persisted selection, rather than mounting thousands
  // of hidden labels for a large merchant option set.
  const probeLimit = containerWidth > 0
    ? 4 * Math.ceil(containerWidth / 35) + 1
    : INITIAL_VISIBLE_VALUES;
  const previewValues = option.values.slice(0, probeLimit);
  const choiceValues = expanded ? option.values
    : selectedValue && option.values.includes(selectedValue) && !previewValues.includes(selectedValue)
      ? [...previewValues, selectedValue]
      : previewValues;
  const choices = choiceValues.map((value) => {
    const target = chooseListingVariant(variants, selectedVariant, option.name, value);
    const fileId = target?.images?.source === "variant"
      ? target.images.images[0]?.fileId : undefined;
    const image = fileId
      ? isImageUrl(fileId) ? fileId : resolveImage?.(fileId, "thumb")
      : undefined;
    return { value, image, inStock: target?.inStock ?? false, measureKey: `${value}\0${image ? 1 : 0}` };
  });
  const widths = choices.map(({ measureKey }) => measuredWidths.get(measureKey));
  const measured = containerWidth > 0 && widths.every((width) => width !== undefined);
  const limit = measured
    ? previewCount(widths as number[], containerWidth, choiceValues.indexOf(selectedValue ?? ""))
    : INITIAL_VISIBLE_VALUES;
  const overflow = option.values.length > limit && !expanded;
  const initialValues = option.values.slice(0, limit);
  // A deep link can select a value beyond the collapsed preview. Keep that
  // choice visible, as Shop does with its persisted swatch, without expanding
  // a large option matrix or changing the selected configuration.
  const collapsedValues = selectedValue && option.values.includes(selectedValue) && !initialValues.includes(selectedValue)
    ? [...initialValues.slice(0, -1), selectedValue]
    : initialValues;
  const visibleValues = overflow ? collapsedValues : option.values;
  const hiddenCount = option.values.length - limit;
  const displayedValue = hoveredValue ?? selectedValue;

  return (
    <View className="gap-space-8" onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
      {/* Non-interactive text probes stay out of layout, focus and the
          accessibility tree. Add Shop's 32px padding + 3px border, and the
          32px thumbnail + 8px gap when present, to the actual label width. */}
      {!expanded && <View
        pointerEvents="none"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="absolute h-0 w-full max-w-[344px] overflow-hidden opacity-0"
      >
        {choices.map(({ value, image, measureKey }) => (
          <Text
            key={measureKey}
            numberOfLines={1}
            className="self-start text-shop-buttonSmall"
            onLayout={(event) => {
              const labelWidth = event.nativeEvent.layout.width;
              if (labelWidth <= 0) return;
              const width = Math.min(344, labelWidth + 35 + (image ? 40 : 0));
              setMeasuredWidths((previous) => {
                if (previous.get(measureKey) === width) return previous;
                return new Map(previous).set(measureKey, width);
              });
            }}
          >
            {value}
          </Text>
        ))}
      </View>}
      <View className="flex-row items-center gap-space-4">
        <Text className="text-shop-captionBold text-text">{option.name}</Text>
        {displayedValue ? (
          <Text testID={`variant-option-value-${option.name}`} numberOfLines={1} className="flex-1 text-shop-caption text-text">
            {displayedValue}
          </Text>
        ) : null}
      </View>
      <View testID={`variant-option-values-${option.name}`} className="flex-row flex-wrap gap-space-8">
        {visibleValues.map((value) => {
          const selected = selectedValue === value;
          const { inStock, image } = choices.find((choice) => choice.value === value)!;

          return (
            <Button
              key={value}
              accessibilityLabel={`${option.name}: ${value}${inStock ? "" : `, ${t("ui.purchase.soldOut")}`}`}
              pressed={selected}
              material="flat"
              onPress={() => onSelect(value)}
              onHoverIn={() => setHoveredValue(value)}
              onHoverOut={() => setHoveredValue(null)}
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
