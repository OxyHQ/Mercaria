import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { Trash2 } from "lucide-react-native";
import type { PlaceHoursException } from "@goway.to/sdk";
import { Text, useColorScheme } from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { Switch } from "@oxy.so/bloom/switch";
import { toast } from "@oxy.so/bloom/toast";
import {
  useCreateHoursException,
  useDeleteHoursException,
  useHoursExceptions,
} from "@/lib/goway/hooks";
import { goWayErrorKey } from "@/lib/goway/errors";
import { formatRanges } from "@/lib/goway/hours";
import { EMPTY_EXCEPTION_DRAFT, hoursExceptionInputOf, type ExceptionDraft } from "@/lib/goway/place-form";
import { useTranslation } from "@/lib/i18n";
import { EditorSection } from "./EditorSection";

/**
 * Dated exceptions to the place's week — a holiday closure, a late night —
 * written to GoWay (ADR 0013). What used to be Mercaria's own closures.
 *
 * Past exceptions are listed too: GoWay keeps them, and "why were we shown
 * closed on the 6th" is the question they answer. Only the business's own
 * exception can be withdrawn; GoWay refuses the rest and the error says so.
 */
export function HoursExceptionsCard({ placeId }: { placeId: string }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const exceptions = useHoursExceptions(placeId);
  const create = useCreateHoursException(placeId);
  const remove = useDeleteHoursException(placeId);
  const [draft, setDraft] = useState<ExceptionDraft>(EMPTY_EXCEPTION_DRAFT);

  const add = () => {
    const built = hoursExceptionInputOf(draft);
    if (!built.ok) {
      toast.error(t(built.errorKey));
      return;
    }
    create.mutate(built.input, {
      onSuccess: () => {
        toast.success(t("settings.locations.editor.exceptions.added"));
        setDraft(EMPTY_EXCEPTION_DRAFT);
      },
      onError: (error) => toast.error(t(goWayErrorKey(error))),
    });
  };

  const field = (key: "startsOn" | "endsOn" | "hours" | "note") => ({
    value: draft[key],
    onValueChange: (value: string) => setDraft((current) => ({ ...current, [key]: value })),
  });

  return (
    <EditorSection
      title={t("settings.locations.editor.exceptions.title")}
      description={t("settings.locations.editor.exceptions.description")}
    >
      {exceptions.isError ? (
        <Text className="text-sm text-muted-foreground">{t(goWayErrorKey(exceptions.error))}</Text>
      ) : exceptions.data?.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t("settings.locations.editor.exceptions.none")}</Text>
      ) : null}
      {exceptions.data?.map((exception) => (
        <ExceptionRow
          key={exception.id}
          exception={exception}
          iconColor={colors.mutedForeground}
          onRemove={() =>
            remove.mutate(exception.id, {
              onSuccess: () => toast.success(t("settings.locations.editor.exceptions.removed")),
              onError: (error) => toast.error(t(goWayErrorKey(error))),
            })
          }
        />
      ))}

      <View className="gap-3 rounded-xl border border-border p-3">
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Field label={t("settings.locations.editor.exceptions.startsOn")}>
              <TextFieldInput
                label={t("settings.locations.editor.exceptions.startsOn")}
                placeholder={t("settings.locations.editor.exceptions.datePlaceholder")}
                {...field("startsOn")}
              />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={t("settings.locations.editor.exceptions.endsOn")}>
              <TextFieldInput
                label={t("settings.locations.editor.exceptions.endsOn")}
                placeholder={t("settings.locations.editor.exceptions.datePlaceholder")}
                {...field("endsOn")}
              />
            </Field>
          </View>
        </View>
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm text-foreground">{t("settings.locations.editor.exceptions.closed")}</Text>
          <Switch
            checked={draft.closed}
            onCheckedChange={(closed) => setDraft((current) => ({ ...current, closed }))}
            accessibilityLabel={t("settings.locations.editor.exceptions.closed")}
          />
        </View>
        {draft.closed ? null : (
          <Field label={t("settings.locations.editor.exceptions.hours")}>
            <TextFieldInput
              label={t("settings.locations.editor.exceptions.hours")}
              placeholder={t("settings.locations.editor.hours.placeholder")}
              {...field("hours")}
            />
          </Field>
        )}
        <Field label={t("settings.locations.editor.exceptions.note")}>
          <TextFieldInput label={t("settings.locations.editor.exceptions.note")} {...field("note")} />
        </Field>
        <Button tone="accent" loading={create.isPending} onPress={add}>
          {t("settings.locations.editor.exceptions.add")}
        </Button>
      </View>
    </EditorSection>
  );
}

function ExceptionRow({
  exception,
  iconColor,
  onRemove,
}: {
  exception: PlaceHoursException;
  iconColor: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const dates =
    exception.startsOn === exception.endsOn
      ? exception.startsOn
      : t("settings.locations.editor.exceptions.range", { from: exception.startsOn, to: exception.endsOn });
  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-border p-3">
      <View className="flex-1">
        <Text className="text-sm text-foreground">{dates}</Text>
        <Text className="text-xs text-muted-foreground">
          {exception.closed
            ? t("settings.locations.editor.exceptions.closedAllDay")
            : formatRanges(exception.intervals)}
          {exception.note ? t("settings.locations.editor.exceptions.noteSuffix", { note: exception.note }) : ""}
        </Text>
      </View>
      {exception.verification === "business_asserted" ? (
        <Pressable
          onPress={onRemove}
          accessibilityLabel={t("settings.locations.editor.exceptions.remove")}
          className="p-2 active:opacity-70"
        >
          <Trash2 size={16} color={iconColor} />
        </Pressable>
      ) : null}
    </View>
  );
}
