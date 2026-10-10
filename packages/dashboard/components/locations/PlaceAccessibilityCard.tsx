import React, { useState } from 'react';
import { View } from 'react-native';
import type { Place } from '@goway.to/sdk';
import { Text } from '@mercaria/ui';
import { Field } from '@oxy.so/bloom/field';
import { Button } from '@oxy.so/bloom/button';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { useApplyCapabilityOperations } from '@/lib/goway/hooks';
import { goWayErrorKey } from '@/lib/goway/errors';
import {
  ACCESSIBILITY_FLAGS,
  ACCESSIBILITY_FLAG_LABEL_KEYS,
  accessibilityChoicesOf,
  accessibilityOperations,
  type AccessibilityChoices,
  type FlagChoice,
  type WheelchairChoice,
} from '@/lib/goway/place-form';
import { useTranslation } from '@/lib/i18n';
import { EditorSection } from './EditorSection';

const FLAG_CHOICES: FlagChoice[] = ['yes', 'no', 'unset'];
const WHEELCHAIR_CHOICES: WheelchairChoice[] = ['yes', 'limited', 'no', 'unset'];

const CHOICE_LABEL_KEYS: Record<WheelchairChoice, string> = {
  yes: 'settings.locations.editor.accessibility.yes',
  limited: 'settings.locations.editor.accessibility.limited',
  no: 'settings.locations.editor.accessibility.no',
  unset: 'settings.locations.editor.accessibility.unset',
};

/**
 * The place's accessibility, as GoWay capabilities asserted by the business.
 *
 * Each choice shows the place's STRONGEST assertion today, which may be a
 * passer-by's; saving writes only what the merchant changed, at the tier their
 * claim earns. "Not stated" withdraws the business's own assertion — a
 * community report beside it stays, which is GoWay's rule and the hint says so.
 */
export function PlaceAccessibilityCard({ place }: { place: Place }) {
  const { t } = useTranslation();
  const apply = useApplyCapabilityOperations(place.id);
  const current = accessibilityChoicesOf(place);
  const [desired, setDesired] = useState<AccessibilityChoices>(current);

  const save = () => {
    const operations = accessibilityOperations(current, desired);
    if (operations.length === 0) return;
    apply.mutate(operations, {
      onSuccess: () => toast.success(t('settings.locations.editor.accessibility.saved')),
      onError: (error) => toast.error(t(goWayErrorKey(error))),
    });
  };

  return (
    <EditorSection
      title={t('settings.locations.editor.accessibility.title')}
      description={t('settings.locations.editor.accessibility.description')}
    >
      <Field label={t('settings.locations.editor.accessibility.wheelchair')}>
        <SegmentedControl
          type="radio"
          value={desired.wheelchair}
          onValueChange={(wheelchair) => setDesired((state) => ({ ...state, wheelchair }))}
        >
          {WHEELCHAIR_CHOICES.map((choice) => (
            <SegmentedControlItem key={choice} value={choice}>
              <SegmentedControlItemText>{t(CHOICE_LABEL_KEYS[choice])}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>
      {ACCESSIBILITY_FLAGS.map((key) => (
        <Field key={key} label={t(ACCESSIBILITY_FLAG_LABEL_KEYS[key])}>
          <SegmentedControl
            type="radio"
            value={desired.flags[key]}
            onValueChange={(choice) =>
              setDesired((state) => ({ ...state, flags: { ...state.flags, [key]: choice } }))
            }
          >
            {FLAG_CHOICES.map((choice) => (
              <SegmentedControlItem key={choice} value={choice}>
                <SegmentedControlItemText>{t(CHOICE_LABEL_KEYS[choice])}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>
      ))}
      <View className="gap-2">
        <Text className="text-xs text-muted-foreground">
          {t('settings.locations.editor.accessibility.hint')}
        </Text>
        <Button tone="accent" loading={apply.isPending} onPress={save}>
          {t('settings.locations.editor.accessibility.save')}
        </Button>
      </View>
    </EditorSection>
  );
}
