import React from "react";
import {
  View,
  Pressable,
  ScrollView,
  Linking,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  Home,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  LogIn,
  UserPlus,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { useUIStore } from "@/lib/stores/ui-store";
import { useRouter, usePathname, useNavigation } from "expo-router";
import type { DrawerNavigationProp } from "@react-navigation/drawer";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { UserAvatar } from "@/components/user-avatar";
import { useOxy, showSignInModal } from "@oxyhq/services";
import { MercariaWordmark } from "@/components/ui/mercaria-wordmark";
import { Logo } from "@/components/Logo";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/utils";

type DrawerNav = DrawerNavigationProp<Record<string, object | undefined>>;

/* ================================================================
   Root sidebar — routes to settings sidebar on /settings
   ================================================================ */

export function Sidebar() {
  const pathname = usePathname();
  if (pathname.startsWith("/settings")) return <SettingsSidebar />;
  return <MainSidebar />;
}

/* ================================================================
   Nav item
   ================================================================ */

interface NavItemProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  collapsed?: boolean;
}

function NavItem({ icon: Icon, label, onPress, isActive, collapsed }: NavItemProps) {
  const { colors } = useColorScheme();

  if (collapsed) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityLabel={label}
        className={cn(
          "h-12 w-12 items-center justify-center rounded-full web:transition",
          isActive ? "bg-primary/10" : "active:bg-muted web:hover:bg-muted"
        )}
      >
        <Icon size={20} color={isActive ? colors.primary : colors.foreground} />
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "mx-2 h-12 flex-row items-center gap-4 rounded-full px-4 web:transition",
        isActive ? "bg-primary/10" : "active:bg-muted web:hover:bg-muted"
      )}
    >
      <Icon size={20} color={isActive ? colors.primary : colors.foreground} />
      <Text
        className={cn(
          "flex-1 text-sm",
          isActive ? "font-semibold text-primary" : "text-foreground"
        )}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ================================================================
   Main sidebar
   ================================================================ */

const MainSidebar = React.memo(function MainSidebar() {
  const router = useRouter();
  const navigation = useNavigation<DrawerNav>();
  const pathname = usePathname();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);

  const { user, isAuthenticated, logout, showBottomSheet } = useOxy();

  const isCollapsed = isLargeScreen && sidebarCollapsed;

  const closeDrawerOnMobile = React.useCallback(() => {
    if (!isLargeScreen) navigation.closeDrawer();
  }, [isLargeScreen, navigation]);

  const goHome = React.useCallback(() => {
    router.push("/(app)");
    closeDrawerOnMobile();
  }, [router, closeDrawerOnMobile]);

  const goSettings = React.useCallback(() => {
    router.push("/(app)/settings");
    closeDrawerOnMobile();
  }, [router, closeDrawerOnMobile]);

  const handleAccount = React.useCallback(
    () => showBottomSheet?.("ManageAccount"),
    [showBottomSheet]
  );
  const handleLogout = React.useCallback(() => {
    logout();
    router.replace("/(app)");
  }, [router, logout]);
  const handleLogin = React.useCallback(() => showSignInModal(), []);

  const isHome =
    pathname === "/" ||
    pathname === "/(app)" ||
    (pathname.startsWith("/(app)") && !pathname.includes("/settings"));

  const displayName = React.useMemo(() => {
    if (!user) return t("common.user");
    if (user.name?.first) {
      return user.name.last ? `${user.name.first} ${user.name.last}` : user.name.first;
    }
    return user.username || t("common.user");
  }, [user, t]);

  /* ───────────────── Collapsed (desktop) ───────────────── */
  if (isCollapsed) {
    return (
      <View
        className="h-full flex-col items-center border-r border-border bg-background"
        style={{ width: 48, paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="h-14 items-center justify-center">
          <Logo size={28} />
        </View>
        <View className="flex-col items-center gap-1 py-1">
          <NavItem icon={Home} label={t("nav.home")} onPress={goHome} collapsed />
          <NavItem icon={Settings} label={t("nav.settings")} onPress={goSettings} collapsed />
        </View>
        <View className="flex-1" />
        <View className="flex-col items-center gap-2 p-2">
          <Pressable
            onPress={toggleSidebarCollapsed}
            accessibilityLabel="Expand sidebar"
            className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
          >
            <ChevronsRight size={18} color={colors.mutedForeground} />
          </Pressable>
          {isAuthenticated ? (
            <Pressable onPress={handleAccount} className="h-10 w-10 items-center justify-center">
              <UserAvatar size={32} />
            </Pressable>
          ) : (
            <Pressable
              onPress={handleLogin}
              className="h-10 w-10 items-center justify-center rounded-full bg-primary/10"
            >
              <Text className="text-sm font-bold text-primary">
                {(t("login.signInButton")[0] || "S").toUpperCase()}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  /* ───────────────── Expanded ───────────────── */
  return (
    <View
      className="h-full w-full flex-col border-r border-border bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {/* Header */}
      <View className="h-14 flex-row items-center px-4">
        <Pressable onPress={goHome} className="rounded-xl p-1 active:bg-muted">
          <View className="flex-row items-center gap-2">
            <Logo size={28} />
            <MercariaWordmark width={120} color={colors.foreground} />
          </View>
        </Pressable>
        {isLargeScreen && (
          <View className="ml-auto">
            <Pressable
              onPress={toggleSidebarCollapsed}
              accessibilityLabel="Collapse sidebar"
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
            >
              <ChevronsLeft size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        )}
      </View>

      {/* Nav */}
      <ScrollView className="flex-1" contentContainerClassName="py-1">
        <NavItem
          icon={Home}
          label={t("nav.home")}
          onPress={goHome}
          isActive={isHome}
        />
        <NavItem
          icon={Settings}
          label={t("nav.settings")}
          onPress={goSettings}
          isActive={pathname.includes("/settings")}
        />
      </ScrollView>

      {/* Footer */}
      <View className="mt-auto flex-col gap-2 border-t border-border/40 p-2">
        {isAuthenticated ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Pressable
                accessibilityLabel="Account menu"
                accessibilityRole="button"
                className="flex-row items-center gap-2.5 rounded-xl p-1.5 active:bg-muted"
              >
                <UserAvatar size={32} />
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                    {displayName}
                  </Text>
                  {user?.username && (
                    <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                      @{user.username}
                    </Text>
                  )}
                </View>
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item key="account" onSelect={handleAccount}>
                <DropdownMenu.ItemIcon ios={{ name: "person.circle" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.account")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="settings" onSelect={goSettings}>
                <DropdownMenu.ItemIcon ios={{ name: "gearshape" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.settings")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                key="privacy"
                onSelect={() =>
                  Linking.openURL("https://oxy.so/company/transparency/policies/privacy")
                }
              >
                <DropdownMenu.ItemIcon ios={{ name: "hand.raised" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.privacyPolicy")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item key="logout" destructive onSelect={handleLogout}>
                <DropdownMenu.ItemIcon ios={{ name: "rectangle.portrait.and.arrow.right" }} />
                <DropdownMenu.ItemTitle>{t("sidebar.logOut")}</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        ) : (
          <View className="gap-2">
            <Button onPress={handleLogin} className="h-11 w-full rounded-full md:h-9">
              <View className="flex-row items-center gap-2 md:gap-1.5">
                <LogIn size={16} className="text-primary-foreground" />
                <Text className="text-sm font-semibold text-primary-foreground md:text-xs">
                  {t("login.signInButton")}
                </Text>
              </View>
            </Button>
            <Button
              onPress={handleLogin}
              variant="outline"
              className="h-11 w-full rounded-full md:h-9"
            >
              <View className="flex-row items-center gap-2 md:gap-1.5">
                <UserPlus size={16} className="text-foreground" />
                <Text className="text-sm font-medium md:text-xs">{t("login.footerLink")}</Text>
              </View>
            </Button>
          </View>
        )}
      </View>
    </View>
  );
});
