import {
  LayoutDashboard,
  Package,
  ShoppingBag,
  Users,
  Tag,
  FolderTree,
  Plug,
  Settings,
  type LucideIcon,
} from "lucide-react-native";
import type { RoutePath } from "expo-router";
import type { StorePermission } from "@mercaria/shared-types";

/**
 * Canonical navigation model for the dashboard shell, shared by the desktop
 * {@link Sidebar} and the mobile {@link BottomTabBar} so both render the same
 * destinations. Each item is gated by a `permission`: the item is shown only
 * when the caller holds that permission on the active store (the server is the
 * authority — gating here just hides affordances that would 403).
 */
export interface NavItem {
  key: string;
  /**
   * Translation key for the accessible label / tooltip text (#398).
   *
   * A KEY rather than the sentence: this module is evaluated once at import,
   * before the locale store has rehydrated, so a resolved string here would
   * freeze whatever language the first render happened to see. Every consumer
   * calls `t(item.labelKey)` and therefore re-renders when the locale changes.
   */
  labelKey: string;
  icon: LucideIcon;
  /**
   * Route this item navigates to. `RoutePath` rather than `string`, so the
   * literals below are checked against the real route tree where they are
   * written and renaming a screen fails the build (#330).
   */
  href: RoutePath;
  /** Permission required to see this destination. */
  permission: StorePermission;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard, href: "/", permission: "stats:read" },
  { key: "products", labelKey: "nav.products", icon: Package, href: "/products", permission: "products:read" },
  { key: "orders", labelKey: "nav.orders", icon: ShoppingBag, href: "/orders", permission: "orders:read" },
  { key: "customers", labelKey: "nav.customers", icon: Users, href: "/customers", permission: "customers:read" },
  { key: "discounts", labelKey: "nav.discounts", icon: Tag, href: "/discounts", permission: "discounts:write" },
  { key: "collections", labelKey: "nav.collections", icon: FolderTree, href: "/collections", permission: "collections:write" },
  { key: "channels", labelKey: "nav.channels", icon: Plug, href: "/channels", permission: "channels:write" },
  { key: "settings", labelKey: "nav.settings", icon: Settings, href: "/settings", permission: "settings:write" },
] as const;

/**
 * Whether `pathname` (from expo-router's `usePathname()`) should mark the given
 * nav item active. Dashboard matches the root / group-index variants; the rest
 * match their route prefix.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.key === "dashboard") {
    return (
      pathname === "/" ||
      pathname === "/(app)" ||
      (pathname.startsWith("/(app)") && pathname.replace("/(app)", "") === "")
    );
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
