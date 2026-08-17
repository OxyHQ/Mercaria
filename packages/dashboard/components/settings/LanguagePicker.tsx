import React from "react";
import { Pressable, View } from "react-native";
import { Check, Languages } from "lucide-react-native";
import { cn, LOCALE_ENDONYMS, Text, useColorScheme } from "@mercaria/ui";
import { DASHBOARD_LOCALES, useTranslation } from "@/lib/i18n";

/**
 * Choose the dashboard's language.
 *
 * Not a store setting, so it deliberately sits OUTSIDE `RequireStore`: it is a
 * preference of the person reading the screen, and a staff member with no
 * permission on the active store still has to be able to read it.
 *
 * The list comes from `DASHBOARD_LOCALES` — what the app actually ships —
 * rather than a hand-written array in this file, which is how a shipped bundle
 * ends up unreachable: adding `locales/it.json` would change nothing until
 * somebody remembered this file too. Here, adding a bundle adds a row. The
 * storefront's picker was the counter-example when this was written and is now
 * on the same shape (#435).
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
        {DASHBOARD_LOCALES.map((option, index) => {
          const selected = (option.split("-")[0] ?? "").toLowerCase() === activeLanguage;
          // The separator is decided here rather than with a `last:` variant:
          // nothing else in this repository uses one, react-native-css does not
          // implement it, and the failure would be a stray border on the last
          // row that renders correctly on web and wrongly on a device.
          const lastRow = index === DASHBOARD_LOCALES.length - 1;
          return (
            <Pressable
              key={option}
              onPress={() => setLocale(option)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={LOCALE_ENDONYMS[option]}
              className={cn(
                "flex-row items-center justify-between px-4 py-3 active:opacity-80",
                !lastRow && "border-b border-border",
              )}
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
