import React from "react";
import { type LucideIcon } from "lucide-react-native";
import { BaseSidebar } from "./BaseSidebar";
import { SidebarRow } from "./sidebar-primitives";

/**
 * A single destination in the shared app sidebar. Presentational-only: the
 * component never routes on its own — the host maps `onSelect` to its router,
 * keeping `@mercaria/ui` free of any routing / auth dependency.
 *
 * It carries NO route. It used to carry `href: string`, which nothing in this
 * package ever read: it existed so a host could route off the value it had just
 * put there. That round trip is what made every host's `router.push(item.href)`
 * untyped — a `string` cannot satisfy expo-router's route union, so all three
 * apps cast it away (#330) — and this package cannot hold the typed
 * alternative, because the type lives in expo-router and the docblock above is
 * the reason not to depend on it. `key` is what a host needs: it identifies the
 * destination in that host's OWN navigation model, where the route is written
 * and checked.
 */
export interface AppSidebarItem {
  key: string;
  /** Accessible label / tooltip text. */
  label: string;
  icon: LucideIcon;
  /** Persistent selected state (the active destination). */
  active?: boolean;
  /** Non-interactive, dimmed row (e.g. a destination not yet available). */
  disabled?: boolean;
}

export interface AppSidebarProps {
  /** Ordered destinations to render (already permission-filtered by the host). */
  items: readonly AppSidebarItem[];
  /** Invoked when a (non-disabled) item is pressed; the host routes by `key`. */
  onSelect: (item: AppSidebarItem) => void;
  /** Header slot — the host puts its logo + collapse trigger here. */
  header: React.ReactNode;
  /** Footer slot — the host puts its ProfileButton / store switcher here. */
  footer: React.ReactNode;
  /** Icon-rail mode (host owns the collapse state via `useSidebarCollapse`). */
  collapsed: boolean;
  /** Rail background color class (default: bg-background). */
  backgroundColor?: string;
}

/**
 * The shared, app-agnostic sidebar rail (web md+). It renders the host's
 * destinations through {@link BaseSidebar} + {@link SidebarRow} — collapse to an
 * icon rail, hover tooltips, gradient scroll edges — while the host injects the
 * concrete destinations (`items`), the `header` (logo + collapse trigger), and
 * the `footer` (auth / store switcher) via slots. Navigation is delegated to the
 * host through `onSelect`, so this component stays free of routing and auth.
 */
export function AppSidebar({
  items,
  onSelect,
  header,
  footer,
  collapsed,
  backgroundColor = "bg-background",
}: AppSidebarProps) {
  const navigation = (
    <>
      {items.map((item) => (
        <SidebarRow
          key={item.key}
          icon={item.icon}
          label={item.label}
          active={item.active}
          disabled={item.disabled}
          iconOnly={collapsed}
          onPress={() => onSelect(item)}
        />
      ))}
    </>
  );

  return (
    <BaseSidebar
      collapsed={collapsed}
      header={header}
      navigation={navigation}
      footer={footer}
      backgroundColor={backgroundColor}
    />
  );
}
