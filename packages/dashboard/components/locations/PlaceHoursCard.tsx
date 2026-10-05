import React, { useState } from "react";
import { View } from "react-native";
import type { Place } from "@goway.to/sdk";
import { Text } from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { toast } from "@oxy.so/bloom/toast";
import { useUpdateGoWayPlace } from "@/lib/goway/hooks";
import { goWayErrorKey } from "@/lib/goway/errors";
import { EDITOR_WEEK, WEEKDAY_LABEL_KEYS, intervalsOf, weekTextOf, type WeekText } from "@/lib/goway/hours";
import { useTranslation } from "@/lib/i18n";
import { EditorSection } from "./EditorSection";

/**
 * The place's weekly hours, written to GoWay whole (ADR 0013).
 *
 * Read in the place's own timezone, which GoWay derives from where the place
 * is — so there is no timezone field to get wrong here. Shown under the
 * editor's key so a refetched place resets the fields.
 */
export function PlaceHoursCard({ place }: { place: Place }) {
  const { t } = useTranslation();
  const update = useUpdateGoWayPlace(place.id);
  const [week, setWeek] = useState<WeekText>(() => weekTextOf(place.openingHours?.intervals ?? []));

  const save = () => {
    const read = intervalsOf(week);
    if (!read.ok) {
      toast.error(t("settings.locations.editor.hours.unreadable", { day: t(WEEKDAY_LABEL_KEYS[read.day]) }));
      return;
    }
    update.mutate(
      { openingHours: { intervals: read.intervals } },
      {
        onSuccess: () => toast.success(t("settings.locations.editor.hours.saved")),
        onError: (error) => toast.error(t(goWayErrorKey(error))),
      },
    );
  };

  return (
    <EditorSection
      title={t("settings.locations.editor.hours.title")}
      description={t("settings.locations.editor.hours.description", {
        timezone: place.timezone ?? t("settings.locations.editor.hours.noTimezone"),
      })}
    >
      {place.openingHours?.raw && place.openingHours.intervals.length === 0 ? (
        <Text className="text-xs text-muted-foreground">
          {t("settings.locations.editor.hours.raw", { raw: place.openingHours.raw })}
        </Text>
      ) : null}
      <View className="gap-2">
        {EDITOR_WEEK.map((day) => (
          <Field key={day} label={t(WEEKDAY_LABEL_KEYS[day])}>
            <TextFieldInput
              label={t(WEEKDAY_LABEL_KEYS[day])}
              value={week[day]}
              onValueChange={(value) => setWeek((current) => ({ ...current, [day]: value }))}
              placeholder={t("settings.locations.editor.hours.placeholder")}
              autoCorrect={false}
            />
          </Field>
        ))}
      </View>
      <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.hours.hint")}</Text>
      <Button tone="accent" loading={update.isPending} onPress={save}>
        {t("settings.locations.editor.hours.save")}
      </Button>
    </EditorSection>
  );
}
