import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { X } from "lucide-react-native";
import { Input, Text, useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { useCanonicalSearch } from "@/lib/authoring/hooks";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import type { DraftFieldEntry } from "@/lib/authoring/answers";

interface CanonicalReferenceFieldProps {
  readonly entry: Extract<DraftFieldEntry, { kind: "canonical_reference" }>;
  readonly label: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly onChange: (entry: DraftFieldEntry) => void;
}

/**
 * A field whose value is a POINTER at a canonical entity, never a name typed
 * twice (`ProductTypeValuePolicy.canonical_reference`).
 *
 * The author searches, picks a row, and what is stored is that row's id. There
 * is no free-text branch and no "use what I typed" affordance, which is the
 * whole difference between this policy and `typed_scalar`: a brand typed as
 * text is a claim nobody can join on.
 *
 * ## The kind this can select, and the one it cannot
 *
 * `/catalog-authoring/canonical-search` takes `canonical_product` or `brand`,
 * and a product-scope reference on a product form is a brand. A
 * `canonical_product_family` reference is representable in the draft and is NOT
 * selectable here, because no search surface in this repository returns
 * families by name — #56 owns them and publishes no such read. Inventing a
 * lookup would mean guessing which rows are families from a product search.
 */
export function CanonicalReferenceField({
  entry,
  label,
  disabled,
  invalid,
  onChange,
}: CanonicalReferenceFieldProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 300);
  const search = useCanonicalSearch({ query: debounced, kind: "brand" });

  if (entry.refId.length > 0) {
    return (
      <View className="h-11 flex-row items-center justify-between rounded-xl border border-input bg-background px-3.5">
        <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
          {entry.refName.length > 0 ? entry.refName : t("products.wizard.canonical.selectedRef")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("products.wizard.canonical.clearRef")}
          disabled={disabled}
          onPress={() => onChange({ ...entry, refId: "", refName: "" })}
          className="active:opacity-70"
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>
    );
  }

  return (
    <View className="gap-1.5">
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder={t("products.wizard.canonical.searchBrandPlaceholder")}
        accessibilityLabel={label}
        editable={!disabled}
        aria-invalid={invalid}
        className={invalid ? "border-destructive" : undefined}
      />
      {search.data === undefined || search.data.candidates.length === 0 ? null : (
        <View className="gap-1 rounded-xl border border-border bg-surface p-1">
          {search.data.candidates.map((candidate) => (
            <Pressable
              key={candidate.id}
              accessibilityRole="button"
              accessibilityLabel={candidate.name}
              onPress={() => {
                onChange({
                  ...entry,
                  refKind: candidate.kind,
                  refId: candidate.id,
                  refName: candidate.name,
                });
                setQuery("");
              }}
              className="rounded-lg px-3 py-2 active:bg-muted"
            >
              <Text className="text-sm text-foreground">{candidate.name}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
