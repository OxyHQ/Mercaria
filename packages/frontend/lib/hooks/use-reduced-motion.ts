import React from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Tracks the OS "reduce motion" accessibility preference (on web this maps to
 * `prefers-reduced-motion`). When it returns `true`, callers should skip
 * entering/exiting/layout animations so the UI honours the user's setting.
 *
 * This is one of the rare legitimate uses of `useEffect`: subscribing to an
 * external, imperative platform event source (the AccessibilityInfo emitter)
 * and reading its initial value once on mount.
 */
export function useReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {
        // If the platform can't report the preference, default to animations on.
        if (mounted) setReduceMotion(false);
      });

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (enabled) => setReduceMotion(enabled)
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
