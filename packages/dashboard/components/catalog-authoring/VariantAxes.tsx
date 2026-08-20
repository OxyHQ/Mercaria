import React from "react";
import { Pressable, View } from "react-native";
import { Plus, X } from "lucide-react-native";
import type { AuthoringField, AuthoringSchema } from "@mercaria/shared-types";
import { Button, Input, Switch, Text, useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { emptyEntry, type DraftFieldEntry } from "@/lib/authoring/answers";
import { AXIS_SUPPORTED_KINDS, axisValueSupport, unitAffordance } from "@/lib/authoring/controls";
import { variantCapableFields, type MatrixAxis } from "@/lib/authoring/matrix";
import { ValuePicker, type PickerOption } from "./ValuePicker";

interface VariantAxesProps {
  readonly schema: AuthoringSchema;
  readonly axes: readonly MatrixAxis[];
  readonly onChange: (axes: readonly MatrixAxis[]) => void;
  readonly onGenerate: () => void;
  readonly truncated: boolean;
  readonly disabled?: boolean;
}

/**
 * Which attributes this product actually varies along, and the values it takes.
 *
 * ADR 0007 D6: `variant_capable` says an attribute MAY define variants for this
 * product type; the product's own declared axis list is authoritative for this
 * product. So the switches below are the declaration, and the schema decides
 * only which switches exist.
 *
 * Zero axes is a real and normal answer — a product sold in one configuration —
 * and it is what the matrix falls back to, not an empty state.
 *
 * Nothing here names an axis. "Colour" and "Size" appear because the server
 * composed fields whose `variantCapable` is true and localized their labels.
 */
export function VariantAxes({
  schema,
  axes,
  onChange,
  onGenerate,
  truncated,
  disabled = false,
}: VariantAxesProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const capable = variantCapableFields(schema);

  if (capable.length === 0) {
    return (
      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm text-muted-foreground">
          {t("products.wizard.variants.noAxesAvailable")}
        </Text>
      </View>
    );
  }

  const axisFor = (field: AuthoringField) =>
    axes.find((axis) => axis.attributeKey === field.key) ?? null;

  const toggle = (field: AuthoringField, on: boolean) => {
    if (!on) {
      onChange(axes.filter((axis) => axis.attributeKey !== field.key));
      return;
    }
    onChange([...axes, { attributeKey: field.key, values: [emptyEntry(field, 0)] }]);
  };

  const setValues = (field: AuthoringField, values: readonly DraftFieldEntry[]) => {
    onChange(
      axes.map((axis) => (axis.attributeKey === field.key ? { ...axis, values } : axis)),
    );
  };

  return (
    <View className="gap-4">
      {capable.map((field) => {
        const axis = axisFor(field);
        const label = schema.text.fields[field.id]?.label?.value ?? field.key;
        return (
          <View key={field.id} className="gap-3 rounded-2xl border border-border bg-surface p-4">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-sm font-semibold text-foreground">{label}</Text>
              <Switch
                value={axis !== null}
                onValueChange={(on: boolean) => toggle(field, on)}
                disabled={disabled}
                accessibilityLabel={label}
              />
            </View>

            {axis === null ? null : (
              <View className="gap-2">
                {axis.values.map((value, index) => (
                  <View key={`${field.id}-${index}`} className="flex-row items-center gap-2">
                    <View className="flex-1">
                      <AxisValueControl
                        field={field}
                        schema={schema}
                        entry={value}
                        label={label}
                        disabled={disabled}
                        onChange={(next) =>
                          setValues(
                            field,
                            axis.values.map((current, position) =>
                              position === index ? next : current,
                            ),
                          )
                        }
                      />
                    </View>
                    {axis.values.length > 1 ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("products.wizard.variants.removeAxisValue")}
                        disabled={disabled}
                        onPress={() =>
                          setValues(
                            field,
                            axis.values.filter((_, position) => position !== index),
                          )
                        }
                        className="active:opacity-70"
                      >
                        <X size={16} color={colors.mutedForeground} />
                      </Pressable>
                    ) : null}
                  </View>
                ))}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("products.wizard.variants.addAxisValue")}
                  disabled={disabled}
                  onPress={() =>
                    setValues(field, [...axis.values, emptyEntry(field, 0)])
                  }
                  className="flex-row items-center gap-1.5 self-start active:opacity-70"
                >
                  <Plus size={14} color={colors.primary} />
                  <Text className="text-sm font-medium text-primary">
                    {t("products.wizard.variants.addAxisValue")}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}

      <Button variant="outline" onPress={onGenerate} disabled={disabled} className="self-start">
        <Text className="text-sm font-medium text-foreground">
          {t("products.wizard.variants.generate")}
        </Text>
      </Button>

      {truncated ? (
        <Text className="text-xs text-destructive">
          {t("products.wizard.variants.tooManyCombinations")}
        </Text>
      ) : null}
    </View>
  );
}

interface AxisValueControlProps {
  readonly field: AuthoringField;
  readonly schema: AuthoringSchema;
  readonly entry: DraftFieldEntry;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (entry: DraftFieldEntry) => void;
}

/**
 * One value along one axis.
 *
 * A controlled axis gets the same picker the field itself uses — the SAME
 * options, from the same `controlledValues` — so a display label a merchant
 * chose here and a display label in the details step cannot be two different
 * things. A typed axis gets a number or a text box, and a number that carries a
 * unit gets the same unit control `SchemaField` renders, from the same
 * {@link unitAffordance}.
 *
 * Which kinds are covered is {@link AXIS_SUPPORTED_KINDS}, in `lib/` because
 * nothing can execute a decision made inside a component here — and the set is
 * gated, so a `valueType` added to the registry fails the build until somebody
 * decides what an axis does with it.
 *
 * This docblock used to say a boolean "is not offered as an axis value".
 * Nothing implemented that: `variantCapableFields` filters on `variantCapable`
 * and the requirement, never on the value type, and the server's
 * `product_type_fields_variant_axis_check` constrains the scope and a forbidden
 * KEY list rather than the type. A boolean axis is reachable, lands on
 * `unsupported` and says so.
 */
function AxisValueControl({
  field,
  schema,
  entry,
  label,
  disabled,
  onChange,
}: AxisValueControlProps) {
  const { t } = useTranslation();
  const support = axisValueSupport(field);

  if (support === "controlled_value" && entry.kind === "controlled_value") {
    const options: readonly PickerOption[] = field.controlledValues.map((value) => ({
      id: value.id,
      label: schema.text.values[value.id]?.label?.value ?? value.value,
      detail: value.value,
    }));
    return (
      <ValuePicker
        options={options}
        selectedId={entry.enumValueId.length === 0 ? null : entry.enumValueId}
        onSelect={(id) => onChange({ ...entry, enumValueId: id })}
        placeholder={t("products.wizard.values.choose")}
        title={label}
        disabled={disabled}
      />
    );
  }

  if (support === "number" && entry.kind === "number") {
    // The unit box is the SAME decision `SchemaField` makes, taken from the
    // same function. It was missing here, which left `storage_capacity` — a
    // `digital_storage` measurement that is `variantCapable` in the shipped
    // smartphone package — as a bare number whose unit a merchant could not
    // reach, on the one axis whose purpose is that `256GB` and `256 GB`
    // normalize to one value.
    const unit = unitAffordance(field);
    return (
      <View className="flex-row items-center gap-2">
        <Input
          value={entry.raw}
          onChangeText={(raw) => onChange({ ...entry, raw })}
          accessibilityLabel={label}
          keyboardType="decimal-pad"
          editable={!disabled}
          className="flex-1"
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
    );
  }

  if (entry.kind === "text") {
    return (
      <Input
        value={entry.text}
        onChangeText={(text) => onChange({ ...entry, text })}
        accessibilityLabel={label}
        editable={!disabled}
      />
    );
  }

  return (
    <Text className="py-2 text-sm text-muted-foreground">
      {t("products.wizard.variants.unsupportedAxisValue")}
    </Text>
  );
}
