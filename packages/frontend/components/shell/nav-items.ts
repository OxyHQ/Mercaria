import type { ShopNavigationIconName } from '@mercaria/ui';
import type { RoutePath } from 'expo-router';

/**
 * Canonical navigation model for the storefront shell, shared by the desktop
 * sidebar (`useStorefrontSidebar`, Bloom's `Sidebar`) and the mobile
 * {@link BottomTabBar} (Bloom's `BottomBar`) so both render the exact same set
 * of destinations. A destination whose screen nobody has built
 * (`available: false`) is left out of both: Bloom's rows have no disabled state,
 * and a row that does nothing when pressed is worse than no row.
 */
interface NavItemBase {
  key: string;
  desktopOnly?: boolean;
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
  icon: ShopNavigationIconName;
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
  {
    key: 'home',
    labelKey: 'nav.home',
    icon: 'home',
    href: '/',
    available: true,
  },
  // The SEO decision `docs/storefront-catalog.md` §Seams was waiting on is
  // made: `/explore` is a public indexable route, registered as
  // `category_index`, and the hub renders the published navigation trees. See
  // the `PublicRouteId` member for the reasoning.
  {
    key: 'explore',
    labelKey: 'nav.explore',
    icon: 'explore',
    href: '/explore',
    available: true,
  },
  {
    key: 'cart',
    labelKey: 'nav.cart',
    icon: 'cart',
    href: '/cart',
    available: true,
  },
  {
    key: 'deals',
    labelKey: 'nav.deals',
    icon: 'deals',
    href: '/deals',
    available: true,
  },
  {
    key: 'orders',
    labelKey: 'settings.sections.orders',
    icon: 'orders',
    href: '/orders',
    available: true,
    desktopOnly: true,
  },
] as const;

/**
 * Whether `pathname` (from expo-router's `usePathname()`) should mark the
 * given nav item as active. Home matches the root / group-index variants.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.key === 'home') {
    return (
      pathname === '/' ||
      pathname === '/(app)' ||
      (pathname.startsWith('/(app)') && pathname.replace('/(app)', '') === '')
    );
  }
  // An item with no route can never be the one you are on.
  if (!item.available) return false;
  if (
    item.key === 'explore' &&
    (pathname === '/3d' ||
      pathname.startsWith('/3d/') ||
      pathname.startsWith('/categories/') ||
      pathname.startsWith('/curations/'))
  )
    return true;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Whether the trailing auth/avatar tab should be marked active. Account/profile
 * routes (`/@handle`) belong to the signed-in user, so they light up the auth
 * tab rather than any nav destination. Kept here so the `/@` route knowledge
 * lives in the nav model alongside {@link isNavItemActive}, not in the bar.
 */
export function isAuthTabActive(pathname: string): boolean {
  return (
    pathname === '/profile' ||
    pathname === '/saved' ||
    pathname.startsWith('/orders') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/@')
  );
}
