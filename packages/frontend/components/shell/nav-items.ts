import {
  Home,
  LayoutGrid,
  ShoppingCart,
  Tag,
  Heart,
  type LucideIcon,
} from "lucide-react-native";
import type { RoutePath } from "expo-router";

/**
 * Canonical navigation model for the Shop-style shell, shared by the desktop
 * {@link Sidebar} and the mobile {@link BottomTabBar} so both render the exact
 * same set of destinations — including the ones whose screen nobody has built,
 * which render as dimmed, non-interactive rows rather than disappearing.
 */
interface NavItemBase {
  key: string;
  /**
   * i18n KEY for the accessible label / tooltip text, resolved with `t()` at
   * the render site.
   *
   * Deliberately a key rather than the text: this table is a module-scope
   * `const`, evaluated at import, and the locale store has not rehydrated by
   * then — a sentence here would freeze whichever language loaded first and
   * never change again, with nothing to blame. It is also what lets the i18n
   * guard's referential check see these leaves at all, since they are literals.
   */
  labelKey: string;
  icon: LucideIcon;
}

/**
 * An item is EITHER navigable and carries a real route, OR it is a placeholder
 * for a screen nobody has built and carries no route at all.
 *
 * `href` was a plain `string` — commented "so unavailable routes don't break
 * typing" — which is how a whole app's worth of `router.push(... as
 * Parameters<typeof router.push>[0])` casts got their justification (#330). The
 * two facts were never in tension: what could not be typed was `/categories`
 * and `/offers`, routes that do not exist, and the answer is that an item
 * pointing at nothing should not have somewhere to put it. So "pressing an
 * unavailable item is a safe no-op" stops being a rule the press handler
 * remembers and becomes a shape — there is no `href` to read on that branch —
 * while every route that IS live is checked against the real tree.
 *
 * Building one of those screens means adding `href` beside `available: true`,
 * and the compiler asks for it.
 */
export type NavItem =
  | (NavItemBase & { available: true; href: RoutePath })
  | (NavItemBase & { available: false });

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", labelKey: "nav.home", icon: Home, href: "/", available: true },
  // The SEO decision `docs/storefront-catalog.md` §Seams was waiting on is
  // made: `/categories` is a public indexable route, registered as
  // `category_index`, and the hub renders the published navigation trees. See
  // the `PublicRouteId` member for the reasoning.
  {
    key: "explore",
    labelKey: "nav.explore",
    icon: LayoutGrid,
    href: "/categories",
    available: true,
  },
  {
    key: "cart",
    labelKey: "nav.cart",
    icon: ShoppingCart,
    href: "/cart",
    available: true,
  },
  // No `href`: `/offers` is not a route.
  { key: "deals", labelKey: "nav.deals", icon: Tag, available: false },
  // #80 shipped `app/(app)/saved.tsx`, so this is navigable now. It stays a
  // real route rather than a modal because a saved list is a place a buyer
  // returns to and links to.
  { key: "saved", labelKey: "nav.saved", icon: Heart, href: "/saved", available: true },
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
  // An item with no route can never be the one you are on.
  if (!item.available) return false;
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
