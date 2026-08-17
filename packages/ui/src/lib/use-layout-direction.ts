import { useSyncExternalStore } from "react";
import { I18nManager, Platform } from "react-native";

/**
 * READING the layout direction currently in force, reactively (#429 item 4).
 *
 * Three modules, three jobs, one authority each:
 *
 *   * `../i18n/rtl-locales` decides WHICH LOCALES are right-to-left.
 *   * `../i18n/layout-direction` APPLIES that to the platform — it is the only
 *     writer, called from `createI18nStore`'s `onLocaleApplied` seam.
 *   * this reads back what was applied.
 *
 * It deliberately does NOT re-derive direction from a locale. A component in
 * this package cannot reach an app's i18n instance anyway (three apps consume
 * this package from source and each builds its own — that is why
 * `SharedUiTranslationProvider` exists), but the stronger reason is that a
 * second derivation could DISAGREE with the platform, and the layout is being
 * mirrored by the platform. Reading the value each platform's own layout engine
 * uses makes the transform sign agree with the flex order by construction.
 *
 * ## Why `useSyncExternalStore` and not a read in render
 *
 * `I18nManager.isRTL` and `document.documentElement.dir` are external mutable
 * state. The React Compiler is on in these apps, so a plain read from a render
 * position is free to be memoised around and the panel would keep animating in
 * the previous direction with nothing to blame. `useSyncExternalStore` is the
 * sanctioned escape; a `useEffect` is not, because the sign has to be settled
 * BEFORE the first paint of the tree that uses it, not one commit later.
 *
 * ## The two platforms differ, and the difference is not laziness
 *
 * On **web**, `syncLayoutDirection` sets `dir` on `<html>` live, so the value
 * really does change mid-session and a `MutationObserver` on that one attribute
 * is what makes a language switch re-render the panels.
 *
 * On **native**, `I18nManager.forceRTL` writes a preference that takes effect on
 * the NEXT launch — a running app cannot mirror itself, which is a React Native
 * constraint stated in `../i18n/layout-direction`. `I18nManager.isRTL` is
 * therefore constant for the lifetime of the process, so the subscription has
 * nothing to observe and correctly never fires. It is still routed through
 * `useSyncExternalStore` rather than read inline, so the compiler is told this
 * is external state on both platforms and the two branches cannot diverge in
 * how they are consumed.
 */

/** Native direction is fixed for the process, so there is nothing to observe. */
function subscribeToNothing(): () => void {
  return () => {};
}

function readNativeDirection(): boolean {
  return I18nManager.isRTL;
}

function subscribeToDocumentDirection(onStoreChange: () => void): () => void {
  // `document` is absent when the Expo web export renders the shell under Node,
  // and `MutationObserver` is absent in any environment that has a DOM shim
  // without one. Neither can change during that render, so not subscribing is
  // the whole of the correct behaviour — the first real client render subscribes.
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }

  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["dir"],
  });
  return () => observer.disconnect();
}

function readDocumentDirection(): boolean {
  // Guarded for the same export-under-Node reason. Falling back to `false` here
  // matches what the shell actually contains: every app's `+html.tsx` is emitted
  // once at export time with a static `lang="en"` and no `dir`, so left-to-right
  // is the truth about that document rather than a guess.
  if (typeof document === "undefined") {
    return false;
  }
  return document.documentElement.dir === "rtl";
}

const IS_WEB = Platform.OS === "web";

/**
 * Whether the layout around this component is currently mirrored.
 *
 * Re-renders the caller when a web document's direction changes; on native the
 * value is settled at launch and never moves.
 */
export function useIsRtlLayout(): boolean {
  return useSyncExternalStore(
    IS_WEB ? subscribeToDocumentDirection : subscribeToNothing,
    IS_WEB ? readDocumentDirection : readNativeDirection,
    // Server snapshot: the exported shell is left-to-right, as above.
    () => false,
  );
}
