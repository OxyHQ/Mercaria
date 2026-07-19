import {
  LayoutDashboard,
  Package,
  ShoppingBag,
  Users,
  Tag,
  FolderTree,
  Settings,
  type LucideIcon,
} from "lucide-react-native";
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
  /** Accessible label / tooltip text. */
  label: string;
  icon: LucideIcon;
  /** Route this item navigates to. */
  href: string;
  /** Permission required to see this destination. */
  permission: StorePermission;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/", permission: "stats:read" },
  { key: "products", label: "Products", icon: Package, href: "/products", permission: "products:read" },
  { key: "orders", label: "Orders", icon: ShoppingBag, href: "/orders", permission: "orders:read" },
  { key: "customers", label: "Customers", icon: Users, href: "/customers", permission: "customers:read" },
  { key: "discounts", label: "Discounts", icon: Tag, href: "/discounts", permission: "discounts:write" },
  { key: "collections", label: "Collections", icon: FolderTree, href: "/collections", permission: "collections:write" },
  { key: "settings", label: "Settings", icon: Settings, href: "/settings", permission: "settings:write" },
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
