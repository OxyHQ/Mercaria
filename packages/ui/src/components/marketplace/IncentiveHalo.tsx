import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * Decorative multi-stop "incentive halo" ring (web `boxShadow`). Mirrors Shop's
 * gradient reward ring around a merchant logo — purely visual, no real reward
 * data behind it. The white inner stop reads as a 1.5px gap, then a
 * violet→blue gradient ring, then a soft outer glow.
 */
const INCENTIVE_HALO_SHADOW =
  "0 0 0 1.5px #FFFFFF, 0 0 0 3px #7C3AED, 0 0 0 4.5px #2563EB, 0 0 10px 4.5px rgba(124,58,237,0.35)";

export interface IncentiveHaloProps {
  /** Content wrapped by the halo (typically a rounded logo). */
  children: ReactNode;
}

/**
 * Wraps its child in the decorative gradient incentive halo. The wrapper is a
 * `rounded-full bg-card` View carrying the halo `boxShadow` on web; native
 * simply renders the child centered (the shadow is web-only and decorative).
 */
export function IncentiveHalo({ children }: IncentiveHaloProps) {
  return (
    <View
      className="items-center justify-center rounded-radius-max bg-bg-fill"
      style={{ boxShadow: INCENTIVE_HALO_SHADOW }}
    >
      {children}
    </View>
  );
}
