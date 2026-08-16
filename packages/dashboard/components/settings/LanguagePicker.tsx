import React from "react";
import { Pressable, View } from "react-native";
import { Check, Languages } from "lucide-react-native";
import { LOCALE_ENDONYMS, Text, useColorScheme } from "@mercaria/ui";
import { DASHBOARD_LOCALES, useTranslation } from "@/lib/i18n";

/**
 * Choose the dashboard's language.
 *
 * Not a store setting, so it deliberately sits OUTSIDE `RequireStore`: it is a
 * preference of the person reading the screen, and a staff member with no
 * permission on the active store still has to be able to read it.
 *
 * The list comes from `DASHBOARD_LOCALES` — what the app actually ships —
 * rather than a hand-written array in this file. The storefront's picker keeps
 * its own copy of the list, which is exactly how a shipped bundle ends up
 * unreachable: adding `locales/it.json` there changes nothing until somebody
 * remembers this file too. Here, adding a bundle adds a row.
 *
 * Each option is labelled with its ENDONYM (`Deutsch`, not `German`). A picker
 * that says "German" is useless to the one population that needs it: people who
 * cannot currently read the interface.
 */
export function LanguagePicker() {
  const { t, locale, setLocale } = useTranslation();
  const { colors } = useColorScheme();

  // A device reporting `de-AT` has no bundle of its own and renders `de`, so the
  // row that is actually in force is matched on the language subtag. Comparing
  // the whole tag would leave every regional locale showing no selection at all.
  const activeLanguage = (locale.split("-")[0] ?? "").toLowerCase();

  return (
    <View className="mt-6 gap-2">
      <View className="flex-row items-center gap-2">
        <Languages size={18} color={colors.mutedForeground} />
        <Text className="text-sm font-semibold text-foreground">{t("settings.language.title")}</Text>
      </View>
      <Text className="text-xs text-muted-foreground">{t("settings.language.description")}</Text>

      <View className="mt-2 overflow-hidden rounded-2xl border border-border bg-surface">
        {DASHBOARD_LOCALES.map((option) => {
          const selected = (option.split("-")[0] ?? "").toLowerCase() === activeLanguage;
          return (
            <Pressable
              key={option}
              onPress={() => setLocale(option)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={LOCALE_ENDONYMS[option]}
              className="flex-row items-center justify-between border-b border-border px-4 py-3 last:border-b-0 active:opacity-80"
            >
              <Text className="text-sm text-foreground">{LOCALE_ENDONYMS[option]}</Text>
              {selected ? <Check size={16} color={colors.primary} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
