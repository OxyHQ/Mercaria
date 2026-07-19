import React from "react";
import { type LucideIcon } from "lucide-react-native";
import { BaseSidebar } from "./BaseSidebar";
import { SidebarRow } from "./sidebar-primitives";

/**
 * A single destination in the shared app sidebar. Presentational-only: the
 * component never routes on its own — the host maps `onSelect` to its router
 * using `href`, keeping `@mercaria/ui` free of any routing / auth dependency.
 */
export interface AppSidebarItem {
  key: string;
  /** Accessible label / tooltip text. */
  label: string;
  icon: LucideIcon;
  /** Route this item navigates to (used by the host's `onSelect`). */
  href: string;
  /** Persistent selected state (the active destination). */
  active?: boolean;
  /** Non-interactive, dimmed row (e.g. a destination not yet available). */
  disabled?: boolean;
}

export interface AppSidebarProps {
  /** Ordered destinations to render (already permission-filtered by the host). */
  items: readonly AppSidebarItem[];
  /** Invoked when a (non-disabled) item is pressed; the host routes to `href`. */
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
