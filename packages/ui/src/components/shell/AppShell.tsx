import React, { useMemo } from "react";
import { View, Platform, type ViewStyle } from "react-native";
import { useSidebarCollapse } from "../../lib/useSidebarCollapse";

/** Rail widths for the collapse animation (icon rail ⇄ expanded sidebar). */
const RAIL_EXPANDED_WIDTH = 255;
const RAIL_COLLAPSED_WIDTH = 56;
const RAIL_WIDTH_TRANSITION = "width 300ms cubic-bezier(0.22, 1, 0.36, 1)";

/** ViewStyle plus the web-only CSS `transition` shorthand (RNW passthrough). */
interface RailStyle extends ViewStyle {
  transition?: string;
}

export interface AppShellProps {
  /**
   * The desktop rail (web md+). The host passes its own {@link AppSidebar}
   * wrapper; ignored on native (there is no rail on native).
   */
  sidebar: React.ReactNode;
  /** The floating-pill bottom bar (mobile <md / native). Host-provided. */
  bottomBar: React.ReactNode;
  /**
   * The routed content element. In expo-router the host passes `<Slot/>` on web
   * (document-scroll flow) and `<Stack/>` on native (push/pop transitions).
   */
  children: React.ReactNode;
  /** Expanded rail width in px (default 255). */
  railExpandedWidth?: number;
  /** Collapsed icon-rail width in px (default 56). */
  railCollapsedWidth?: number;
}

/**
 * The shared responsive app shell — the storefront's framed "mask" layout unified
 * with the collapsible Alia rail. It owns only the layout container; the concrete
 * rail, bottom bar, and routed content are injected via slots so the shell stays
 * app-agnostic (no nav items, no router, no auth).
 *
 * - WEB: one responsive tree. Below md it is a full-bleed column with the
 *   floating-pill `bottomBar` fixed to the viewport bottom. At md+ it is a
 *   [rail | 1fr] flex row: the `sidebar` is a sticky, full-height column whose
 *   width animates between the icon rail and the expanded sidebar off the shared
 *   collapse flag, and the content flows in the document (so the body scrolls and
 *   the page's `ScreenShell` sticky mask works) with a small gutter inset
 *   (`md:p-2 md:pl-0`). Mobile bottom clearance comes from each page's
 *   `ScreenShell` (`pb-24`), not this wrapper, so the surface reaches the edge.
 * - NATIVE: a single full-bleed column with the floating-pill `bottomBar` as an
 *   absolute overlay above the routed content (the rail is web-only).
 */
export function AppShell({
  sidebar,
  bottomBar,
  children,
  railExpandedWidth = RAIL_EXPANDED_WIDTH,
  railCollapsedWidth = RAIL_COLLAPSED_WIDTH,
}: AppShellProps) {
  const { collapsed } = useSidebarCollapse();

  // WEB: the rail column width animates between the icon rail and the expanded
  // sidebar off the shared collapse flag; react-native-web animates the width,
  // no-op on native (which never renders the rail).
  const railStyle = useMemo<RailStyle>(
    () => ({
      width: collapsed ? railCollapsedWidth : railExpandedWidth,
      ...(Platform.OS === "web" ? { transition: RAIL_WIDTH_TRANSITION } : null),
    }),
    [collapsed, railCollapsedWidth, railExpandedWidth],
  );

  if (Platform.OS !== "web") {
    return (
      <View className="flex-1 bg-background">
        {children}
        {bottomBar}
      </View>
    );
  }

  return (
    <View className="min-h-screen bg-background md:flex-row">
      <View
        style={railStyle}
        className="sticky top-0 z-40 hidden h-screen shrink-0 md:flex"
      >
        {sidebar}
      </View>
      <View className="min-w-0 flex-1 md:p-2 md:pl-0">{children}</View>
      <View className="fixed inset-x-0 bottom-0 z-[60] md:hidden">{bottomBar}</View>
    </View>
  );
}
