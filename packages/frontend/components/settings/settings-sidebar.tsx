import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@mercaria/ui";
import { BaseSidebar } from "@/components/base-sidebar";
import { useRouter, usePathname, type RoutePath } from "expo-router";
import { useTranslation } from "@/lib/i18n";
import {
  User,
  Settings2,
  MessageSquarePlus,
  Package,
  MapPin,
  ArrowLeft,
  type LucideIcon,
} from "lucide-react-native";

interface SettingsSection {
  id: string;
  /**
   * `RoutePath` rather than `string`, so the literals in `SECTIONS` below are
   * checked against the real route tree where they are written. Renaming or
   * deleting a settings screen fails the build here (#330).
   */
  route: RoutePath;
  icon: LucideIcon;
  labelKey: string;
}

const SECTIONS: SettingsSection[] = [
  { id: "account", route: "/(app)/settings", icon: User, labelKey: "settings.sections.account" },
  { id: "orders", route: "/(app)/orders", icon: Package, labelKey: "settings.sections.orders" },
  { id: "addresses", route: "/(app)/settings/addresses", icon: MapPin, labelKey: "settings.sections.addresses" },
  { id: "general", route: "/(app)/settings/general", icon: Settings2, labelKey: "settings.sections.general" },
  { id: "feedback", route: "/(app)/settings/feedback", icon: MessageSquarePlus, labelKey: "settings.sections.feedback" },
];

export const SettingsSidebar = React.memo(function SettingsSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const activeId = React.useMemo(() => {
    if (pathname.includes("/settings/general")) return "general";
    if (pathname.includes("/settings/feedback")) return "feedback";
    if (pathname.includes("/settings/addresses")) return "addresses";
    if (pathname.includes("/orders")) return "orders";
    return "account";
  }, [pathname]);

  const handleSelect = (section: SettingsSection) => {
    router.push(section.route);
  };

  const handleBack = () => {
    router.replace("/(app)");
  };

  const header = (
    <View className="px-3 pt-4 pb-2">
      <Pressable
        onPress={handleBack}
        className="flex-row items-center gap-2 px-2 h-8 rounded-lg hover:bg-sidebar-accent"
      >
        <ArrowLeft size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
      </Pressable>
    </View>
  );

  const footer = <View />;

  return (
    <BaseSidebar header={header} footer={footer}>
      <View className="px-3 py-1">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase px-2 mb-1">
          {t("settings.title")}
        </Text>
        <View className="gap-0.5">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeId === section.id;

            return (
              <Pressable
                key={section.id}
                onPress={() => handleSelect(section)}
                className={`flex-row items-center rounded-lg px-2 h-8 ${
                  isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                }`}
              >
                <Icon
                  size={16}
                  className={isActive ? "text-foreground" : "text-muted-foreground"}
                />
                <Text
                  className={`ms-2 text-sm flex-1 ${
                    isActive ? "font-medium text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {t(section.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </BaseSidebar>
  );
});
