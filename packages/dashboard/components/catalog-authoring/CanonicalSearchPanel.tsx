import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { BadgeCheck, Search } from "lucide-react-native";
import type { AuthoringCanonicalCandidate } from "@mercaria/shared-types";
import { Input, Skeleton, Text, useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { useCanonicalSearch } from "@/lib/authoring/hooks";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

interface CanonicalSearchPanelProps {
  readonly selectedId: string | null;
  readonly onSelect: (candidate: AuthoringCanonicalCandidate) => void;
  readonly onClear?: () => void;
  /** Narrow to one product's own configurations, for the variant step. */
  readonly canonicalProductId?: string | null;
  readonly kind?: "canonical_product" | "brand";
}

/**
 * Find the thing being sold in the canonical catalogue.
 *
 * ## Enough identity to not pick the wrong regional model
 *
 * `AuthoringCanonicalCandidate` carries a name, a brand and the IDENTIFIERS
 * that make two similar-looking products distinguishable, and all three are
 * rendered — the identifiers especially, because "iPhone 15 128GB" is several
 * different products in several markets and the barcode is what tells them
 * apart. It deliberately carries no price and no merchant: the author is
 * choosing an identity, and a price beside it would invite picking the row with
 * the number they liked.
 *
 * `exactIdentifierMatch` is shown differently from a name hit, and the
 * difference is not cosmetic: an author confirming a barcode is making a far
 * stronger statement than one picking the closest-looking name, even though
 * `merchant_declared` records both as the same method.
 */
export function CanonicalSearchPanel({
  selectedId,
  onSelect,
  onClear,
  canonicalProductId = null,
  kind = "canonical_product",
}: CanonicalSearchPanelProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 300);
  const search = useCanonicalSearch({ query: debounced, kind, canonicalProductId });

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2 rounded-xl border border-input bg-background px-3">
        <Search size={16} color={colors.mutedForeground} />
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder={t("products.wizard.canonical.searchPlaceholder")}
          accessibilityLabel={t("products.wizard.canonical.searchPlaceholder")}
          className="flex-1 border-0"
          autoCapitalize="none"
        />
      </View>

      {debounced.trim().length > 0 && debounced.trim().length < 2 ? (
        <Text className="text-xs text-muted-foreground">
          {t("products.wizard.canonical.minQuery")}
        </Text>
      ) : null}

      {search.isPending && debounced.trim().length >= 2 ? (
        <View className="gap-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </View>
      ) : null}

      {search.data?.exactIdentifierMatch === true ? (
        <View className="flex-row items-center gap-2 rounded-xl bg-muted px-3 py-2">
          <BadgeCheck size={16} color={colors.primary} />
          <Text className="flex-1 text-xs text-foreground">
            {t("products.wizard.canonical.exactMatch")}
          </Text>
        </View>
      ) : null}

      <View className="gap-2">
        {(search.data?.candidates ?? []).map((candidate) => {
          const identifiers = Object.entries(candidate.identifiers);
          const isSelected = candidate.id === selectedId;
          return (
            <Pressable
              key={candidate.id}
              accessibilityRole="button"
              accessibilityLabel={candidate.name}
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelect(candidate)}
              className={[
                "rounded-xl border px-3 py-3 active:opacity-80",
                isSelected ? "border-primary bg-muted" : "border-border",
              ].join(" ")}
            >
              <Text className="text-base font-medium text-foreground">{candidate.name}</Text>
              {candidate.brandName === null ? null : (
                <Text className="mt-0.5 text-xs text-muted-foreground">{candidate.brandName}</Text>
              )}
              {identifiers.length === 0 ? null : (
                <View className="mt-1.5 flex-row flex-wrap gap-1.5">
                  {identifiers.map(([scheme, value]) => (
                    <View key={scheme} className="rounded-md bg-background px-2 py-0.5">
                      <Text className="text-[11px] text-muted-foreground">
                        {scheme.toUpperCase()} {value}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {search.data !== undefined && search.data.candidates.length === 0 && debounced.trim().length >= 2 ? (
        <Text className="text-sm text-muted-foreground">
          {t("products.wizard.canonical.noResults")}
        </Text>
      ) : null}

      {selectedId !== null && onClear !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("products.wizard.canonical.clearSelection")}
          onPress={onClear}
          className="self-start active:opacity-70"
        >
          <Text className="text-sm text-primary">
            {t("products.wizard.canonical.clearSelection")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
