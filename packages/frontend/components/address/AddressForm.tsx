import { useState } from "react";
import { View } from "react-native";
import type { CreateAddressInput } from "@mercaria/shared-types";
import { Button, Input, Label, Text } from "@mercaria/ui";

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
  /** CTA label (default "Save address"). */
  submitLabel?: string;
}

/** A controlled shipping-address form, reused by checkout and settings. */
export function AddressForm({
  initial,
  onSubmit,
  onCancel,
  isSubmitting,
  submitLabel = "Save address",
}: AddressFormProps) {
  const [draft, setDraft] = useState<CreateAddressInput>(initial ?? EMPTY);

  const set = (key: keyof CreateAddressInput) => (value: string) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const complete = isComplete(draft);

  return (
    <View className="gap-3">
      <View className="gap-1.5">
        <Label>Recipient name</Label>
        <Input value={draft.recipientName} onChangeText={set("recipientName")} placeholder="Jane Doe" />
      </View>
      <View className="gap-1.5">
        <Label>Address line 1</Label>
        <Input value={draft.line1} onChangeText={set("line1")} placeholder="1 Market St" />
      </View>
      <View className="gap-1.5">
        <Label>Address line 2 (optional)</Label>
        <Input value={draft.line2 ?? ""} onChangeText={set("line2")} placeholder="Apt 4B" />
      </View>
      <View className="flex-row gap-3">
        <View className="flex-1 gap-1.5">
          <Label>City</Label>
          <Input value={draft.city} onChangeText={set("city")} placeholder="San Francisco" />
        </View>
        <View className="flex-1 gap-1.5">
          <Label>Region (optional)</Label>
          <Input value={draft.region ?? ""} onChangeText={set("region")} placeholder="CA" />
        </View>
      </View>
      <View className="flex-row gap-3">
        <View className="flex-1 gap-1.5">
          <Label>Postal code</Label>
          <Input value={draft.postalCode} onChangeText={set("postalCode")} placeholder="94103" />
        </View>
        <View className="flex-1 gap-1.5">
          <Label>Country</Label>
          <Input
            value={draft.country}
            onChangeText={set("country")}
            placeholder="US"
            autoCapitalize="characters"
          />
        </View>
      </View>
      <View className="gap-1.5">
        <Label>Phone (optional)</Label>
        <Input
          value={draft.phone ?? ""}
          onChangeText={set("phone")}
          placeholder="+1 555 000 0000"
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
          <Text className="text-sm font-semibold text-primary-foreground">{submitLabel}</Text>
        </Button>
        {onCancel ? (
          <Button variant="outline" onPress={onCancel}>
            <Text className="text-sm font-medium text-foreground">Cancel</Text>
          </Button>
        ) : null}
      </View>
    </View>
  );
}
