import React from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import {
  Store as StoreIcon,
  Users,
  Percent,
  Bell,
  MapPin,
  ChevronRight,
  type LucideIcon,
} from "lucide-react-native";
import type { StorePermission } from "@mercaria/shared-types";
import { Text, useColorScheme } from "@mercaria/ui";
import { Screen } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";

interface SettingsItem {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  href: string;
  permission: StorePermission;
}

const ITEMS: SettingsItem[] = [
  {
    key: "profile",
    label: "Store profile",
    description: "Name, handle, brand color, status",
    icon: StoreIcon,
    href: "/settings/store",
    permission: "store:manage",
  },
  {
    key: "policies",
    label: "Policies & notifications",
    description: "Returns, refund/privacy/terms, alerts",
    icon: Bell,
    href: "/settings/policies",
    permission: "settings:write",
  },
  {
    key: "members",
    label: "Members & roles",
    description: "Invite, edit roles and permissions",
    icon: Users,
    href: "/settings/members",
    permission: "members:manage",
  },
  {
    key: "tax",
    label: "Taxes",
    description: "Tax rates and tax behavior",
    icon: Percent,
    href: "/settings/tax",
    permission: "settings:write",
  },
  {
    key: "locations",
    label: "Locations",
    description: "Where you stock inventory",
    icon: MapPin,
    href: "/settings/locations",
    permission: "locations:write",
  },
];

export default function SettingsScreen() {
  return (
    <>
      <Head>
        <title>Settings | Mercaria Dashboard</title>
      </Head>
      <Screen title="Settings" subtitle="Configure your store" action={<StoreSwitcher />}>
        <RequireStore>{() => <SettingsList />}</RequireStore>
      </Screen>
    </>
  );
}

function SettingsList() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();

  const visible = ITEMS.filter((item) => can(item.permission));

  return (
    <View className="gap-2">
      {visible.map((item) => {
        const Icon = item.icon;
        return (
          <Pressable
            key={item.key}
            onPress={() => router.push(item.href as never)}
            className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
          >
            <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
              <Icon size={18} color={colors.mutedForeground} />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">{item.label}</Text>
              <Text className="text-xs text-muted-foreground">{item.description}</Text>
            </View>
            <ChevronRight size={18} color={colors.mutedForeground} />
          </Pressable>
        );
      })}
    </View>
  );
}
