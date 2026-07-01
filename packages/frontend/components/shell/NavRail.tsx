import React, { useCallback, useState } from "react";
import { View, Pressable, Platform, type LayoutRectangle } from "react-native";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "expo-router";
import { type LucideIcon } from "lucide-react-native";
import { Text, useColorScheme } from "@mercaria/ui";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { ProfileButton, showSignInModal } from "@oxyhq/services";
import { useCart } from "@/lib/hooks/use-cart";
import { NAV_ITEMS, isNavItemActive, type NavItem } from "./nav-items";

const IS_WEB = Platform.OS === "web";

/** Viewport coordinates of the hovered rail item, used to place the tooltip. */
type AnchorRect = Pick<LayoutRectangle, "x" | "y" | "width" | "height">;

/**
 * Read the hovered element's viewport rect from a RN-web hover event. RN-web
 * fires `onHoverIn` from a DOM mouse/pointer event whose `currentTarget` is the
 * pressable's DOM node, so `getBoundingClientRect()` gives the on-screen box used
 * to anchor the fixed-position tooltip. Returns `null` if unavailable.
 */
function rectFromHover(event: { currentTarget?: unknown }): AnchorRect | null {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    const r = target.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return null;
}

/* ================================================================
   Rail hover tooltip (web only)

   The rail's content sibling (the feed column) and its horizontal carousels
   establish their own stacking contexts (the carousels are `transform`ed by
   RN-web), so a tooltip rendered inside the rail — however high its z-index —
   paints UNDERNEATH that content. To win reliably, the tooltip is portaled to
   `document.body` and positioned with `fixed` viewport coordinates taken from
   the hovered item's on-screen rect: as a direct child of `<body>` it sits
   outside every content stacking context. Web-only; native has no hover state.
   ================================================================ */

function RailTooltip({ label, anchor }: { label: string; anchor: AnchorRect | null }) {
  if (!IS_WEB || anchor === null || typeof document === "undefined") return null;

  // Right of the icon, vertically centred on it (8px gap mirrors the old `ml-2`).
  const left = anchor.x + anchor.width + 8;
  const top = anchor.y + anchor.height / 2;

  return createPortal(
    // `position: fixed` and the `-50%` percentage translate are web-only CSS that
    // React Native's `ViewStyle` doesn't model, so they live in NativeWind web
    // arbitrary classes; only RN-valid numeric keys stay in `style`.
    <View
      pointerEvents="none"
      style={{ left, top, zIndex: 2147483647 }}
      className="web:fixed web:[transform:translateY(-50%)] rounded-md bg-foreground px-2.5 py-1"
    >
      <Text className="text-xs font-medium text-background" numberOfLines={1}>
        {label}
      </Text>
    </View>,
    document.body
  );
}

/* ================================================================
   Rail item — square icon button with active pill + web hover tooltip
   ================================================================ */

/** Maximum badge count shown as a number; above this threshold "9+" is shown. */
const MAX_BADGE_COUNT = 9;

interface NavRailItemProps {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onPress: () => void;
  badgeCount?: number;
}

function NavRailItem({ icon: Icon, label, isActive, onPress, badgeCount }: NavRailItemProps) {
  const { colors } = useColorScheme();
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  return (
    <View className="relative items-center justify-center">
      <Pressable
        onPress={onPress}
        onHoverIn={IS_WEB ? (e) => setAnchor(rectFromHover(e)) : undefined}
        onHoverOut={IS_WEB ? () => setAnchor(null) : undefined}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: isActive }}
        className={cn(
          "h-12 w-12 items-center justify-center rounded-2xl web:transition",
          isActive ? "bg-secondary" : "active:bg-secondary web:hover:bg-secondary"
        )}
      >
        <Icon
          size={22}
          color={isActive ? colors.primary : colors.foreground}
          style={isActive ? undefined : { opacity: 0.35 }}
        />
      </Pressable>

      {badgeCount !== undefined && badgeCount > 0 ? (
        <View
          pointerEvents="none"
          className="absolute -right-0.5 -top-0.5 h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1"
        >
          <Text className="text-[10px] font-bold text-primary-foreground">
            {badgeCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : badgeCount}
          </Text>
        </View>
      ) : null}

      <RailTooltip label={label} anchor={anchor} />
    </View>
  );
}

/* ================================================================
   NavRail — vertical icon rail (web/desktop ≥768)
   ================================================================ */

export function NavRail() {
  const router = useRouter();
  const pathname = usePathname();
  const { data: cart } = useCart();

  const cartCount = cart?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;

  const goHome = useCallback(() => router.push("/"), [router]);

  const goSettings = useCallback(() => router.push("/(app)/settings"), [router]);

  const handlePress = useCallback(
    (item: NavItem) => {
      // Only navigate to routes that actually exist. Unavailable destinations
      // are intentional no-ops until their screens are built.
      if (item.available) router.push(item.href as Parameters<typeof router.push>[0]);
    },
    [router]
  );

  return (
    // Transparent rail: no border, no panel background — the icons float over
    // the app gutter background; only the content panel has a border. (Shop.app
    // parity: the rail is a bare sticky column.)
    <View className="h-full w-[76px] items-center justify-between py-4">
      {/* Top — brand mark → home */}
      <Pressable
        onPress={goHome}
        accessibilityRole="button"
        accessibilityLabel="Home"
        className="h-12 w-12 items-center justify-center rounded-2xl active:bg-secondary web:hover:bg-secondary web:transition"
      >
        <Logo size={32} />
      </Pressable>

      {/* Middle — nav destinations */}
      <View className="flex-col items-center gap-2">
        {NAV_ITEMS.map((item) => (
          <NavRailItem
            key={item.key}
            icon={item.icon}
            label={item.label}
            isActive={isNavItemActive(item, pathname)}
            onPress={() => handlePress(item)}
            badgeCount={item.key === "cart" ? cartCount : undefined}
          />
        ))}
      </View>

      {/* Bottom — account trigger. ProfileButton owns all three auth states
          (undetermined skeleton, signed-in avatar + account switcher, signed-out
          "Sign in") and the device-account switcher menu (switch / add account /
          sign out). Collapsed to a bare avatar for the 76px rail. */}
      <ProfileButton
        expanded={false}
        onNavigateManage={goSettings}
        onAddAccount={showSignInModal}
      />
    </View>
  );
}
