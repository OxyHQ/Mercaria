import React from "react";
import { View, Pressable } from "react-native";
import { useRouter, type RoutePath } from "expo-router";
import Head from "expo-router/head";
import {
  Store as StoreIcon,
  Users,
  Percent,
  Bell,
  MapPin,
  Plug,
  CreditCard,
  Sparkles,
  ChevronRight,
  type LucideIcon,
} from "lucide-react-native";
import type { StorePermission } from "@mercaria/shared-types";
import { Text, useColorScheme } from "@mercaria/ui";
import { Screen } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { LanguagePicker } from "@/components/settings/LanguagePicker";
import { useTranslation } from "@/lib/i18n";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";

interface SettingsItem {
  key: string;
  /**
   * Translation keys for the row's title and one-line explanation (#398).
   *
   * KEYS rather than the sentences: this array is evaluated once at import,
   * before the locale store has rehydrated, so a resolved string here would
   * freeze whatever language the first render happened to see. `SettingsList`
   * calls `t()` per row and therefore re-renders when the locale changes.
   */
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  href: RoutePath;
  permission: StorePermission;
}

const ITEMS: SettingsItem[] = [
  {
    key: "profile",
    labelKey: "settings.sections.profile.label",
    descriptionKey: "settings.sections.profile.description",
    icon: StoreIcon,
    href: "/settings/store",
    permission: "store:manage",
  },
  {
    key: "policies",
    labelKey: "settings.sections.policies.label",
    descriptionKey: "settings.sections.policies.description",
    icon: Bell,
    href: "/settings/policies",
    permission: "settings:write",
  },
  {
    key: "members",
    labelKey: "settings.sections.members.label",
    descriptionKey: "settings.sections.members.description",
    icon: Users,
    href: "/settings/members",
    permission: "members:manage",
  },
  {
    key: "tax",
    labelKey: "settings.sections.tax.label",
    descriptionKey: "settings.sections.tax.description",
    icon: Percent,
    href: "/settings/tax",
    permission: "settings:write",
  },
  {
    key: "locations",
    labelKey: "settings.sections.locations.label",
    descriptionKey: "settings.sections.locations.description",
    icon: MapPin,
    href: "/settings/locations",
    permission: "locations:write",
  },
  {
    key: "channels",
    labelKey: "settings.sections.channels.label",
    descriptionKey: "settings.sections.channels.description",
    icon: Plug,
    href: "/channels",
    permission: "channels:write",
  },
  // Deliberately a separate row from "Sales channels", and worded so the two
  // cannot be read as the same thing: a sales channel is where a catalogue is
  // listed, this is where money is settled. A store can have either without the
  // other, and merging them would make connecting Shopify look like a payments
  // decision.
  {
    key: "payments",
    labelKey: "settings.sections.payments.label",
    descriptionKey: "settings.sections.payments.description",
    icon: CreditCard,
    href: "/settings/payments",
    permission: "store:manage",
  },
  // A sibling of "Payments & payouts" and deliberately worded the other way
  // round: that row is money coming IN for orders, this one is what a store pays
  // Mercaria for tooling. Two directions, two lifecycles, and merging them would
  // make a plan look like a condition of getting paid.
  {
    key: "plan",
    labelKey: "settings.sections.plan.label",
    descriptionKey: "settings.sections.plan.description",
    icon: Sparkles,
    href: "/settings/plan",
    permission: "store:manage",
  },
];

export default function SettingsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.documentTitle")}</title>
      </Head>
      <Screen
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
        action={<StoreSwitcher />}
      >
        <RequireStore>{() => <SettingsList />}</RequireStore>
        {/* Outside RequireStore on purpose: the interface language is a property
            of the person reading the screen, not of the active store, so a
            staff member with no permission on it must still be able to change
            it. */}
        <LanguagePicker />
      </Screen>
    </>
  );
}

function SettingsList() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const { t } = useTranslation();

  const visible = ITEMS.filter((item) => can(item.permission));

  return (
    <View className="gap-2">
      {visible.map((item) => {
        const Icon = item.icon;
        return (
          <Pressable
            key={item.key}
            onPress={() => router.push(item.href)}
            className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
          >
            <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
              <Icon size={18} color={colors.mutedForeground} />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">{t(item.labelKey)}</Text>
              <Text className="text-xs text-muted-foreground">{t(item.descriptionKey)}</Text>
            </View>
            <ChevronRight size={18} color={colors.mutedForeground} />
          </Pressable>
        );
      })}
    </View>
  );
}
