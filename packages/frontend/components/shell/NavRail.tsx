import React, { useCallback, useState } from "react";
import { View, Pressable, Platform, type LayoutRectangle } from "react-native";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "expo-router";
import { LogIn, type LucideIcon } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Logo } from "@/components/Logo";
import { UserAvatar } from "@/components/user-avatar";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";
import { useOxy, showSignInModal } from "@oxyhq/services";
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
    <View
      pointerEvents="none"
      style={{ position: "fixed", left, top, transform: [{ translateY: "-50%" }], zIndex: 2147483647 }}
      className="rounded-md bg-foreground px-2.5 py-1"
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
          isActive ? "bg-secondary" : "active:bg-secondary web:hover:bg-secondary"
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

/* ================================================================
   Auth control (avatar when authenticated, sign-in otherwise)
   ================================================================ */

function AuthRailItem() {
  const { colors } = useColorScheme();
  const { isAuthenticated } = useOxy();
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  const label = isAuthenticated ? "Account" : "Sign in";
  const onPress = useCallback(() => {
    if (!isAuthenticated) showSignInModal();
  }, [isAuthenticated]);

  return (
    <View className="items-center justify-center">
      <Pressable
        onPress={onPress}
        onHoverIn={IS_WEB ? (e) => setAnchor(rectFromHover(e)) : undefined}
        onHoverOut={IS_WEB ? () => setAnchor(null) : undefined}
        accessibilityRole="button"
        accessibilityLabel={label}
        className={cn(
          "h-12 w-12 items-center justify-center rounded-2xl web:transition",
          "active:bg-secondary web:hover:bg-secondary"
        )}
      >
        {isAuthenticated ? (
          <UserAvatar size={32} />
        ) : (
          <LogIn size={22} color={colors.foreground} style={{ opacity: 0.35 }} />
        )}
      </Pressable>

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

  const goHome = useCallback(() => router.push("/"), [router]);

  const handlePress = useCallback(
    (item: NavItem) => {
      // Only navigate to routes that actually exist. Unavailable destinations
      // are intentional no-ops until their screens are built.
      if (item.available && item.href === "/") router.push("/");
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
          />
        ))}
      </View>

      {/* Bottom — auth control */}
      <AuthRailItem />
    </View>
  );
}
