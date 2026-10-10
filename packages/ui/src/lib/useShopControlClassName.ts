import { useReducedMotion } from "react-native-reanimated";
import { useColorScheme } from "./useColorScheme";
import { cn } from "./cn";

type ShopControlAppearance = "primary" | "secondary" | "outline" | "tertiary";

const PAINT = {
  tertiary: ["shop-control-tertiary", "shop-control-tertiary-dark"],
  primary: ["shop-control-primary", "shop-control-primary-dark"],
  secondary: ["shop-control-secondary", "shop-control-secondary-dark"],
  outline: ["shop-control-outline", "shop-control-outline-dark"],
} as const;
const HOVER = {
  tertiary: ["shop-control-tertiary-interactive", "shop-control-tertiary-dark-interactive"],
  primary: ["shop-control-primary-interactive", "shop-control-primary-interactive"],
  secondary: ["shop-control-secondary-interactive", "shop-control-secondary-dark-interactive"],
  outline: ["shop-control-outline-interactive", "shop-control-outline-dark-interactive"],
} as const;

/** Paint Bloom's flat buttons with Shop's marketplace recipe. NativeWind's
 * native resolver does not support :enabled, so disabled/loading state selects
 * the interaction class explicitly. Reduced motion also omits press scaling. */
export function useShopControlClassName() {
  const { isDarkColorScheme } = useColorScheme();
  const reducedMotion = useReducedMotion();
  return (appearance: ShopControlAppearance, disabled = false, loading = false) => cn(
    "shop-control",
    appearance === "tertiary" ? "text-shop-buttonMedium" : "text-shop-buttonLarge",
    appearance === "outline" && "shop-control-compact",
    PAINT[appearance][0],
    isDarkColorScheme && PAINT[appearance][1],
    disabled && "shop-control-disabled",
    disabled && isDarkColorScheme && "shop-control-disabled-dark",
    !disabled && !loading && HOVER[appearance][isDarkColorScheme ? 1 : 0],
    !disabled && !loading && !reducedMotion && "shop-control-pressable",
  );
}
