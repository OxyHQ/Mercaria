import { Pressable, View } from 'react-native';
import type { ProductPageVariant } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';

/**
 * Which configuration a shopper is looking at (#71 identity 3, UX rules 2 and
 * 6).
 *
 * ## Selecting one is a NAVIGATION, not a local state change
 *
 * The selected variant lives in the URL, so a link to a configuration is a link
 * to that configuration, the back button returns to the previous page rather
 * than to the previous swatch, and a refresh shows the same thing. The page
 * applies it with `setParams`, which updates the URL without pushing a history
 * entry — #71 UX rule 6's "without losing navigation history".
 *
 * ## Accessibility is a radio GROUP, not a row of buttons
 *
 * `accessibilityRole="radio"` with `checked` state, inside a `radiogroup`: a
 * screen reader then announces "2 of 5, selected" rather than five unrelated
 * buttons, and keyboard focus moves through them as one control. #71 UX rule 2
 * asks for exactly this, and a `Pressable` with no role announces nothing at
 * all.
 */

export interface VariantSelectorProps {
  variants: readonly ProductPageVariant[];
  /** Absent means the page is showing every configuration's offers. */
  selectedVariantId?: string;
  onSelect: (canonicalVariantId: string | undefined) => void;
}

export function VariantSelector({ variants, selectedVariantId, onSelect }: VariantSelectorProps) {
  if (variants.length <= 1) return null;

  return (
    <View className="gap-space-8" accessibilityRole="radiogroup" accessibilityLabel="Configuration">
      <Text className="text-captionBold text-text">Configuration</Text>
      <View className="flex-row flex-wrap gap-space-8">
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: selectedVariantId === undefined }}
          accessibilityLabel="All configurations"
          onPress={() => onSelect(undefined)}
          className={`rounded-radius-max border px-space-16 py-space-8 ${
            selectedVariantId === undefined ? 'border-text bg-bg-fill' : 'border-border-secondary'
          }`}
        >
          <Text className="text-buttonMedium text-text">All</Text>
        </Pressable>

        {variants.map((variant) => {
          const label = variant.name ?? optionSummary(variant);
          return (
            <Pressable
              key={variant.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: selectedVariantId === variant.id }}
              // The offer COUNT is in the label rather than a separate badge:
              // "256 GB, Black — 4 offers" is one thing to announce, and a
              // count rendered as its own chip is a second focus stop that
              // reads as another control.
              accessibilityLabel={`${label}, ${variant.offerCount} offers on this page`}
              onPress={() => onSelect(variant.id)}
              className={`rounded-radius-max border px-space-16 py-space-8 ${
                selectedVariantId === variant.id ? 'border-text bg-bg-fill' : 'border-border-secondary'
              }`}
            >
              <Text className="text-buttonMedium text-text">{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * A configuration with no name, described by its own option assignments.
 *
 * Never a generated name like "Variant 3": the identity of a configuration IS
 * its options (ADR 0002 D13), and a positional label would move the moment
 * another configuration was minted.
 */
function optionSummary(variant: ProductPageVariant): string {
  const parts = variant.options.map((option) => option.displayValue);
  return parts.length > 0 ? parts.join(' · ') : 'Standard';
}
