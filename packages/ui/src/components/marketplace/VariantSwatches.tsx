import { useState } from "react";
import { Pressable, View } from "react-native";
import type { ListingOption, ProductVariantDTO } from "@mercaria/shared-types";
import { Text } from "../ui/text";

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
 * One option row: a label + selectable values, rendered as text pills with a
 * sold-out treatment and a "+N more" expander past 24 values. Presentational —
 * the caller owns selection state and the variant matching that follows from it.
 *
 * ## Why every option renders as a pill, including colour (#478)
 *
 * This component used to render round colour swatches when
 * `ListingOption.name` matched one of `color`, `colour` or `shade`. Two
 * separate things were wrong with that, and only the first is the one the
 * issue title names.
 *
 * 1. **The widget was chosen from three English words.** A seller who names the
 *    option `Tono`, `Farbe` or `色` got pills; one who typed `Colour` got
 *    swatches. `variant-axis.ts` names this exact shape as the thing the typed
 *    axis layer exists to prevent — "`Tono` looking like `Color` is the false
 *    merge #58 is shaped around, and the safe failure is text in a queue" — and
 *    its refusal vocabulary (`unmapped`, `ambiguous`) is how an option name
 *    becomes an attribute: an operator adds an alias, in one versioned
 *    registry, rather than a component learning a fourth language.
 *
 * 2. **The colour it drew was invented, which is the worse half.** Nothing in
 *    this codebase records what colour a value IS. `attribute_enum_values`
 *    carries no hex/swatch column, `ListingOption` has no per-value image and
 *    `ProductVariantDTO` has none either. So a swatch showed one of two
 *    fabrications: a gallery photo cycled by index (`images[i % images.length]`
 *    — the old code called this "faked per-variant art", and swatch #3 simply
 *    got gallery photo #3), or a hue derived by hashing the value string, which
 *    gave `Negro` and `Black` unrelated colours for one colour. Both rendered
 *    under an `accessibilityLabel` naming the value, so a screen reader
 *    announced "Color: Negro" over a hash artefact.
 *
 * Translating the name list would therefore have spread a fabricated fact to
 * more locales rather than fixing one. A pill reading `Negro` is true in every
 * language, so pills are both the smaller change and the honest one.
 *
 * ## What a real swatch needs, so the seam is named rather than implied
 *
 * Two facts, neither of which reaches a client today:
 *
 * - **Which attribute this option is.** `native_listing_variant_axes` (#367
 *   step 4) cites an `attribute_definitions` row and version, but no route
 *   serves it: `ListingOption` is `{name, values}` and the hydration path
 *   (`catalog-hydration.service.ts`) maps the legacy free-text rows straight
 *   through.
 * - **What the value looks like.** A colour on the enum value, or a real
 *   per-value image. Neither column exists.
 *
 * With both, the widget becomes a lookup rather than a guess, and the swatch
 * shows the product's colour rather than a hash of its name.
 */
export function VariantSwatches({
  option,
  variants,
  selectedValue,
  onSelect,
}: VariantSwatchesProps) {
  const [expanded, setExpanded] = useState(false);

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
