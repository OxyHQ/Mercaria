import React, { useCallback, useMemo } from "react";
import { Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { BottomBar, type BottomBarProps } from "@oxy.so/bloom/bottom-bar";
import { LucideGlyph } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { NAV_ITEMS, isNavItemActive } from "./nav-items";

function triggerHaptic() {
  if (Platform.OS === "web") return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/**
 * The phone navigation: Bloom's `BottomBar` in `AppShell`'s `bottomBar` slot,
 * which pins it, applies the bottom safe area and reserves its measured height
 * under the content. It renders the permission-visible {@link NAV_ITEMS} — the
 * same destinations as the sidebar — and nothing when the caller can see none
 * (Bloom's bar renders null with no items).
 */
export function BottomTabBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useActiveStoreContext();

  const visible = useMemo(() => NAV_ITEMS.filter((item) => can(item.permission)), [can]);

  const items = useMemo<BottomBarProps["items"]>(
    () =>
      visible.map((item) => ({
        name: item.key,
        label: t(item.labelKey),
        icon: <LucideGlyph icon={item.icon} />,
      })),
    [t, visible],
  );

  // No matching destination (a pushed screen) selects no tab.
  const value = visible.find((item) => isNavItemActive(item, pathname))?.key ?? "";

  const onValueChange = useCallback(
    (name: string) => {
      triggerHaptic();
      // The route is read from the typed table, never from the tab's name.
      const destination = visible.find((item) => item.key === name);
      if (destination) router.push(destination.href);
    },
    [router, visible],
  );

  return <BottomBar items={items} value={value} onValueChange={onValueChange} />;
}
