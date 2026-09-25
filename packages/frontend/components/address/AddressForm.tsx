import { useState } from "react";
import { Button } from "@oxy.so/bloom/button";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { View } from "react-native";
import type { CreateAddressInput } from "@mercaria/shared-types";
import { useTranslation } from "@/lib/i18n";

/** Required fields per `CreateAddressInput` (server enforces the same set). */
function isComplete(draft: CreateAddressInput): boolean {
  return (
    draft.recipientName.trim().length > 0 &&
    draft.line1.trim().length > 0 &&
    draft.city.trim().length > 0 &&
    draft.postalCode.trim().length > 0 &&
    draft.country.trim().length > 0
  );
}

/** Trim every string field, dropping empty optionals so we never send "". */
function clean(draft: CreateAddressInput): CreateAddressInput {
  const out: CreateAddressInput = {
    recipientName: draft.recipientName.trim(),
    line1: draft.line1.trim(),
    city: draft.city.trim(),
    postalCode: draft.postalCode.trim(),
    country: draft.country.trim(),
  };
  if (draft.label?.trim()) out.label = draft.label.trim();
  if (draft.line2?.trim()) out.line2 = draft.line2.trim();
  if (draft.region?.trim()) out.region = draft.region.trim();
  if (draft.phone?.trim()) out.phone = draft.phone.trim();
  return out;
}

const EMPTY: CreateAddressInput = {
  recipientName: "",
  line1: "",
  city: "",
  postalCode: "",
  country: "",
};

export interface AddressFormProps {
  /** Pre-fill the form (edit mode). */
  initial?: CreateAddressInput;
  /** Submit handler — receives a cleaned, complete input. */
  onSubmit: (input: CreateAddressInput) => void;
  /** Cancel handler (hides the form). */
  onCancel?: () => void;
  /** Spinner + disabled state while the mutation runs. */
  isSubmitting?: boolean;
  /** CTA label. Defaults to the translated "Save address". */
  submitLabel?: string;
}

/** A controlled shipping-address form, reused by checkout and settings. */
export function AddressForm({
  initial,
  onSubmit,
  onCancel,
  isSubmitting,
  submitLabel,
}: AddressFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CreateAddressInput>(initial ?? EMPTY);
  // Resolved in the body, not as a parameter default: a default is evaluated
  // before `t` exists, and a module-scope sentence would freeze whichever
  // language loaded first.
  const cta = submitLabel ?? t("address.form.submit");

  const set = (key: keyof CreateAddressInput) => (value: string) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const complete = isComplete(draft);

  return (
    <View className="gap-3">
      <Field label={t("address.form.recipientNameLabel")}>
        <TextFieldInput
          label={t("address.form.recipientNameLabel")}
          value={draft.recipientName}
          onValueChange={set("recipientName")}
          placeholder={t("address.form.recipientNamePlaceholder")}
        />
      </Field>
      <Field label={t("address.form.line1Label")}>
        <TextFieldInput
          label={t("address.form.line1Label")}
          value={draft.line1}
          onValueChange={set("line1")}
          placeholder={t("address.form.line1Placeholder")}
        />
      </Field>
      <Field label={t("address.form.line2Label")}>
        <TextFieldInput
          label={t("address.form.line2Label")}
          value={draft.line2 ?? ""}
          onValueChange={set("line2")}
          placeholder={t("address.form.line2Placeholder")}
        />
      </Field>
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Field label={t("address.form.cityLabel")}>
            <TextFieldInput
              label={t("address.form.cityLabel")}
              value={draft.city}
              onValueChange={set("city")}
              placeholder={t("address.form.cityPlaceholder")}
            />
          </Field>
        </View>
        <View className="flex-1">
          <Field label={t("address.form.regionLabel")}>
            <TextFieldInput
              label={t("address.form.regionLabel")}
              value={draft.region ?? ""}
              onValueChange={set("region")}
              placeholder={t("address.form.regionPlaceholder")}
            />
          </Field>
        </View>
      </View>
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Field label={t("address.form.postalCodeLabel")}>
            <TextFieldInput
              label={t("address.form.postalCodeLabel")}
              value={draft.postalCode}
              onValueChange={set("postalCode")}
              placeholder={t("address.form.postalCodePlaceholder")}
            />
          </Field>
        </View>
        <View className="flex-1">
          <Field label={t("address.form.countryLabel")}>
            <TextFieldInput
              label={t("address.form.countryLabel")}
              value={draft.country}
              onValueChange={set("country")}
              placeholder={t("address.form.countryPlaceholder")}
              autoCapitalize="characters"
            />
          </Field>
        </View>
      </View>
      <Field label={t("address.form.phoneLabel")}>
        <TextFieldInput
          label={t("address.form.phoneLabel")}
          value={draft.phone ?? ""}
          onValueChange={set("phone")}
          placeholder={t("address.form.phonePlaceholder")}
          keyboardType="phone-pad"
        />
      </Field>
      <View className="flex-row items-center gap-3">
        <Button
          tone="accent"
          className="flex-1"
          disabled={!complete}
          loading={isSubmitting}
          onPress={() => onSubmit(clean(draft))}
        >
          {cta}
        </Button>
        {onCancel ? (
          <Button appearance="outline" tone="neutral" onPress={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}
