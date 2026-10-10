import React, { useState } from "react";
import { View } from "react-native";
import type { CurrencyCode, Listing } from "@mercaria/shared-types";
import { Button } from "@oxy.so/bloom/button";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Text } from "@mercaria/ui";
import { useCreateVariant } from "@/lib/hooks/use-products";
import { useTranslation } from "@/lib/i18n";
import { parseInventoryQuantity } from "@/lib/inventory-quantity";
import { toMinorUnits } from "@/lib/money";
import { sameVariantCombination } from "@/lib/variant-combination";

/** One complete option combination, submitted through the existing variant API. */
export function CreateVariantForm({ storeId, product, currency, onClose }: {
  storeId: string; product: Listing; currency?: CurrencyCode; onClose: () => void;
}) {
  const { t } = useTranslation();
  const mutation = useCreateVariant(storeId, product.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [submitted, setSubmitted] = useState(false);
  const options = product.options ?? [];
  const optionValues = options.map(option => ({ name: option.name, value: (values[option.name] ?? "").trim() }));
  const complete = optionValues.every(option => option.value.length > 0);
  const duplicate = complete && product.variants.some(variant => sameVariantCombination(optionValues, variant.optionValues));
  const amount = currency ? toMinorUnits(price, currency) : null;
  const available = parseInventoryQuantity(stock);
  const save = () => {
    setSubmitted(true);
    if (mutation.isPending || !currency || !complete || duplicate || amount === null || available === null) return;
    mutation.mutate({ optionValues, price: { amount, currency }, inventory: { available } }, { onSuccess: onClose });
  };
  return <View testID="merchant-create-variant" className="mb-3 gap-3 rounded-xl border border-border p-3">
    <View className="gap-3 sm:flex-row sm:flex-wrap">
      {options.map(option => <View key={option.name} className="min-w-0 sm:min-w-40 sm:flex-1">
        <Field label={option.name} error={submitted && !(values[option.name] ?? "").trim() ? t("products.variants.optionRequired") : undefined}>
          <TextFieldInput label={option.name} value={values[option.name] ?? ""} placeholder={t("products.variants.valuePlaceholder")}
            disabled={mutation.isPending} onValueChange={value => setValues(previous => ({ ...previous, [option.name]: value }))} />
        </Field>
      </View>)}
    </View>
    <View className="flex-row gap-2">
      <View className="min-w-0 flex-1"><Field label={`${t("resourceList.price")} (${currency ?? ""})`} error={submitted && amount === null ? t("products.variants.priceInvalid") : undefined}>
        <TextFieldInput label={`${t("resourceList.price")} (${currency ?? ""})`} value={price} onValueChange={setPrice}
          keyboardType="decimal-pad" placeholder="0.00" disabled={mutation.isPending} />
      </Field></View>
      <View className="min-w-0 flex-1"><Field label={t("products.stockLabel")} error={submitted && available === null ? t("products.variants.inventory.invalid") : undefined}>
        <TextFieldInput label={t("products.stockLabel")} value={stock} onValueChange={setStock} keyboardType="number-pad" placeholder="0" disabled={mutation.isPending} />
      </Field></View>
    </View>
    <View className="min-h-5" accessibilityLiveRegion="polite">
      {duplicate ? <Text className="text-sm text-destructive">{t("products.variants.duplicateCombination")}</Text>
        : mutation.isError ? <Text className="text-sm text-destructive">{t("products.variants.addFailed")}</Text> : null}
    </View>
    <View className="flex-row flex-wrap gap-2">
      <Button size="sm" tone="accent" onPress={save} disabled={!currency || duplicate} loading={mutation.isPending}>{t("products.variants.saveVariant")}</Button>
      <Button size="sm" appearance="outline" material="flat" disabled={mutation.isPending} onPress={onClose}>{t("common.cancel")}</Button>
    </View>
  </View>;
}
