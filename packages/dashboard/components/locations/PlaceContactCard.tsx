import React, { useState } from "react";
import type { Place } from "@goway.to/sdk";
import { Text } from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { toast } from "@oxy.so/bloom/toast";
import { useUpdateGoWayPlace } from "@/lib/goway/hooks";
import { goWayErrorKey } from "@/lib/goway/errors";
import { contactDraftOf, contactInputOf, type ContactDraft } from "@/lib/goway/place-form";
import { useTranslation } from "@/lib/i18n";
import { retainLaterEdits } from "@/lib/locations/retain-later-edits";
import { EditorSection } from "./EditorSection";

/** The place's public phone, email and website, written to GoWay. */
export function PlaceContactCard({ place }: { place: Place }) {
  const { t } = useTranslation();
  const update = useUpdateGoWayPlace(place.id);
  const [edits, setEdits] = useState<Partial<ContactDraft>>({});
  const draft = { ...contactDraftOf(place.contact), ...edits };

  const save = () => {
    if (update.isPending) return;
    const submitted = edits;
    const built = contactInputOf(submitted);
    if (!built.ok) {
      toast.error(t(built.errorKey));
      return;
    }
    if (Object.keys(built.contact).length === 0) return;
    update.mutate(
      { contact: built.contact },
      {
        onSuccess: () => {
          setEdits(current => retainLaterEdits(current, submitted));
          toast.success(t("settings.locations.editor.contact.saved"));
        },
        onError: (error) => toast.error(t(goWayErrorKey(error))),
      },
    );
  };

  const field = (key: keyof ContactDraft) => ({
    value: draft[key],
    onValueChange: (value: string) => setEdits((current) => ({ ...current, [key]: value })),
  });

  return (
    <EditorSection
      title={t("settings.locations.editor.contact.title")}
      description={t("settings.locations.editor.contact.description")}
    >
      <Field label={t("settings.locations.editor.contact.phone")}>
        <TextFieldInput label={t("settings.locations.editor.contact.phone")} keyboardType="phone-pad" {...field("phone")} />
      </Field>
      <Field label={t("settings.locations.editor.contact.email")}>
        <TextFieldInput
          label={t("settings.locations.editor.contact.email")}
          keyboardType="email-address"
          autoCapitalize="none"
          {...field("email")}
        />
      </Field>
      <Field label={t("settings.locations.editor.contact.website")}>
        <TextFieldInput
          label={t("settings.locations.editor.contact.website")}
          keyboardType="url"
          autoCapitalize="none"
          {...field("website")}
        />
      </Field>
      <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.contact.hint")}</Text>
      <Button tone="accent" loading={update.isPending} disabled={Object.keys(edits).length === 0 || update.isPending} onPress={save}>
        {t("settings.locations.editor.contact.save")}
      </Button>
    </EditorSection>
  );
}
