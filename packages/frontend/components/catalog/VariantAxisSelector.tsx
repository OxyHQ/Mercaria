import { Pressable, View } from 'react-native';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type {
  VariantAxis,
  VariantAxisValue,
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
        <Text className="text-caption text-text-tertiary">
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
  return (
    <View className="gap-space-8">
      <Text className="text-captionBold text-text">{axis.label}</Text>
      <View
        className="flex-row flex-wrap gap-space-8"
        accessibilityRole="radiogroup"
        accessibilityLabel={axis.label}
      >
        {axis.values.map((value) => (
          <AxisValueChip
            key={value.normalizedValue}
            axisKey={axis.key}
            axisLabel={axis.label}
            value={value}
            onChoose={onChoose}
          />
        ))}
      </View>
    </View>
  );
}

function AxisValueChip({
  axisKey,
  axisLabel,
  value,
  onChoose,
}: {
  axisKey: string;
  axisLabel: string;
  value: VariantAxisValue;
  onChoose: (axisKey: string, normalizedValue: string) => void;
}) {
  const { t } = useTranslation();

  // The suffix is the availability, in words, in the visible label AND in the
  // announced one. `available` and `unknown` add nothing: a chip that reads
  // "Black — available" on every selectable value is noise that hides the two
  // that matter.
  const suffix =
    value.availability === 'unavailable'
      ? t('catalog.variants.unavailable')
      : value.availability === 'impossible'
        ? t('catalog.variants.impossible')
        : undefined;

  const visible = suffix === undefined ? value.displayValue : `${value.displayValue} — ${suffix}`;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: value.selected, disabled: !value.selectable }}
      accessibilityLabel={`${axisLabel}: ${visible}`}
      disabled={!value.selectable}
      onPress={() => onChoose(axisKey, value.normalizedValue)}
      className={chipClassName(value)}
    >
      <Text
        className={value.selectable ? 'text-caption text-text' : 'text-caption text-text-tertiary'}
      >
        {value.selected ? `${visible} ✓` : visible}
      </Text>
    </Pressable>
  );
}

function chipClassName(value: VariantAxisValue): string {
  if (value.selected) {
    return 'rounded-radius-max border border-text bg-bg-fill px-space-16 py-space-8';
  }
  if (!value.selectable) {
    return 'rounded-radius-max border border-border-secondary px-space-16 py-space-8 opacity-60';
  }
  return 'rounded-radius-max border border-border-secondary px-space-16 py-space-8';
}
