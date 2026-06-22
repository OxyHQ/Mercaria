import { ShoppingCart, ReceiptText, type LucideIcon } from "lucide-react-native";
import type { StorePermission } from "@mercaria/shared-types";

/**
 * Canonical navigation model for the POS shell, shared by the desktop
 * {@link NavRail} and the mobile {@link BottomTabBar} so both render the same
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
  { key: "register", label: "Register", icon: ShoppingCart, href: "/", permission: "draft_orders:write" },
  { key: "sales", label: "Sales", icon: ReceiptText, href: "/sales", permission: "orders:read" },
] as const;

/**
 * Whether `pathname` (from expo-router's `usePathname()`) should mark the given
 * nav item active. The register matches the root / group-index variants; the
 * rest match their route prefix.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.key === "register") {
    return (
      pathname === "/" ||
      pathname === "/(app)" ||
      (pathname.startsWith("/(app)") && pathname.replace("/(app)", "") === "")
    );
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
