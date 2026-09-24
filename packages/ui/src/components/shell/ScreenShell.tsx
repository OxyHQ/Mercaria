import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Platform, ScrollView, View } from "react-native";
import { useBottomEdgeInset } from "@oxy.so/bloom/layout";
import { cn } from "../../lib/cn";

export interface ScreenShellProps {
  children: ReactNode;
  /** Classes for the page surface (e.g. `bg-background`). Unset, the page is
   *  transparent and the app shell's own surface shows through. */
  surfaceClassName?: string;
  /** Inline style for the page surface, applied alongside `surfaceClassName`.
   *  An inline `backgroundColor` wins over the className bg, letting a caller
   *  paint the page a dynamic color (e.g. a store's runtime brand color). */
  surfaceStyle?: StyleProp<ViewStyle>;
  /** Extra classes merged onto the inner centered content wrapper. */
  contentClassName?: string;
  /** When false, native does NOT wrap children in a ScrollView — for
   *  self-scrolling bodies (FlashList/FlatList). No effect on web, which uses
   *  document scroll regardless. Default true. */
  scroll?: boolean;
}

/**
 * The per-page wrapper every screen renders its body in.
 *
 * The FRAME is not this component's any more: Bloom's `AppShell`
 * (`@oxy.so/bloom/app-shell`, mounted in each app's `(app)/_layout.tsx`) owns
 * the navigation, the framed `ContentPanel` where the app asks for one, and the
 * clearance under its bottom bar. A page must not render a `ContentPanel` of its
 * own — Bloom's nesting guard rejects one inside the shell's.
 *
 * What stays here is the platform scroll split, which the shell leaves to the
 * page by design:
 *
 * - WEB: the DOCUMENT scrolls (`AppShell scroll="document"`), so there is no
 *   inner `ScrollView` — one would pin the sticky navigation to a box that never
 *   scrolls. The content is centered (`mx-auto max-w-[2000px]`); the shell
 *   reserves the bottom bar's measured height itself.
 * - NATIVE: the shell is a fixed frame (`scroll="fixed"`) and the page owns its
 *   scroller, so the body lives in one full-height `ScrollView` (unless `scroll`
 *   is false, for a body that scrolls itself), padded by the bottom edge the
 *   shell's bar has claimed (`useBottomEdgeInset`).
 *
 * Pages keep their own `<Head>` — the shell never renders one.
 */
export function ScreenShell({
  children,
  surfaceClassName,
  surfaceStyle,
  contentClassName,
  scroll = true,
}: ScreenShellProps) {
  const bottomInset = useBottomEdgeInset();

  if (Platform.OS !== "web") {
    return (
      <View className={cn("flex-1", surfaceClassName)} style={surfaceStyle}>
        {scroll ? (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: bottomInset }}
            keyboardShouldPersistTaps="handled"
          >
            <View className={contentClassName}>{children}</View>
          </ScrollView>
        ) : (
          <View className={cn("flex-1", contentClassName)}>{children}</View>
        )}
      </View>
    );
  }

  return (
    <View className={cn("grow", surfaceClassName)} style={surfaceStyle}>
      <View className={cn("web:mx-auto web:w-full web:max-w-[2000px]", contentClassName)}>
        {children}
      </View>
    </View>
  );
}
