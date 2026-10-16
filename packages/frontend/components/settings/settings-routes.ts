/**
 * Settings addresses, and the one way to open Settings from outside React.
 *
 * Settings is a dialog, not a screen. A `/settings/*` address therefore never
 * becomes a stack entry on native: an incoming link is intercepted in
 * `app/+native-intent.tsx` and handed to the provider through
 * `requestSettings`. Pushing the compatibility route and popping it on mount
 * instead is what crashed Mention ("Unable to find a fragment to pop", its
 * #1126). On web the `app/(app)/settings/*` files are the bridge.
 *
 * Deliberately free of React and Bloom imports: `+native-intent` loads it
 * before the app tree exists.
 */
export const STOREFRONT_SETTINGS_PAGES = ["account", "general", "appearance", "addresses", "feedback"] as const;
export type StorefrontSettingsPage = (typeof STOREFRONT_SETTINGS_PAGES)[number];

const pageIds: ReadonlySet<string> = new Set(STOREFRONT_SETTINGS_PAGES);

/**
 * The page a `/settings[/page]` address opens: `undefined` is the section list
 * (bare `/settings`), `null` is not a settings address at all.
 */
export function settingsPageFromRoute(route: string): StorefrontSettingsPage | undefined | null {
  const pathname = route.split(/[?#]/)[0]?.replace(/\/$/, "") ?? "";
  if (pathname === "/settings") return undefined;
  if (!pathname.startsWith("/settings/")) return null;
  const id = pathname.slice("/settings/".length);
  return pageIds.has(id) ? (id as StorefrontSettingsPage) : null;
}

type SettingsRequestListener = (page: StorefrontSettingsPage | undefined) => void;
let listener: SettingsRequestListener | null = null;
let pending: { page: StorefrontSettingsPage | undefined } | null = null;

/**
 * Opens Settings at a `/settings[/page]` address. Returns false for any other
 * address so the caller can route it normally. A request made before the
 * provider mounts (a cold-start link) is held and delivered on mount.
 */
export function requestSettings(route: string): boolean {
  const page = settingsPageFromRoute(route);
  if (page === null) return false;
  if (listener) listener(page);
  else pending = { page };
  return true;
}

/** The provider's side of `requestSettings`. One provider at a time. */
export function onSettingsRequest(next: SettingsRequestListener): () => void {
  listener = next;
  if (pending) {
    const { page } = pending;
    pending = null;
    next(page);
  }
  return () => {
    if (listener === next) listener = null;
  };
}
