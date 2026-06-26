import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

const IS_WEB = Platform.OS === "web";

/** Tailwind's `md` breakpoint (768px): the width at which the app frames its
 *  routed content in a rounded panel. */
const MD_BREAKPOINT_QUERY = "(min-width: 768px)";

/** The `md`-and-up media query list on web, or `null` on native / SSR. */
function getMediaQueryList(): MediaQueryList | null {
  if (!IS_WEB || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(MD_BREAKPOINT_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const mql = getMediaQueryList();
  if (!mql) return () => undefined;
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return getMediaQueryList()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` only on web when the viewport is at least Tailwind's `md` breakpoint
 * (768px) wide — the width at which the app frames its content in a rounded
 * panel. Returns `false` on native and on the SSR / first-paint pass, mirroring
 * the `max-md:hidden` CSS gate it replaces. Driven by `useSyncExternalStore`
 * (same pattern as `useWindowScrollY`) so it stays reactive to viewport resizes
 * without a `useEffect`.
 */
export function useIsMdWeb(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
