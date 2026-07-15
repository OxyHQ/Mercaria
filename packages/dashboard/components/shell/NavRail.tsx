import React, { useCallback, useState } from "react";
import { View, Pressable, Platform, type LayoutRectangle } from "react-native";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "expo-router";
import { type LucideIcon } from "lucide-react-native";
import { Text, useColorScheme } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { ProfileButton, openAccountDialog } from "@oxyhq/services";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { NAV_ITEMS, isNavItemActive, type NavItem } from "./nav-items";

const IS_WEB = Platform.OS === "web";

type AnchorRect = Pick<LayoutRectangle, "x" | "y" | "width" | "height">;

function rectFromHover(event: { currentTarget?: unknown }): AnchorRect | null {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    const r = target.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return null;
}

/**
 * Rail hover tooltip (web only). Portaled to `document.body` so it sits outside
 * every content stacking context and is positioned with `fixed` viewport coords.
 */
function RailTooltip({ label, anchor }: { label: string; anchor: AnchorRect | null }) {
  if (!IS_WEB || anchor === null || typeof document === "undefined") return null;

  const left = anchor.x + anchor.width + 8;
  const top = anchor.y + anchor.height / 2;

  return createPortal(
    <View
      pointerEvents="none"
      style={{ position: "fixed", left, top, transform: [{ translateY: "-50%" }], zIndex: 2147483647 }}
      className="rounded-md bg-foreground px-2.5 py-1"
    >
      <Text className="text-xs font-medium text-background" numberOfLines={1}>
        {label}
      </Text>
    </View>,
    document.body,
  );
}

interface NavRailItemProps {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onPress: () => void;
}

function NavRailItem({ icon: Icon, label, isActive, onPress }: NavRailItemProps) {
  const { colors } = useColorScheme();
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  return (
    <View className="items-center justify-center">
      <Pressable
        onPress={onPress}
        onHoverIn={IS_WEB ? (e) => setAnchor(rectFromHover(e)) : undefined}
        onHoverOut={IS_WEB ? () => setAnchor(null) : undefined}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: isActive }}
        className={cn(
          "h-12 w-12 items-center justify-center rounded-2xl web:transition",
          isActive ? "bg-secondary" : "active:bg-secondary web:hover:bg-secondary",
        )}
      >
        <Icon
          size={22}
          color={isActive ? colors.primary : colors.foreground}
          style={isActive ? undefined : { opacity: 0.35 }}
        />
      </Pressable>
      <RailTooltip label={label} anchor={anchor} />
    </View>
  );
}

/** NavRail — vertical icon rail (web/desktop ≥768). Items gated by permission. */
export function NavRail() {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useActiveStoreContext();

  const goHome = useCallback(() => router.push("/"), [router]);

  const goSettings = useCallback(() => router.push("/(app)/settings"), [router]);

  const handlePress = useCallback(
    (item: NavItem) => {
      router.push(item.href as never);
    },
    [router],
  );

  const visibleItems = NAV_ITEMS.filter((item) => can(item.permission));

  return (
    <View className="h-full w-[76px] items-center justify-between py-4">
      <Pressable
        onPress={goHome}
        accessibilityRole="button"
        accessibilityLabel="Dashboard"
        className="h-12 w-12 items-center justify-center rounded-2xl active:bg-secondary web:hover:bg-secondary web:transition"
      >
        <Logo size={32} />
      </Pressable>

      <View className="flex-col items-center gap-2">
        {visibleItems.map((item) => (
          <NavRailItem
            key={item.key}
            icon={item.icon}
            label={item.label}
            isActive={isNavItemActive(item, pathname)}
            onPress={() => handlePress(item)}
          />
        ))}
      </View>

      {/* Account trigger. ProfileButton owns all three auth states (undetermined
          skeleton, signed-in avatar + account switcher, signed-out "Sign in")
          and the device-account switcher menu. Collapsed to a bare avatar for
          the 76px rail. "Manage account" routes to dashboard settings. */}
      <ProfileButton
        expanded={false}
        onNavigateManage={goSettings}
        onAddAccount={() => openAccountDialog()}
      />
    </View>
  );
}
