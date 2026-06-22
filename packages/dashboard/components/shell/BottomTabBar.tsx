import React, { useCallback, useMemo } from "react";
import { View, Pressable, Platform, StyleSheet, type ViewStyle } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { type LucideIcon } from "lucide-react-native";

import { useColorScheme } from "@mercaria/ui";
import { useTheme } from "@oxyhq/bloom/theme";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { NAV_ITEMS, isNavItemActive, type NavItem } from "./nav-items";

/** Subtle frosted-glass blur radius for the web bar. */
const WEB_BLUR_RADIUS = "12px";

interface WebBackdropStyle extends ViewStyle {
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
}

const ICON_SIZE = 22;
const INACTIVE_ICON_OPACITY = 0.5;

const BAR_BOTTOM = 12;
const BAR_INSET = 16;
const BAR_HEIGHT = 56;
const BAR_RADIUS = 28;

const tabStyle = {
  flex: 1,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  height: "100%" as const,
  ...(Platform.OS === "web" ? { cursor: "pointer" as const } : {}),
};

function triggerHaptic() {
  if (Platform.OS === "web") return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

interface TabIconProps {
  icon: LucideIcon;
  isActive: boolean;
}

function TabIcon({ icon: Icon, isActive }: TabIconProps) {
  const { colors } = useColorScheme();
  return (
    <Icon
      size={ICON_SIZE}
      color={isActive ? colors.primary : colors.mutedForeground}
      style={isActive ? undefined : { opacity: INACTIVE_ICON_OPACITY }}
    />
  );
}

/**
 * Floating-pill bottom tab bar (mobile <768 / native). Renders the
 * permission-visible nav destinations. The set of items is dynamic (gated by the
 * caller's permissions), so this bar lays the tabs out in a flat row rather than
 * a fixed-count animated indicator.
 */
export function BottomTabBar() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { can } = useActiveStoreContext();

  const visibleItems = useMemo(() => NAV_ITEMS.filter((item) => can(item.permission)), [can]);

  const handlePress = useCallback(
    (item: NavItem) => {
      triggerHaptic();
      router.push(item.href as never);
    },
    [router],
  );

  const containerStyle = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      bottom: BAR_BOTTOM + insets.bottom,
      left: BAR_INSET,
      right: BAR_INSET,
      height: BAR_HEIGHT,
      borderRadius: BAR_RADIUS,
      overflow: "hidden",
      zIndex: 1000,
      ...(Platform.OS === "web"
        ? { boxShadow: `0 2px 16px ${theme.colors.shadow}` }
        : {
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.15,
            shadowRadius: 12,
            elevation: 8,
          }),
    }),
    [insets.bottom, theme.colors.shadow],
  );

  const innerContent = (
    <>
      {visibleItems.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => handlePress(item)}
          style={tabStyle}
          accessibilityRole="tab"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: isNavItemActive(item, pathname) }}
        >
          <TabIcon icon={item.icon} isActive={isNavItemActive(item, pathname)} />
        </Pressable>
      ))}
    </>
  );

  const webContainerStyle = useMemo<WebBackdropStyle>(
    () => ({
      ...containerStyle,
      backdropFilter: `blur(${WEB_BLUR_RADIUS})`,
      WebkitBackdropFilter: `blur(${WEB_BLUR_RADIUS})`,
      flexDirection: "row",
      alignItems: "center",
    }),
    [containerStyle],
  );

  if (visibleItems.length === 0) {
    return null;
  }

  if (Platform.OS === "web") {
    return (
      <View className="border border-border bg-card/80" style={webContainerStyle}>
        {innerContent}
      </View>
    );
  }

  return (
    <View className="border border-border" style={containerStyle}>
      <BlurView
        intensity={80}
        tint={theme.isDark ? "dark" : "light"}
        experimentalBlurMethod="dimezisBlurView"
        style={styles.blurContent}
      >
        {innerContent}
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  blurContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
});
