import React from "react";
import { View } from "react-native";
import type { AuthoringField, AuthoringSchema } from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { initialEntries, type DraftFieldEntries, type DraftFieldEntry } from "@/lib/authoring/answers";
import { findingsForProductField, type LocatedFinding } from "@/lib/authoring/findings";
import { effectiveRequirements, isVisible, productScopeFields } from "@/lib/authoring/wizard-state";
import { authoringLabel } from "@/lib/authoring/untranslated";
import { SchemaField } from "./SchemaField";

interface ProductFieldsProps {
  readonly schema: AuthoringSchema;
  readonly entries: DraftFieldEntries;
  readonly onChange: (entries: DraftFieldEntries) => void;
  readonly findings: readonly LocatedFinding[];
  readonly disabled?: boolean;
}

/**
 * The DOM/native id an error-summary link jumps to for one field.
 *
 * Keyed on the stable attribute KEY rather than the field row id, because that
 * is what a validation finding carries — `AuthoringValidationFinding.fieldId`
 * is optional and `path` always names the key.
 */
export function fieldAnchorId(attributeKey: string): string {
  return `authoring-field-${attributeKey}`;
}

/**
 * Every product-scope field, in the schema's own groups and order.
 *
 * Grouping and order are `AuthoringGroup.position` and `AuthoringField.position`
 * — composed by the server from the product type version. This component sorts
 * and renders; it has no opinion about which fields belong together, which is
 * what makes adding a product type a data change.
 *
 * An ungrouped field (`groupId === null`) renders first and without a heading,
 * which is what "no group" means. Inventing a heading for it would be a label
 * this app authored.
 */
export function ProductFields({
  schema,
  entries,
  onChange,
  findings,
  disabled = false,
}: ProductFieldsProps) {
  const { t } = useTranslation();
  const requirements = effectiveRequirements(schema, entries);

  const visible = productScopeFields(schema).filter((field) =>
    isVisible(requirements.get(field.key) ?? field.requirement),
  );
  if (visible.length === 0) {
    return (
      <Text className="text-sm text-muted-foreground">
        {t("products.wizard.details.noFields")}
      </Text>
    );
  }

  const groups = [...schema.groups].sort((left, right) => left.position - right.position);
  const ungrouped = visible
    .filter((field) => field.groupId === null)
    .sort((left, right) => left.position - right.position);

  const setEntries = (field: AuthoringField, next: readonly DraftFieldEntry[]) => {
    onChange({ ...entries, [field.key]: next });
  };

  const renderField = (field: AuthoringField) => (
    <SchemaField
      key={field.id}
      field={field}
      schema={schema}
      requirement={requirements.get(field.key) ?? field.requirement}
      entries={entries[field.key] ?? initialEntries(field)}
      onChange={(next) => setEntries(field, next)}
      serverFindings={findingsForProductField(findings, field.key)}
      disabled={disabled}
      nativeID={fieldAnchorId(field.key)}
    />
  );

  return (
    <View className="gap-6">
      {ungrouped.length === 0 ? null : <View className="gap-5">{ungrouped.map(renderField)}</View>}

      {groups.map((group) => {
        const fields = visible
          .filter((field) => field.groupId === group.id)
          .sort((left, right) => left.position - right.position);
        if (fields.length === 0) return null;
        // #740: marked rather than bare — a schema with several untranslated
        // groups would otherwise render several identical section headings.
        const label = authoringLabel(
          schema.text.groups[group.id]?.label,
          { kind: "key", key: group.key },
          t,
        ).text;
        return (
          <View key={group.id} className="gap-5 rounded-2xl border border-border bg-surface p-4">
            <Text className="text-sm font-semibold text-foreground">{label}</Text>
            {fields.map(renderField)}
          </View>
        );
      })}
    </View>
  );
}
