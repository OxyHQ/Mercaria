import {
  Home,
  LayoutGrid,
  ShoppingCart,
  Tag,
  Heart,
  type LucideIcon,
} from "lucide-react-native";

/**
 * Canonical navigation model for the Shop-style shell, shared by the desktop
 * {@link NavRail} and the mobile {@link BottomTabBar} so both render the exact
 * same set of destinations.
 *
 * `href` is the route this item is *intended* to point at. Only items whose
 * route already exists in the app (`available: true`) are navigable — pressing
 * an unavailable item is a safe no-op (no navigation to a missing route, no
 * stub route files). When the corresponding screens are built, flip
 * `available` to `true`; the press handler will start routing automatically.
 */
export interface NavItem {
  key: string;
  /** Accessible label / tooltip text. */
  label: string;
  icon: LucideIcon;
  /** Intended route. Plain string so unavailable routes don't break typing. */
  href: string;
  /** Whether `href` is a real, navigable route today. */
  available: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "Home", icon: Home, href: "/", available: true },
  {
    key: "explore",
    label: "Explore",
    icon: LayoutGrid,
    href: "/categories",
    available: false,
  },
  {
    key: "cart",
    label: "Cart",
    icon: ShoppingCart,
    href: "/cart",
    available: false,
  },
  { key: "deals", label: "Deals", icon: Tag, href: "/offers", available: false },
  { key: "saved", label: "Saved", icon: Heart, href: "/saved", available: false },
] as const;

/**
 * Whether `pathname` (from expo-router's `usePathname()`) should mark the
 * given nav item as active. Home matches the root / group-index variants.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.key === "home") {
    return (
      pathname === "/" ||
      pathname === "/(app)" ||
      (pathname.startsWith("/(app)") && pathname.replace("/(app)", "") === "")
    );
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Whether the trailing auth/avatar tab should be marked active. Account/profile
 * routes (`/@handle`) belong to the signed-in user, so they light up the auth
 * tab rather than any nav destination. Kept here so the `/@` route knowledge
 * lives in the nav model alongside {@link isNavItemActive}, not in the bar.
 */
export function isAuthTabActive(pathname: string): boolean {
  return pathname.startsWith("/@");
}
