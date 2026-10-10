import { View } from 'react-native';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type {
  VariantAxis,
  VariantMatrix,
} from '@/lib/catalog/variant-axes';

/**
 * The variant selector, one control per ACTUAL axis (#367 workstream 9).
 *
 * The axes, their order, their labels and every value's availability arrive
 * composed by `lib/catalog/variant-axes.ts`. There is no axis name and no
 * option value anywhere in this file.
 *
 * ## An unselectable value is DISABLED and says why
 *
 * `unavailable` and `impossible` are both non-selectable and are announced
 * differently, because the shopper's next action differs: an out-of-stock
 * configuration may come back, and one Mercaria has no record of will not. The
 * state is in the announced label and in the visible text, never in colour
 * alone — a greyed chip with no words is invisible to a screen reader and to
 * anybody who cannot see the grey.
 *
 * ## `unknown` is selectable
 *
 * When the offers half is withheld no configuration reports a count, every
 * value is `unknown`, and every control stays live. Disabling them would present
 * a withheld comparison as a discontinued product.
 */

export interface VariantAxisSelectorProps {
  matrix: VariantMatrix;
  onChoose: (axisKey: string, normalizedValue: string) => void;
}

export function VariantAxisSelector({ matrix, onChoose }: VariantAxisSelectorProps) {
  const { t } = useTranslation();

  if (matrix.axes.length === 0) return null;

  return (
    <View className="gap-space-16">
      {matrix.axes.map((axis) => (
        <AxisRow key={axis.key} axis={axis} onChoose={onChoose} />
      ))}
      {matrix.availabilityKnown ? null : (
        <Text className="text-shop-caption text-text-tertiary">
          {t('catalog.variants.availabilityUnknown')}
        </Text>
      )}
    </View>
  );
}

function AxisRow({
  axis,
  onChoose,
}: {
  axis: VariantAxis;
  onChoose: (axisKey: string, normalizedValue: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-space-8">
      <Text className="text-shop-captionBold text-text">{axis.label}</Text>
      <RadioGroup
        label={axis.label}
        variant="chip"
        size="lg"
        tone="neutral"
        appearance="outline"
        value={axis.values.find((value) => value.selected)?.normalizedValue}
        onValueChange={(value) => onChoose(axis.key, value)}
        options={axis.values.map((value) => {
          // Availability stays in the visible label and the accessible name.
          const suffix = value.availability === 'unavailable'
            ? t('catalog.variants.unavailable')
            : value.availability === 'impossible'
              ? t('catalog.variants.impossible')
              : undefined;
          const label = suffix === undefined ? value.displayValue : `${value.displayValue} — ${suffix}`;
          return {
            value: value.normalizedValue,
            label,
            accessibilityLabel: `${axis.label}: ${label}`,
            disabled: !value.selectable,
          };
        })}
      />
    </View>
  );
}
