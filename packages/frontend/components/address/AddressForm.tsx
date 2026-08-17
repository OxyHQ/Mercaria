import { useState } from "react";
import { View } from "react-native";
import type { CreateAddressInput } from "@mercaria/shared-types";
import { Button, Input, Label, Text } from "@mercaria/ui";
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
      <View className="gap-1.5">
        <Label>{t("address.form.recipientNameLabel")}</Label>
        <Input
          value={draft.recipientName}
          onChangeText={set("recipientName")}
          placeholder={t("address.form.recipientNamePlaceholder")}
        />
      </View>
      <View className="gap-1.5">
        <Label>{t("address.form.line1Label")}</Label>
        <Input
          value={draft.line1}
          onChangeText={set("line1")}
          placeholder={t("address.form.line1Placeholder")}
        />
      </View>
      <View className="gap-1.5">
        <Label>{t("address.form.line2Label")}</Label>
        <Input
          value={draft.line2 ?? ""}
          onChangeText={set("line2")}
          placeholder={t("address.form.line2Placeholder")}
        />
      </View>
      <View className="flex-row gap-3">
        <View className="flex-1 gap-1.5">
          <Label>{t("address.form.cityLabel")}</Label>
          <Input
            value={draft.city}
            onChangeText={set("city")}
            placeholder={t("address.form.cityPlaceholder")}
          />
        </View>
        <View className="flex-1 gap-1.5">
          <Label>{t("address.form.regionLabel")}</Label>
          <Input
            value={draft.region ?? ""}
            onChangeText={set("region")}
            placeholder={t("address.form.regionPlaceholder")}
          />
        </View>
      </View>
      <View className="flex-row gap-3">
        <View className="flex-1 gap-1.5">
          <Label>{t("address.form.postalCodeLabel")}</Label>
          <Input
            value={draft.postalCode}
            onChangeText={set("postalCode")}
            placeholder={t("address.form.postalCodePlaceholder")}
          />
        </View>
        <View className="flex-1 gap-1.5">
          <Label>{t("address.form.countryLabel")}</Label>
          <Input
            value={draft.country}
            onChangeText={set("country")}
            placeholder={t("address.form.countryPlaceholder")}
            autoCapitalize="characters"
          />
        </View>
      </View>
      <View className="gap-1.5">
        <Label>{t("address.form.phoneLabel")}</Label>
        <Input
          value={draft.phone ?? ""}
          onChangeText={set("phone")}
          placeholder={t("address.form.phonePlaceholder")}
          keyboardType="phone-pad"
        />
      </View>
      <View className="flex-row items-center gap-3">
        <Button
          className="flex-1"
          disabled={!complete}
          isLoading={isSubmitting}
          onPress={() => onSubmit(clean(draft))}
        >
          <Text className="text-sm font-semibold text-primary-foreground">{cta}</Text>
        </Button>
        {onCancel ? (
          <Button variant="outline" onPress={onCancel}>
            <Text className="text-sm font-medium text-foreground">{t("common.cancel")}</Text>
          </Button>
        ) : null}
      </View>
    </View>
  );
}
