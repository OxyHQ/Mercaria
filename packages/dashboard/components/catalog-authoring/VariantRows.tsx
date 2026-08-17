import React from "react";
import { Pressable, View } from "react-native";
import type { AuthoringSchema } from "@mercaria/shared-types";
import { Input, Label, Switch, Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { useCanonicalVariants } from "@/lib/authoring/hooks";
import { ValuePicker, type PickerOption } from "./ValuePicker";
import { findingMessageKey, findingsForVariant, type LocatedFinding } from "@/lib/authoring/findings";
import {
  controlledValueStrings,
  duplicateRowKeys,
  type VariantRow,
} from "@/lib/authoring/matrix";
import { fieldsByKey } from "@/lib/authoring/wizard-state";

interface VariantRowsProps {
  readonly schema: AuthoringSchema;
  readonly rows: readonly VariantRow[];
  readonly onChange: (rows: readonly VariantRow[]) => void;
  readonly findings: readonly LocatedFinding[];
  /** The canonical product the author declared, if any — enables the per-row link. */
  readonly canonicalProductId: string | null;
  readonly disabled?: boolean;
}

/** The DOM/native id the error summary jumps to for one row. */
export function variantAnchorId(position: number): string {
  return `authoring-variant-${position}`;
}

/**
 * The generated combinations, as CARDS rather than as a table.
 *
 * A merchant creating a product is a critical action and a desktop-only table
 * with eight columns is unusable on the phone half of that. Each combination is
 * one card that stacks; the columns inside it wrap. The identity of a row is
 * its axis values, rendered as a label line — never an editable field, because
 * an axis value is edited on the axis and regenerating is what applies it.
 *
 * ## Disabling is what makes the matrix sparse
 *
 * A combination the merchant does not sell is switched OFF and stays visible.
 * That is D6's sparse matrix and "impossible combinations can be disabled" in
 * one mechanism: a disabled row has no payload, so nothing about it is stored,
 * and it is on screen so the author can see what they excluded rather than
 * wondering whether they forgot it.
 *
 * ## Duplicates are detected after normalization
 *
 * `duplicateRowKeys` compares the normalized axis pairs, sorted — so two rows
 * whose axes were entered in a different order, or which differ only in case or
 * spacing, are reported here rather than at the publish, where the database
 * refuses the second with a constraint violation nothing can attribute.
 */
export function VariantRows({
  schema,
  rows,
  onChange,
  findings,
  canonicalProductId,
  disabled = false,
}: VariantRowsProps) {
  const { t } = useTranslation();
  const byKey = fieldsByKey(schema);
  const valueStrings = controlledValueStrings(schema);
  const duplicates = duplicateRowKeys(rows, byKey, valueStrings);

  /**
   * The canonical product's own configurations, offered per row.
   *
   * This is "select only the variants they actually sell": a merchant on a
   * product with fourteen configurations enables the four they stock and names
   * which catalogue configuration each one IS. The publication links those with
   * method `merchant_declared` and never re-matches them (ADR 0007 D10) — the
   * matcher still runs for every row the author did NOT resolve.
   *
   * A configuration with no name is a real state (#56 makes
   * `canonical_variants.name` nullable) and is labelled as unnamed rather than
   * having one composed from its option assignments, which would be this
   * surface inventing a display name the catalogue does not carry.
   */
  const canonicalVariants = useCanonicalVariants(canonicalProductId);
  const variantOptions: readonly PickerOption[] = (canonicalVariants.data?.candidates ?? []).map(
    (candidate) => ({
      id: candidate.id,
      label: candidate.name.length > 0 ? candidate.name : t("products.wizard.canonical.unnamedVariant"),
    }),
  );

  const update = (key: string, patch: Partial<VariantRow>) => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  // The POSITION a finding names is the position among the rows that were SENT,
  // which is the enabled ones in order. A disabled row does not shift it.
  const positionByKey = new Map<string, number>();
  rows
    .filter((row) => row.enabled)
    .forEach((row, index) => positionByKey.set(row.key, index));

  return (
    <View className="gap-3">
      {rows.map((row) => {
        const position = positionByKey.get(row.key) ?? null;
        const rowFindings = position === null ? [] : findingsForVariant(findings, position);
        const isDuplicate = duplicates.has(row.key);
        // A product sold in one configuration has no axis values to name it
        // with, and that is the normal case rather than an empty state.
        const summary = axisSummary(row, schema);
        return (
          <View
            key={row.key}
            nativeID={position === null ? undefined : variantAnchorId(position)}
            className={[
              "gap-3 rounded-2xl border bg-surface p-4",
              isDuplicate ? "border-destructive" : "border-border",
              row.enabled ? "" : "opacity-60",
            ].join(" ")}
          >
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  {summary.length > 0 ? summary : t("products.wizard.variants.singleVariant")}
                </Text>
                {isDuplicate ? (
                  <Text className="mt-0.5 text-xs text-destructive">
                    {t("products.wizard.variants.duplicate")}
                  </Text>
                ) : null}
              </View>
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-muted-foreground">
                  {t("products.wizard.variants.sold")}
                </Text>
                <Switch
                  value={row.enabled}
                  onValueChange={(enabled: boolean) => update(row.key, { enabled })}
                  disabled={disabled}
                  accessibilityLabel={t("products.wizard.variants.sold")}
                />
              </View>
            </View>

            <View className="flex-row flex-wrap gap-3">
              <View className="min-w-[10rem] flex-1 gap-1.5">
                <Label>{t("products.wizard.variants.sku")}</Label>
                <Input
                  value={row.sku}
                  onChangeText={(sku) => update(row.key, { sku })}
                  accessibilityLabel={t("products.wizard.variants.sku")}
                  editable={!disabled && row.enabled}
                  autoCapitalize="none"
                />
              </View>
              <View className="min-w-[10rem] flex-1 gap-1.5">
                <Label>{t("products.wizard.variants.barcode")}</Label>
                <Input
                  value={row.barcode}
                  onChangeText={(barcode) => update(row.key, { barcode })}
                  accessibilityLabel={t("products.wizard.variants.barcode")}
                  editable={!disabled && row.enabled}
                  autoCapitalize="none"
                />
              </View>
            </View>

            {canonicalProductId === null || variantOptions.length === 0 ? null : (
              <View className="gap-1.5">
                <Label>{t("products.wizard.canonical.variantLabel")}</Label>
                <ValuePicker
                  options={variantOptions}
                  selectedId={row.selectedCanonicalVariantId}
                  onSelect={(selectedCanonicalVariantId) =>
                    update(row.key, { selectedCanonicalVariantId })
                  }
                  placeholder={t("products.wizard.canonical.variantPlaceholder")}
                  title={t("products.wizard.canonical.variantLabel")}
                  disabled={disabled || !row.enabled}
                />
                {row.selectedCanonicalVariantId === null ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("products.wizard.canonical.clearVariant")}
                    onPress={() => update(row.key, { selectedCanonicalVariantId: null })}
                    className="self-start active:opacity-70"
                  >
                    <Text className="text-xs text-primary">
                      {t("products.wizard.canonical.clearVariant")}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {rowFindings.map((finding, index) => (
              <Text key={`${finding.code}-${index}`} className="text-xs text-destructive">
                {t(findingMessageKey(finding.code))}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The line that names one combination.
 *
 * Built from the localized labels of the values it holds, so it reads the way
 * the author chose them. It is presentation only: what identifies the row to
 * the server is the axis answers themselves.
 */
export function axisSummary(row: VariantRow, schema: AuthoringSchema): string {
  const byKey = fieldsByKey(schema);
  const parts: string[] = [];
  for (const [key, entries] of Object.entries(row.axes)) {
    const field = byKey.get(key);
    if (field === undefined) continue;
    for (const entry of entries) {
      if (entry.kind === "controlled_value") {
        const value = field.controlledValues.find((option) => option.id === entry.enumValueId);
        if (value === undefined) continue;
        parts.push(schema.text.values[value.id]?.label?.value ?? value.value);
        continue;
      }
      if (entry.kind === "text" && entry.text.trim().length > 0) parts.push(entry.text.trim());
      if (entry.kind === "number" && entry.raw.trim().length > 0) parts.push(entry.raw.trim());
    }
  }
  return parts.join(" · ");
}
