import React, { useState } from "react";
import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { Chip } from "@oxy.so/bloom/chip";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

export interface ProductOrganizationValue {
  vendor: string;
  productType: string;
  tags: string[];
}

/** Merchandising fields from Listing, distinct from the authoring taxonomy. */
export function ProductOrganization({ category, value, onChange, errors, disabled, busy }: {
  category: string;
  value: ProductOrganizationValue;
  onChange: (value: ProductOrganizationValue) => void;
  errors: { vendor: boolean; productType: boolean };
  disabled: boolean;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [tag, setTag] = useState("");
  const addTag = () => {
    const next = tag.trim();
    if (disabled || busy || !next) return;
    if (!value.tags.includes(next)) onChange({ ...value, tags: [...value.tags, next] });
    setTag("");
  };
  return <View testID="merchant-product-organization" className="gap-4 rounded-xl border border-border bg-white p-4 dark:bg-surface">
    <Text className="text-sm font-semibold text-foreground">{t("products.detail.organization.heading")}</Text>
    {category ? <View className="gap-1"><Text className="text-sm text-muted-foreground">{t("products.wizard.review.category")}</Text><Text className="text-sm text-foreground">{category}</Text></View> : null}
    <Field label={t("products.new.vendorLabel")} error={errors.vendor ? t("products.wizard.fields.required") : undefined}><TextFieldInput label={t("products.new.vendorLabel")} placeholder={null}
      value={value.vendor} onValueChange={vendor => onChange({ ...value, vendor })} disabled={disabled || busy} /></Field>
    <Field label={t("products.wizard.review.productType")} error={errors.productType ? t("products.wizard.fields.required") : undefined}><TextFieldInput label={t("products.wizard.review.productType")} placeholder={null}
      value={value.productType} onValueChange={productType => onChange({ ...value, productType })} disabled={disabled || busy} /></Field>
    <View className="gap-2">
      <Text className="text-sm text-foreground">{t("products.detail.organization.tags")}</Text>
      <View className="flex-row flex-wrap gap-2">{value.tags.map((item, index) => <Chip key={`${item}:${index}`} size="sm" variant="subtle" disabled={disabled || busy}
        onClose={disabled ? undefined : () => { if (!busy) onChange({ ...value, tags: value.tags.filter((_, position) => position !== index) }); }}
        closeLabel={t("products.detail.organization.removeTag", { tag: item })}>{item}</Chip>)}</View>
      {!disabled ? <View className="gap-2">
        <TextFieldInput label={t("products.detail.organization.addTag")} placeholder={null} value={tag} onValueChange={setTag} onSubmitEditing={addTag} disabled={busy} />
        <Button size="sm" appearance="outline" material="flat" onPress={addTag} disabled={busy || !tag.trim()}>{t("products.detail.organization.addTag")}</Button>
      </View> : null}
    </View>
  </View>;
}
