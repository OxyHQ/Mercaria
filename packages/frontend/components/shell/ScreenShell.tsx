import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Platform, ScrollView, View } from "react-native";
import { ContentPanel } from "@oxyhq/bloom/content-panel";
import { cn } from "@mercaria/ui";

import { useIsMdWeb } from "@/lib/hooks/use-is-md-web";

interface ScreenShellProps {
  children: ReactNode;
  /** Override the panel surface bg (default "bg-card"). Lets a caller recolor
   *  the whole surface (e.g. a store's brand tint). */
  surfaceClassName?: string;
  /** Inline style for the panel surface, applied alongside `surfaceClassName`.
   *  An inline `backgroundColor` wins over the className bg, letting a caller
   *  paint the whole surface a dynamic color (e.g. a store's runtime brand
   *  color). */
  surfaceStyle?: StyleProp<ViewStyle>;
  /** Extra classes merged onto the inner centered content wrapper. */
  contentClassName?: string;
}

/**
 * The shared page shell: a thin wrapper over Bloom's `ContentPanel` (the framed
 * app-content surface). Every page renders its body inside this so the rounded
 * panel, the web sticky bleed-mask + border frame, and the centered content
 * column stay identical across screens (Shop.app pattern — only the nav rail
 * lives outside the panel).
 *
 * `ContentPanel` owns the surface, the corner radius, and (on web) the sticky
 * gutter mask + continuous border. Scroll, however, is an app concern that
 * `ContentPanel` deliberately does NOT own, so the platform split lives here:
 *
 * - WEB: the BODY scrolls (document-scroll model). `ContentPanel` frames the
 *   content at the `md` breakpoint (`useIsMdWeb`, replacing the old
 *   `max-md:hidden` CSS gate) and pins its sticky overlays to the viewport — an
 *   inner `ScrollView` would break that, so the web path has none.
 * - NATIVE: there is no document scroll, so the body lives in a single
 *   full-height `ScrollView` inside the panel (matching the original shell).
 *
 * Pages keep their own `<Head>` — the shell never renders one.
 */
export function ScreenShell({
  children,
  surfaceClassName = "bg-card",
  surfaceStyle,
  contentClassName,
}: ScreenShellProps) {
  const framed = useIsMdWeb();

  // NATIVE: a single full-height ScrollView inside the panel (no document
  // scroll on native). Reproduces the original shell's ScrollView props so
  // native screens behave identically; `ContentPanel` now paints the surface.
  if (Platform.OS !== "web") {
    return (
      <ContentPanel
        framed={false}
        surfaceClassName={surfaceClassName}
        surfaceStyle={surfaceStyle}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-24"
          keyboardShouldPersistTaps="handled"
        >
          <View className={contentClassName}>{children}</View>
        </ScrollView>
      </ContentPanel>
    );
  }

  // WEB: the content flows in the document and scrolls with the body, passing
  // under the panel's sticky frame. The content is centered (`mx-auto
  // max-w-[2000px]`) with the bottom clearance (`pb-24`) the rail / bottom bar
  // need.
  return (
    <ContentPanel
      framed={framed}
      surfaceClassName={surfaceClassName}
      surfaceStyle={surfaceStyle}
      contentClassName={cn(
        "web:mx-auto web:w-full web:max-w-[2000px] pb-24",
        contentClassName,
      )}
    >
      {children}
    </ContentPanel>
  );
}
