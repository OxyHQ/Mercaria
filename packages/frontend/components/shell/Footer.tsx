import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { useTranslation } from "@/lib/i18n";

/**
 * KEYS, not sentences: this is a module-scope `const` evaluated at import, when
 * the locale store has not rehydrated — a sentence here would freeze whichever
 * language loaded first. Resolved with `t()` at the render site below.
 */
const FOOTER_LINK_KEYS = [
  "shell.footer.links.about",
  "shell.footer.links.help",
  "shell.footer.links.privacy",
  "shell.footer.links.terms",
] as const;

/* ================================================================
   Footer — light footer for the home scroll
   ================================================================ */

export function Footer() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();

  return (
    <View className="mt-8 border-t border-border px-6 py-8">
      <View className="flex-row items-center gap-2">
        <Logo size={20} />
        <Text className="text-sm font-semibold text-foreground">{t("shell.footer.brand")}</Text>
      </View>

      <View className="mt-4 flex-row flex-wrap items-center gap-4">
        {FOOTER_LINK_KEYS.map((linkKey) => (
          <Pressable
            key={linkKey}
            accessibilityRole="button"
            accessibilityLabel={t(linkKey)}
            className="active:opacity-70"
          >
            <Text className="text-sm text-muted-foreground">{t(linkKey)}</Text>
          </Pressable>
        ))}
      </View>

      <Text className="mt-4 text-xs text-muted-foreground">
        {t("shell.footer.copyright", { year })}
      </Text>
    </View>
  );
}
