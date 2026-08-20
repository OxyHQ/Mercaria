import React from "react";
import { Pressable, View } from "react-native";
import { Plus, X } from "lucide-react-native";
import type { AuthoringField, AuthoringSchema, ProductTypeFieldRequirement } from "@mercaria/shared-types";
import { Input, Label, Switch, Text, Textarea, useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import {
  emptyEntry,
  expectedEntryKind,
  isRepeatable,
  maxEntriesFor,
  type DraftFieldEntry,
} from "@/lib/authoring/answers";
import { unitAffordance } from "@/lib/authoring/controls";
import { checkFieldEntries, type InlineFinding } from "@/lib/authoring/inline-validation";
import { findingMessageKey, type LocatedFinding } from "@/lib/authoring/findings";
import { COMPONENT_AXIS_LABEL_KEYS } from "@/lib/authoring/labels";
import { ValuePicker, type PickerOption } from "./ValuePicker";
import { CanonicalReferenceField } from "./CanonicalReferenceField";

interface SchemaFieldProps {
  readonly field: AuthoringField;
  readonly schema: AuthoringSchema;
  /** After the visibility rule — never the declared one. */
  readonly requirement: ProductTypeFieldRequirement;
  readonly entries: readonly DraftFieldEntry[];
  readonly onChange: (entries: readonly DraftFieldEntry[]) => void;
  readonly serverFindings: readonly LocatedFinding[];
  readonly disabled?: boolean;
  /** Anchors the error summary's jump target. */
  readonly nativeID?: string;
}

/**
 * One field of the composed schema, rendered from the schema and nothing else.
 *
 * ## The whole point of this component
 *
 * Every branch below is taken on a value the SERVER composed —
 * `validation.valueType`, `validation.cardinality`, `valuePolicy`,
 * `controlledValues` — and there is no branch anywhere on which attribute this
 * is, which category it belongs to or which product type declared it. Adding a
 * product type is a data change (ADR 0007 D10), and this file is where that
 * stops being true the moment somebody writes `if (field.key === …)`. The
 * scanned gate refuses exactly that.
 *
 * The label, the help and the placeholder come from `schema.text`, keyed by the
 * field's STABLE id. A rule is never read out of a label: there is no `label`
 * property on `AuthoringField` to read one from.
 */
export function SchemaField({
  field,
  schema,
  requirement,
  entries,
  onChange,
  serverFindings,
  disabled = false,
  nativeID,
}: SchemaFieldProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  const text = schema.text.fields[field.id];
  // The stable KEY is the fallback, never a humanised guess at one: a missing
  // translation is a fact an operator has to be able to see, and a prettified
  // key reads in review like copy somebody wrote.
  const label = text?.label?.value ?? field.key;
  const help = text?.help?.value ?? null;
  const placeholder = text?.placeholder?.value ?? "";

  const inline = checkFieldEntries(field, requirement, entries);
  const findings: readonly (InlineFinding | LocatedFinding)[] = [...inline, ...serverFindings];
  const invalid = findings.some((finding) => finding.severity === "error");
  const max = maxEntriesFor(field);
  const canAddMore = isRepeatable(field) && (max === null || entries.length < max);

  const replaceAt = (index: number, entry: DraftFieldEntry) => {
    onChange(entries.map((current, position) => (position === index ? entry : current)));
  };

  return (
    <View className="gap-1.5" nativeID={nativeID}>
      <View className="flex-row items-center gap-2">
        <Label>{label}</Label>
        <RequirementBadge requirement={requirement} />
      </View>
      {help === null ? null : <Text className="text-xs text-muted-foreground">{help}</Text>}

      <View className="gap-2">
        {entries.map((entry, index) => (
          <View key={`${field.id}-${entry.ordinal}-${index}`} className="flex-row items-start gap-2">
            <View className="flex-1">
              <EntryControl
                field={field}
                schema={schema}
                entry={entry}
                label={label}
                placeholder={placeholder}
                invalid={invalid}
                disabled={disabled}
                onChange={(next) => replaceAt(index, next)}
              />
            </View>
            {entries.length > 1 && isRepeatable(field) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("products.wizard.fields.removeValue")}
                disabled={disabled}
                onPress={() => onChange(entries.filter((_, position) => position !== index))}
                className="mt-2.5 active:opacity-70"
              >
                <X size={16} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>

      {canAddMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("products.wizard.fields.addValue")}
          disabled={disabled}
          onPress={() => onChange([...entries, emptyEntry(field, entries.length)])}
          className="mt-1 flex-row items-center gap-1.5 self-start active:opacity-70"
        >
          <Plus size={14} color={colors.primary} />
          <Text className="text-sm font-medium text-primary">
            {t("products.wizard.fields.addValue")}
          </Text>
        </Pressable>
      ) : null}

      {findings.map((finding, index) => (
        <Text
          key={`${finding.code}-${index}`}
          className={
            finding.severity === "error"
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {t(findingMessageKey(finding.code))}
        </Text>
      ))}
    </View>
  );
}

/** How hard the schema is asking. `optional` says nothing, deliberately. */
function RequirementBadge({ requirement }: { requirement: ProductTypeFieldRequirement }) {
  const { t } = useTranslation();
  if (requirement === "required") {
    return (
      <Text className="text-xs font-medium text-destructive">
        {t("products.wizard.fields.required")}
      </Text>
    );
  }
  if (requirement === "recommended") {
    return (
      <Text className="text-xs font-medium text-muted-foreground">
        {t("products.wizard.fields.recommended")}
      </Text>
    );
  }
  return null;
}

interface EntryControlProps {
  readonly field: AuthoringField;
  readonly schema: AuthoringSchema;
  readonly entry: DraftFieldEntry;
  readonly label: string;
  readonly placeholder: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onChange: (entry: DraftFieldEntry) => void;
}

/** Above this many characters the string control becomes a textarea. */
const TEXTAREA_THRESHOLD = 255;

/**
 * The control for ONE entry, chosen from the attribute's declared type.
 *
 * `expectedEntryKind` is the same total mapping the server validates with, so a
 * control and the check that judges what it produced cannot disagree about
 * which storage kind a type uses.
 */
function EntryControl({
  field,
  schema,
  entry,
  label,
  placeholder,
  invalid,
  disabled,
  onChange,
}: EntryControlProps) {
  const { t } = useTranslation();
  const kind = expectedEntryKind(field);

  if (kind === "boolean" && entry.kind === "boolean") {
    return (
      <View className="h-11 flex-row items-center gap-3">
        <Switch
          value={entry.value}
          onValueChange={(value: boolean) => onChange({ ...entry, value })}
          disabled={disabled}
          accessibilityLabel={label}
        />
        <Text className="text-sm text-muted-foreground">
          {entry.value ? t("products.wizard.fields.yes") : t("products.wizard.fields.no")}
        </Text>
      </View>
    );
  }

  if (kind === "controlled_value" && entry.kind === "controlled_value") {
    const options: readonly PickerOption[] = field.controlledValues.map((value) => ({
      id: value.id,
      // The localized label, keyed by the value's own id. The CANONICAL string
      // is shown beside it as the detail line, because two localizations can
      // read alike and the stored fact is the canonical one.
      label: schema.text.values[value.id]?.label?.value ?? value.value,
      detail: value.value,
    }));
    return (
      <ValuePicker
        options={options}
        selectedId={entry.enumValueId.length === 0 ? null : entry.enumValueId}
        onSelect={(id) => onChange({ ...entry, enumValueId: id })}
        placeholder={placeholder.length > 0 ? placeholder : t("products.wizard.values.choose")}
        title={label}
        disabled={disabled}
        invalid={invalid}
      />
    );
  }

  if (kind === "canonical_reference" && entry.kind === "canonical_reference") {
    return (
      <CanonicalReferenceField
        entry={entry}
        label={label}
        disabled={disabled}
        invalid={invalid}
        onChange={onChange}
      />
    );
  }

  if (kind === "number" && entry.kind === "number") {
    const unit = unitAffordance(field);
    const axisLabel =
      entry.componentAxis === null
        ? null
        : t(COMPONENT_AXIS_LABEL_KEYS[entry.componentAxis]);
    return (
      <View className="gap-1">
        {axisLabel === null ? null : (
          <Text className="text-xs text-muted-foreground">{axisLabel}</Text>
        )}
        <View className="flex-row items-center gap-2">
          <Input
            value={entry.raw}
            onChangeText={(raw) => onChange({ ...entry, raw })}
            placeholder={placeholder}
            accessibilityLabel={axisLabel === null ? label : `${label} — ${axisLabel}`}
            keyboardType="decimal-pad"
            editable={!disabled}
            aria-invalid={invalid}
            className={invalid ? "flex-1 border-destructive" : "flex-1"}
          />
          {!unit.present ? null : (
            <Input
              value={entry.unit ?? ""}
              onChangeText={(unitText) => onChange({ ...entry, unit: unitText })}
              placeholder={unit.placeholder}
              accessibilityLabel={t("products.wizard.fields.unitLabel")}
              editable={!disabled}
              className="w-24"
            />
          )}
        </View>
      </View>
    );
  }

  if (entry.kind === "text") {
    const long =
      field.validation.maxLength !== null && field.validation.maxLength > TEXTAREA_THRESHOLD;
    if (long) {
      return (
        <Textarea
          value={entry.text}
          onChangeText={(text) => onChange({ ...entry, text })}
          placeholder={placeholder}
          accessibilityLabel={label}
          editable={!disabled}
          aria-invalid={invalid}
        />
      );
    }
    return (
      <Input
        value={entry.text}
        onChangeText={(text) => onChange({ ...entry, text })}
        placeholder={placeholder}
        accessibilityLabel={label}
        editable={!disabled}
        aria-invalid={invalid}
        className={invalid ? "border-destructive" : undefined}
      />
    );
  }

  // An entry whose stored kind does not match what the schema now expects —
  // which happens when a draft is upgraded to a product-type version that
  // changed an attribute's type. Reported rather than rendered as an empty box:
  // the value is still stored and the upgrade preview is what explains it.
  return (
    <Text className="py-2 text-sm text-muted-foreground">
      {t("products.wizard.fields.unsupportedEntry")}
    </Text>
  );
}
