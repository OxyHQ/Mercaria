import { View } from 'react-native';
import { RadioGroup } from '@oxy.so/bloom/radio';
import type { ProductPageVariant } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';

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
 * Bloom owns the radio semantics, one tab stop, arrow navigation and RTL
 * behavior. The page owns the selected configuration through its URL.
 */

export interface VariantSelectorProps {
  variants: readonly ProductPageVariant[];
  /** Absent means the page is showing every configuration's offers. */
  selectedVariantId?: string;
  onSelect: (canonicalVariantId: string | undefined) => void;
}

export function VariantSelector({ variants, selectedVariantId, onSelect }: VariantSelectorProps) {
  const { t } = useTranslation();

  if (variants.length <= 1) return null;

  return (
    <View className="gap-space-8">
      <Text className="text-shop-captionBold text-text">{t('product.variant.configuration')}</Text>
      <RadioGroup
        label={t('product.variant.configuration')}
        variant="chip"
        size="md"
        tone="neutral"
        appearance="outline"
        value={selectedVariantId ?? ''}
        onValueChange={(value) => onSelect(value || undefined)}
        options={[
          {
            value: '',
            label: t('product.variant.all'),
            accessibilityLabel: t('product.variant.allConfigurationsA11y'),
          },
          ...variants.map((variant) => {
            const label = variant.name ?? optionSummary(variant) ?? t('product.variant.standard');
            return {
              value: variant.id,
              label,
              // An unavailable comparison has no offer count, not zero offers.
              accessibilityLabel:
                variant.offerCount === undefined
                  ? label
                  : t('product.variant.offerCountA11y', { label, count: variant.offerCount }),
            };
          }),
        ]}
      />
    </View>
  );
}

/**
 * A configuration with no name, described by its own option assignments.
 *
 * Never a generated name like "Variant 3": the identity of a configuration IS
 * its options (ADR 0002 D13), and a positional label would move the moment
 * another configuration was minted.
 *
 * `undefined` rather than a fallback word: the fallback is COPY and this
 * function composes DATA, so the caller resolves `product.variant.standard`
 * against the locale in force rather than this module freezing English into a
 * value it returns at import time.
 */
function optionSummary(variant: ProductPageVariant): string | undefined {
  const parts = variant.options.map((option) => option.displayValue);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
