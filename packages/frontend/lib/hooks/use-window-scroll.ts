import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

const IS_WEB = Platform.OS === "web";

/** Subscribe to window scroll (web only). No-op on native. */
function subscribe(onChange: () => void): () => void {
  if (!IS_WEB) return () => undefined;
  window.addEventListener("scroll", onChange, { passive: true });
  return () => window.removeEventListener("scroll", onChange);
}

/** Current vertical document scroll offset (px). 0 on native / SSR. */
function getSnapshot(): number {
  return IS_WEB ? window.scrollY : 0;
}

function getServerSnapshot(): number {
  return 0;
}

/**
 * Live window scroll offset (px) on web, driven by `useSyncExternalStore` so it
 * stays reactive without a `useEffect`. Returns 0 on native (where the document
 * doesn't scroll — pages live inside a `ScrollView`). Use it to drive web
 * scroll-linked effects (e.g. a parallax hero); keep the consumer small so only
 * that subtree re-renders per scroll frame.
 */
export function useWindowScrollY(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
