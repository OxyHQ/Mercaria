import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Platform, ScrollView, View } from "react-native";
import { cn, useColorScheme } from "@mercaria/ui";

/** Spread (px) of the gutter-color mask around the rounded frame. Paints a ring
 *  of the gutter color over any content bleeding into the thin gutter + corners. */
export const GUTTER_MASK_SPREAD = 40;

interface ScreenShellProps {
  children: ReactNode;
  /** Override the panel surface bg (default "bg-card"). Applied to the web
   *  panel, the native outer View, and the native ScrollView so a caller can
   *  recolor the whole surface (e.g. a store's brand tint). */
  surfaceClassName?: string;
  /** Inline style for the panel surface, applied alongside `surfaceClassName`
   *  to the web panel, the native outer View, and the native ScrollView. An
   *  inline `backgroundColor` wins over the className bg, letting a caller paint
   *  the whole surface a dynamic color (e.g. a store's runtime brand color). */
  surfaceStyle?: StyleProp<ViewStyle>;
  /** Extra classes merged onto the inner centered content wrapper on both
   *  platforms. */
  contentClassName?: string;
}

/**
 * The shared page shell: a rounded `bg-card` panel + sticky gutter "bleed mask"
 * on web (desktop), and a single full-height `ScrollView` on native. Every page
 * renders its body inside this so the panel / mask / scroll behavior is
 * identical (Shop.app pattern — only the nav rail lives outside the panel).
 *
 * The platform split is intentional and unchanged from the original inline home
 * shell: web = document-flow panel + sticky mask (the BODY scrolls); native =
 * one ScrollView (no document scroll). Pages keep their own `<Head>` — the shell
 * never renders one.
 */
export function ScreenShell({
  children,
  surfaceClassName = "bg-card",
  surfaceStyle,
  contentClassName,
}: ScreenShellProps) {
  const { colors } = useColorScheme();
  const isWeb = Platform.OS === "web";

  // WEB: the content flows in normal document flow (no vertical ScrollView) so
  // the BODY scrolls — scrolling works from anywhere, incl. over the sticky rail
  // and gutter (Shop's pattern, pure NativeWind classes, zero scroll JS).
  if (isWeb) {
    return (
      <>
        {/* Decorative rounded-panel frame + bleed mask (desktop only, gated by
            CSS `max-md:hidden` — no JS width check). A STICKY overlay pinned to
            the viewport; the negative bottom margin gives it ~0 layout height so
            it doesn't push the content, while it frames the viewport and stays put
            as the body scrolls under it. The `boxShadow` paints a ring of the
            GUTTER color (Bloom `background` token — not hardcoded) around the
            rounded rect, masking any content that bleeds into the thin gutter +
            rounded corners; `clipPath: inset(-12px)` keeps that ring from
            spilling onto the rail. `pointer-events-none` passes clicks. */}
        <View
          pointerEvents="none"
          className="max-md:hidden web:sticky web:top-2 z-30 h-[calc(100dvh-16px)] w-full rounded-3xl border border-border web:[margin-bottom:calc(-100dvh+16px)] web:[clip-path:inset(-12px)]"
          style={{
            boxShadow: `0 0 0 ${GUTTER_MASK_SPREAD}px ${colors.background}`,
          }}
        />
        {/* The content panel flows in the document and scrolls with the body,
            passing under the sticky frame. Full-bleed below md, rounded card panel
            at md+. The content is centered (`mx-auto max-w-[2000px]`). */}
        <View
          className={cn(
            "relative w-full pb-24 web:min-h-screen web:overflow-x-clip md:rounded-3xl",
            surfaceClassName,
          )}
          style={surfaceStyle}
        >
          <View className={cn("web:mx-auto web:w-full web:max-w-[2000px]", contentClassName)}>
            {children}
          </View>
        </View>
      </>
    );
  }

  // NATIVE: a single full-height ScrollView (no document scroll on native).
  return (
    <View className={cn("flex-1", surfaceClassName)} style={surfaceStyle}>
      <ScrollView
        className={cn("flex-1", surfaceClassName)}
        style={surfaceStyle}
        contentContainerClassName="pb-24"
        keyboardShouldPersistTaps="handled"
      >
        <View className={contentClassName}>{children}</View>
      </ScrollView>
    </View>
  );
}
