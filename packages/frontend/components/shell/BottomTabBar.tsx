import React, { useCallback, useMemo, useRef } from "react";
import {
  View,
  Pressable,
  Platform,
  StyleSheet,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { LogIn, type LucideIcon } from "lucide-react-native";
import * as Haptics from "expo-haptics";

import { UserAvatar } from "@/components/user-avatar";
import { Text, useColorScheme } from "@mercaria/ui";
import { useTheme } from "@oxyhq/bloom/theme";
import { useOxy, showSignInModal } from "@oxyhq/services";
import { useCart } from "@/lib/hooks/use-cart";
import {
  NAV_ITEMS,
  isNavItemActive,
  isAuthTabActive,
  type NavItem,
} from "./nav-items";

/**
 * Floating-pill bottom tab bar — a faithful port of Mention's `BottomBar`
 * adapted to Mercaria's data-driven nav model, lucide icons, theme hook and
 * avatar/sign-in auth tab. The bar is an absolutely-positioned rounded pill
 * that floats over the content (frosted glass via `expo-blur` on native and a
 * CSS `backdrop-filter` over a translucent `bg-card/80` surface on web), with
 * an animated sliding indicator behind the active tab.
 */

/** Subtle frosted-glass blur radius for the web bar (medium, not extreme). */
const WEB_BLUR_RADIUS = "12px";

/**
 * Web-only style extension. React Native's `ViewStyle` does not declare the CSS
 * backdrop-filter props, but on web (react-native-web) unknown style keys are
 * forwarded to the DOM, so these render as real CSS. Gated behind the web branch
 * so they never reach native.
 */
interface WebBackdropStyle extends ViewStyle {
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
}

const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
  mass: 0.5,
};

// One slot per nav destination plus the trailing auth/avatar tab.
const TAB_COUNT = NAV_ITEMS.length + 1;
const AUTH_TAB_INDEX = NAV_ITEMS.length;
const ICON_SIZE = 22;
const AVATAR_SIZE = ICON_SIZE + 4;

// Floating-pill geometry (mirrors Mention's BottomBar).
const BAR_BOTTOM = 12;
const BAR_INSET = 16;
const BAR_HEIGHT = 56;
const BAR_RADIUS = 28;
const INDICATOR_INSET = 4;
const INDICATOR_RADIUS = 22;

// Opacity applied to inactive lucide icons (no active/inactive SVG pairs in
// Mercaria, so active/inactive is a color + opacity swap on a single icon).
const INACTIVE_ICON_OPACITY = 0.5;

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

/* ================================================================
   Tab icon — lucide single icon, color/opacity swap for active state
   ================================================================ */

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

/* ================================================================
   Auth tab (avatar when authenticated, sign-in otherwise) — last slot
   ================================================================ */

interface AuthTabProps {
  isActive: boolean;
}

function AuthTab({ isActive }: AuthTabProps) {
  const { colors } = useColorScheme();
  const { isAuthenticated } = useOxy();

  const label = isAuthenticated ? "Account" : "Sign in";

  const onPress = useCallback(() => {
    triggerHaptic();
    if (!isAuthenticated) showSignInModal();
  }, [isAuthenticated]);

  return (
    <Pressable
      onPress={onPress}
      style={tabStyle}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: isActive }}
    >
      {isAuthenticated ? (
        <UserAvatar size={AVATAR_SIZE} />
      ) : (
        <LogIn
          size={ICON_SIZE}
          color={colors.mutedForeground}
          style={{ opacity: INACTIVE_ICON_OPACITY }}
        />
      )}
    </Pressable>
  );
}

/* ================================================================
   BottomTabBar — floating rounded pill (mobile <768 / native)
   ================================================================ */

export function BottomTabBar() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  // Animated sliding indicator. `tabWidth` is derived from the measured bar
  // width / tab count (onLayout); `indicatorX` springs to the active slot.
  const tabWidth = useSharedValue(0);
  const indicatorX = useSharedValue(0);

  // Active slot: the last index belongs to the auth tab, which is "active" on
  // any /@profile route (mirrors Mention); otherwise the matching nav item.
  const navActiveIndex = NAV_ITEMS.findIndex((item) =>
    isNavItemActive(item, pathname),
  );
  const activeIndex =
    navActiveIndex >= 0
      ? navActiveIndex
      : isAuthTabActive(pathname)
        ? AUTH_TAB_INDEX
        : -1;

  const prevActiveIndexRef = useRef(activeIndex);

  const onBarLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const width = e.nativeEvent.layout.width;
      tabWidth.value = width / TAB_COUNT;
      if (activeIndex >= 0) {
        indicatorX.value = withSpring(
          (width / TAB_COUNT) * activeIndex,
          SPRING_CONFIG,
        );
      }
    },
    [activeIndex, indicatorX, tabWidth],
  );

  // Animate the indicator when the active tab changes (computed during render,
  // not in an effect — mirrors Mention).
  if (prevActiveIndexRef.current !== activeIndex) {
    prevActiveIndexRef.current = activeIndex;
    if (tabWidth.value > 0 && activeIndex >= 0) {
      indicatorX.value = withSpring(tabWidth.value * activeIndex, SPRING_CONFIG);
    }
  }

  // Position/size are animated; the fill color is the theme primary at ~10%
  // applied via the `bg-primary/10` NativeWind class on the indicator view so
  // it stays reactive to the Bloom preset/mode.
  const indicatorStyle = useAnimatedStyle(() => ({
    position: "absolute" as const,
    top: INDICATOR_INSET,
    bottom: INDICATOR_INSET,
    width: tabWidth.value ? tabWidth.value - INDICATOR_INSET * 2 : 0,
    left: indicatorX.value + INDICATOR_INSET,
    borderRadius: INDICATOR_RADIUS,
  }));

  const { data: cart } = useCart();
  const cartCount = cart?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;

  /** Maximum badge count shown numerically; above this threshold "9+" is shown. */
  const MAX_BADGE_COUNT = 9;

  // Tab-root switch. Only navigate to routes that actually exist today;
  // pressing an unavailable item is a safe no-op (no missing-route navigation).
  const handlePress = useCallback(
    (item: NavItem) => {
      triggerHaptic();
      if (item.available) router.push(item.href as Parameters<typeof router.push>[0]);
    },
    [router],
  );

  // Layout + shadow only. The border and background colors are driven by
  // NativeWind theme classes (`border-border`, `bg-card/80`) so they stay
  // reactive to the Bloom preset/mode. `theme.colors.shadow` is already a valid
  // `rgba(...)` string from the Bloom theme (no NativeWind equivalent). The
  // floating pill clears the OS gesture bar / home indicator by folding the
  // bottom safe-area inset into its `bottom` offset.
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
      <Animated.View className="bg-primary/10" style={indicatorStyle} />
      {NAV_ITEMS.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => handlePress(item)}
          style={tabStyle}
          accessibilityRole="tab"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: isNavItemActive(item, pathname) }}
        >
          <View className="relative items-center justify-center">
            <TabIcon
              icon={item.icon}
              isActive={isNavItemActive(item, pathname)}
            />
            {item.key === "cart" && cartCount > 0 ? (
              <View
                pointerEvents="none"
                className="absolute -right-0.5 -top-0.5 h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1"
              >
                <Text className="text-[10px] font-bold text-primary-foreground">
                  {cartCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : cartCount}
                </Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      ))}
      <AuthTab isActive={activeIndex === AUTH_TAB_INDEX} />
    </>
  );

  // Web frosted-glass surface: a subtle CSS backdrop blur over the translucent
  // `bg-card/80` token (applied via NativeWind className below) so the content
  // behind the bar blurs through, mirroring the native BlurView. The backdrop
  // props are web-only CSS, gated behind the `Platform.OS === 'web'` branch.
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

  if (Platform.OS === "web") {
    return (
      <View
        className="border border-border bg-card/80"
        style={webContainerStyle}
        onLayout={onBarLayout}
      >
        {innerContent}
      </View>
    );
  }

  return (
    <View
      className="border border-border"
      style={containerStyle}
      onLayout={onBarLayout}
    >
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
