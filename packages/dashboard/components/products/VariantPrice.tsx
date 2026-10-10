import React, { useState } from "react";
import { View } from "react-native";
import type { CurrencyCode, ProductVariantDTO } from "@mercaria/shared-types";
import { Button } from "@oxy.so/bloom/button";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Text } from "@mercaria/ui";
import { useUpdateVariant } from "@/lib/hooks/use-products";
import { useTranslation } from "@/lib/i18n";
import { toMajorString, toMinorUnits } from "@/lib/money";

export function VariantPrice({ storeId, productId, variant, canWrite }: {
  storeId: string; productId: string; variant: ProductVariantDTO; canWrite: boolean;
}) {
  const { t } = useTranslation();
  const mutation = useUpdateVariant(storeId, productId);
  const [draft, setDraft] = useState<{ value: string; currency: CurrencyCode }>();
  // Unedited fields follow the server. A dirty amount keeps its currency too:
  // a refetch must never silently re-denominate the merchant's typed number.
  const currency = draft?.currency ?? variant.price.currency;
  const value = draft?.value ?? toMajorString(variant.price.amount, currency);
  const amount = toMinorUnits(value, currency);
  const currencyChanged = currency !== variant.price.currency;
  const changed = draft !== undefined && (currencyChanged || amount !== variant.price.amount);
  const save = () => {
    if (!canWrite || mutation.isPending || currencyChanged || amount === null || !changed) return;
    mutation.mutate({ variantId: variant.id, input: { price: { amount, currency } } }, { onSuccess: () => setDraft(undefined) });
  };
  return <View testID="merchant-variant-price" className="gap-2">
    <Field label={`${t("resourceList.price")} (${currency})`} error={currencyChanged ? t("products.variants.currencyChanged") : amount === null ? t("products.variants.priceInvalid") : undefined}>
      <TextFieldInput label={`${t("resourceList.price")} (${currency})`} placeholder={null} value={value} keyboardType="decimal-pad"
        disabled={!canWrite || mutation.isPending} onValueChange={next => { setDraft({ value: next, currency }); mutation.reset(); }} />
    </Field>
    {canWrite ? <View className="flex-row gap-2">
      <Button size="sm" appearance="outline" material="flat" onPress={save} disabled={!changed || currencyChanged || amount === null} loading={mutation.isPending}>{t("common.save")}</Button>
      {draft ? <Button size="sm" appearance="outline" material="flat" disabled={mutation.isPending} onPress={() => { setDraft(undefined); mutation.reset(); }}>{t("common.cancel")}</Button> : null}
    </View> : null}
    <View className="min-h-5" accessibilityLiveRegion="polite">
      {mutation.isError ? <Text className="text-sm text-destructive">{t("products.variants.updateFailed")}</Text>
        : mutation.isSuccess ? <Text className="text-sm text-muted-foreground">{t("products.variants.updated")}</Text> : null}
    </View>
  </View>;
}
