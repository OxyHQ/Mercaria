import React from "react";
import { Linking, View, Pressable } from "react-native";
import { Text } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { useTranslation } from "@/lib/i18n";

/**
 * The footer's outbound policy links.
 *
 * KEYS, not sentences: this is a module-scope `const` evaluated at import, when
 * the locale store has not rehydrated — a sentence here would freeze whichever
 * language loaded first. Resolved with `t()` at the render site below.
 *
 * ## Why two entries and not the four that used to be here
 *
 * Every entry carries the URL it opens, because a control that cannot say where
 * it goes is the defect this list was just repaired for: all four rows rendered
 * as `Pressable`s with `active:opacity-70` and NO `onPress`, so they read as
 * live to a shopper and announced themselves as buttons to a screen reader
 * while doing nothing at all.
 *
 * Privacy and Terms survived because their destinations exist and are Oxy's
 * canonical ones — the privacy URL is already opened from
 * `components/sidebar.tsx`, so this is the second consumer of a link the app
 * already ships rather than a new claim about where a policy lives.
 *
 * About and Help were REMOVED rather than pointed somewhere. The storefront has
 * no `/about` or `/help` route, and neither has an external destination that
 * could be verified: `oxy.so/about` exists in the fleet only inside a
 * redirect-URI test fixture, and `help.oxy.so` is OXY's help centre, which is
 * not a claim anyone here can make about a marketplace shopper's questions
 * (where an order is, how a return works). Inventing either page — or aiming a
 * marketplace's "Help" at a company help site to make the row light up — would
 * keep the dead control and add a wrong promise to it. An absent row is honest;
 * a dead one is not.
 */
const FOOTER_LINKS = [
  {
    labelKey: "shell.footer.links.privacy",
    url: "https://oxy.so/company/transparency/policies/privacy",
  },
  {
    labelKey: "shell.footer.links.terms",
    url: "https://oxy.so/company/transparency/policies/terms-of-service",
  },
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
        {FOOTER_LINKS.map((link) => (
          <Pressable
            key={link.labelKey}
            accessibilityRole="link"
            accessibilityLabel={t(link.labelKey)}
            onPress={() => {
              void Linking.openURL(link.url);
            }}
            className="active:opacity-70"
          >
            <Text className="text-sm text-muted-foreground">{t(link.labelKey)}</Text>
          </Pressable>
        ))}
      </View>

      <Text className="mt-4 text-xs text-muted-foreground">
        {t("shell.footer.copyright", { year })}
      </Text>
    </View>
  );
}
