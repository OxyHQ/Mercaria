import React, { useState } from "react";
import { View } from "react-native";
import type { Place } from "@goway.to/sdk";
import { Text } from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { Button } from "@oxy.so/bloom/button";
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from "@oxy.so/bloom/segmented-control";
import { toast } from "@oxy.so/bloom/toast";
import { useApplyCapabilityOperations } from "@/lib/goway/hooks";
import { goWayErrorKey } from "@/lib/goway/errors";
import {
  ACCESSIBILITY_FLAGS,
  ACCESSIBILITY_FLAG_LABEL_KEYS,
  accessibilityChoicesOf,
  accessibilityChoicesWithEdits,
  WHEELCHAIR_KEY,
  accessibilityOperations,
  type AccessibilityEdits,
  type FlagChoice,
  type WheelchairChoice,
} from "@/lib/goway/place-form";
import { useTranslation } from "@/lib/i18n";
import { retainLaterEdits } from "@/lib/locations/retain-later-edits";
import { EditorSection } from "./EditorSection";

const FLAG_CHOICES: FlagChoice[] = ["yes", "no", "unset"];
const WHEELCHAIR_CHOICES: WheelchairChoice[] = ["yes", "limited", "no", "unset"];

const CHOICE_LABEL_KEYS: Record<WheelchairChoice, string> = {
  yes: "settings.locations.editor.accessibility.yes",
  limited: "settings.locations.editor.accessibility.limited",
  no: "settings.locations.editor.accessibility.no",
  unset: "settings.locations.editor.accessibility.unset",
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
  const [edits, setEdits] = useState<AccessibilityEdits>({});
  const desired = accessibilityChoicesWithEdits(current, edits);
  const operations = accessibilityOperations(current, desired);

  const save = () => {
    if (apply.isPending) return;
    const submitted = edits;
    // A later successful read may already confirm a previously uncertain save.
    // Acknowledge it locally rather than asserting the same capability again.
    if (operations.length === 0) { setEdits({}); return; }
    apply.mutate(operations, {
      onSuccess: ({ confirmed, error }) => {
        if (!confirmed) { toast.error(t(goWayErrorKey(error))); return; }
        setEdits(latest => retainLaterEdits(latest, submitted));
        toast.success(t("settings.locations.editor.accessibility.saved"));
      },
      onError: (error) => toast.error(t(goWayErrorKey(error))),
    });
  };

  return (
    <EditorSection
      title={t("settings.locations.editor.accessibility.title")}
      description={t("settings.locations.editor.accessibility.description")}
    >
      <Field label={t("settings.locations.editor.accessibility.wheelchair")}>
        <SegmentedControl
          type="radio"
          value={desired.wheelchair}
          onValueChange={(wheelchair) => setEdits((state) => ({ ...state, [WHEELCHAIR_KEY]: wheelchair }))}
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
              setEdits((state) => ({ ...state, [key]: choice }))
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
        <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.accessibility.hint")}</Text>
        <Button tone="accent" loading={apply.isPending} disabled={apply.isPending || Object.keys(edits).length === 0} onPress={save}>
          {t("settings.locations.editor.accessibility.save")}
        </Button>
      </View>
    </EditorSection>
  );
}
