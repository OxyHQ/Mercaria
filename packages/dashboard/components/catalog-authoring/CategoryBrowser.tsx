import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { AuthoringCategoryOption } from "@mercaria/shared-types";
import { Button, Skeleton, Text, useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { useAuthoringCategories } from "@/lib/authoring/hooks";

interface CategoryBrowserProps {
  readonly locale: string;
  readonly selectedId: string | null;
  readonly onSelect: (category: AuthoringCategoryOption) => void;
}

/** One node of the trail, so "back one level" is a pop rather than a refetch. */
interface Crumb {
  readonly id: string;
  readonly name: string;
}

/**
 * Browse the localized category tree, one level at a time.
 *
 * ## Why a drill-down and not a flat list
 *
 * The taxonomy is deep and the server pages it by parent. A flat search over
 * every category would need a read this surface does not have, and a
 * hand-maintained shortlist would be a category-specific list living in a React
 * component — the one thing ADR 0007 D10 exists to prevent.
 *
 * ## The trail is state, not a derivation
 *
 * `AuthoringCategoryOption.ancestorIds` gives the path for a category somebody
 * has already chosen, but it carries ids and not NAMES, and this surface only
 * ever holds the level it fetched. So the crumbs are pushed as the author walks
 * down. That is why a locale change keeps the trail: the ids are what drive the
 * refetch and the names come back translated (#367 step 10's "preserve progress
 * when the locale changes").
 */
export function CategoryBrowser({ locale, selectedId, onSelect }: CategoryBrowserProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [trail, setTrail] = useState<readonly Crumb[]>([]);

  const parentId = trail.length === 0 ? null : (trail[trail.length - 1]?.id ?? null);
  const categories = useAuthoringCategories(parentId, locale);

  const nameOf = (category: AuthoringCategoryOption) => category.name?.value ?? category.key;

  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("products.wizard.category.allCategories")}
          onPress={() => setTrail([])}
          className="active:opacity-70"
        >
          <Text
            className={
              trail.length === 0
                ? "text-sm font-semibold text-foreground"
                : "text-sm text-primary"
            }
          >
            {t("products.wizard.category.allCategories")}
          </Text>
        </Pressable>
        {trail.map((crumb, index) => (
          <View key={crumb.id} className="flex-row items-center gap-1">
            <ChevronRight size={14} color={colors.mutedForeground} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={crumb.name}
              onPress={() => setTrail(trail.slice(0, index + 1))}
              className="active:opacity-70"
            >
              <Text
                className={
                  index === trail.length - 1
                    ? "text-sm font-semibold text-foreground"
                    : "text-sm text-primary"
                }
              >
                {crumb.name}
              </Text>
            </Pressable>
          </View>
        ))}
      </View>

      {categories.isPending ? (
        <View className="gap-2">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </View>
      ) : null}

      {categories.isError ? (
        <Text className="text-sm text-destructive">
          {t("products.wizard.category.loadFailed")}
        </Text>
      ) : null}

      {categories.data !== undefined && categories.data.length === 0 ? (
        <Text className="text-sm text-muted-foreground">
          {t("products.wizard.category.noChildren")}
        </Text>
      ) : null}

      <View className="gap-2">
        {(categories.data ?? []).map((category) => {
          const name = nameOf(category);
          const isSelected = category.id === selectedId;
          return (
            <View
              key={category.id}
              className={[
                "flex-row items-center justify-between gap-2 rounded-xl border px-3 py-2",
                isSelected ? "border-primary bg-muted" : "border-border",
              ].join(" ")}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={name}
                onPress={() => setTrail([...trail, { id: category.id, name }])}
                className="flex-1 flex-row items-center gap-2 py-1 active:opacity-70"
              >
                <Text className="flex-1 text-base text-foreground">{name}</Text>
                <ChevronRight size={16} color={colors.mutedForeground} />
              </Pressable>
              {category.selectable ? (
                <Button size="sm" variant={isSelected ? "default" : "outline"} onPress={() => onSelect(category)}>
                  <Text
                    className={
                      isSelected
                        ? "text-xs font-semibold text-primary-foreground"
                        : "text-xs font-medium text-foreground"
                    }
                  >
                    {isSelected
                      ? t("products.wizard.category.chosen")
                      : t("products.wizard.category.choose")}
                  </Text>
                </Button>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}
