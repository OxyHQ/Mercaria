import React, { useState } from "react";
import { View } from "react-native";
import type { AuthoringSchema, CurrencyCode } from "@mercaria/shared-types";
import { ALL_CURRENCY_CODES } from "@mercaria/shared-types";
import { Button, Input, Label, Switch, Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { findingMessageKey, findingsForVariant, type LocatedFinding } from "@/lib/authoring/findings";
import type { VariantRow } from "@/lib/authoring/matrix";
import { ValuePicker } from "./ValuePicker";
import { axisSummary, variantAnchorId } from "./VariantRows";

interface PricingRowsProps {
  readonly schema: AuthoringSchema;
  readonly rows: readonly VariantRow[];
  readonly onChange: (rows: readonly VariantRow[]) => void;
  readonly findings: readonly LocatedFinding[];
  readonly disabled?: boolean;
}

/**
 * Money and stock, per sold combination — the `offer` and `inventory` steps.
 *
 * ## Why one screen and not two
 *
 * `AuthoringStepKind` lists `offer` and `inventory` separately because they are
 * separate DOMAINS, which is a statement about where the data lives rather than
 * about how many screens a form has. Rendering them apart would mean the same
 * rows twice with two of their columns each, and an author setting a price for
 * a size they have none of would have to hold both in their head.
 *
 * ## The currency is the CATALOGUE's, not a presentment
 *
 * A catalogue price is stored in its own native currency and converted by
 * nothing (`catalog-write.service` persists `.currency` exactly as given). So
 * this control picks the currency the merchant actually prices in, and the
 * shopper-facing conversion happens downstream through `PriceDisplay`.
 *
 * ## Stock here is the aggregate
 *
 * The draft contract carries ONE available quantity per variant, which the
 * publication hands to the same product-create path the rest of the dashboard
 * uses. Splitting it across locations is `inventory_levels`' surface and it
 * already exists on the published product; there is no per-location field in
 * `DraftVariantPayload` to send one through, and inventing one client-side
 * would be a number this app could not store.
 */
export function PricingRows({
  schema,
  rows,
  onChange,
  findings,
  disabled = false,
}: PricingRowsProps) {
  const { t } = useTranslation();
  const [bulkPrice, setBulkPrice] = useState("");
  const [bulkStock, setBulkStock] = useState("");

  const enabled = rows.filter((row) => row.enabled);
  const positionByKey = new Map<string, number>();
  enabled.forEach((row, index) => positionByKey.set(row.key, index));

  const update = (key: string, patch: Partial<VariantRow>) => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const applyToAll = (patch: Partial<VariantRow>) => {
    onChange(rows.map((row) => (row.enabled ? { ...row, ...patch } : row)));
  };

  const currencyOptions = ALL_CURRENCY_CODES.map((code) => ({ id: code, label: code }));
  const firstCurrency: CurrencyCode = enabled[0]?.currency ?? "FAIR";

  return (
    <View className="gap-4">
      {enabled.length > 1 ? (
        <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm font-semibold text-foreground">
            {t("products.wizard.pricing.bulkTitle")}
          </Text>
          <View className="flex-row flex-wrap gap-3">
            <View className="min-w-[9rem] flex-1 gap-1.5">
              <Label>{t("products.wizard.pricing.price")}</Label>
              <Input
                value={bulkPrice}
                onChangeText={setBulkPrice}
                accessibilityLabel={t("products.wizard.pricing.bulkPriceLabel")}
                keyboardType="decimal-pad"
                editable={!disabled}
              />
            </View>
            <View className="min-w-[9rem] flex-1 gap-1.5">
              <Label>{t("products.wizard.pricing.stock")}</Label>
              <Input
                value={bulkStock}
                onChangeText={setBulkStock}
                accessibilityLabel={t("products.wizard.pricing.bulkStockLabel")}
                keyboardType="number-pad"
                editable={!disabled}
              />
            </View>
            <View className="min-w-[9rem] flex-1 gap-1.5">
              <Label>{t("products.wizard.pricing.currency")}</Label>
              <ValuePicker
                options={currencyOptions}
                selectedId={firstCurrency}
                onSelect={(currency) => applyToAll({ currency })}
                placeholder={firstCurrency}
                title={t("products.wizard.pricing.currency")}
                disabled={disabled}
              />
            </View>
          </View>
          <Button
            variant="outline"
            className="self-start"
            disabled={disabled}
            onPress={() =>
              applyToAll({
                ...(bulkPrice.trim().length === 0 ? {} : { priceMajor: bulkPrice.trim() }),
                ...(bulkStock.trim().length === 0
                  ? {}
                  : { inventoryAvailable: bulkStock.trim() }),
              })
            }
          >
            <Text className="text-sm font-medium text-foreground">
              {t("products.wizard.pricing.applyToAll")}
            </Text>
          </Button>
        </View>
      ) : null}

      {enabled.map((row) => {
        const position = positionByKey.get(row.key) ?? 0;
        const rowFindings = findingsForVariant(findings, position);
        const summary = axisSummary(row, schema, t);
        return (
          <View
            key={row.key}
            nativeID={variantAnchorId(position)}
            className="gap-3 rounded-2xl border border-border bg-surface p-4"
          >
            <Text className="text-sm font-semibold text-foreground">
              {summary.length > 0 ? summary : t("products.wizard.variants.singleVariant")}
            </Text>

            <View className="flex-row flex-wrap gap-3">
              <View className="min-w-[9rem] flex-1 gap-1.5">
                <Label>{t("products.wizard.pricing.price")}</Label>
                <Input
                  value={row.priceMajor}
                  onChangeText={(priceMajor) => update(row.key, { priceMajor })}
                  accessibilityLabel={t("products.wizard.pricing.price")}
                  keyboardType="decimal-pad"
                  editable={!disabled}
                />
              </View>
              <View className="min-w-[9rem] flex-1 gap-1.5">
                <Label>{t("products.wizard.pricing.compareAt")}</Label>
                <Input
                  value={row.compareAtMajor}
                  onChangeText={(compareAtMajor) => update(row.key, { compareAtMajor })}
                  accessibilityLabel={t("products.wizard.pricing.compareAt")}
                  keyboardType="decimal-pad"
                  editable={!disabled}
                />
              </View>
              <View className="min-w-[9rem] flex-1 gap-1.5">
                <Label>{t("products.wizard.pricing.currency")}</Label>
                <ValuePicker
                  options={currencyOptions}
                  selectedId={row.currency}
                  onSelect={(currency) => update(row.key, { currency })}
                  placeholder={row.currency}
                  title={t("products.wizard.pricing.currency")}
                  disabled={disabled}
                />
              </View>
            </View>

            <View className="flex-row flex-wrap items-end gap-3">
              <View className="min-w-[9rem] flex-1 gap-1.5">
                <Label>{t("products.wizard.pricing.stock")}</Label>
                <Input
                  value={row.inventoryAvailable}
                  onChangeText={(inventoryAvailable) => update(row.key, { inventoryAvailable })}
                  accessibilityLabel={t("products.wizard.pricing.stock")}
                  keyboardType="number-pad"
                  editable={!disabled && row.inventoryTracked}
                />
              </View>
              <View className="flex-row items-center gap-2 pb-2">
                <Switch
                  value={row.inventoryTracked}
                  onValueChange={(inventoryTracked: boolean) =>
                    update(row.key, { inventoryTracked })
                  }
                  disabled={disabled}
                  accessibilityLabel={t("products.wizard.pricing.trackStock")}
                />
                <Text className="text-sm text-muted-foreground">
                  {t("products.wizard.pricing.trackStock")}
                </Text>
              </View>
            </View>

            {rowFindings.map((finding, index) => (
              <Text key={`${finding.code}-${index}`} className="text-xs text-destructive">
                {t(findingMessageKey(finding.code))}
              </Text>
            ))}
          </View>
        );
      })}

      {enabled.length === 0 ? (
        <Text className="text-sm text-muted-foreground">
          {t("products.wizard.pricing.noSoldVariants")}
        </Text>
      ) : null}
    </View>
  );
}
