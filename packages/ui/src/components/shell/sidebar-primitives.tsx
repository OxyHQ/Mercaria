import React from "react";
import { View, Pressable, Platform, type LayoutRectangle } from "react-native";
import { createPortal } from "react-dom";
import { type LucideIcon } from "lucide-react-native";
import { cn } from "../../lib/cn";
import { useColorScheme } from "../../lib/useColorScheme";
import { Text } from "../ui/text";

const IS_WEB = Platform.OS === "web";

type AnchorRect = Pick<LayoutRectangle, "x" | "y" | "width" | "height">;

/**
 * Resolve the hovered element's viewport rect from the DOM event. NativeWind 5
 * (`react-native-css`) does not resolve refs to the DOM node for className'd
 * components on web, so we measure the event's `currentTarget` directly rather
 * than a React ref — the documented escape hatch for rail hover measurement.
 */
function rectFromHover(event: { currentTarget?: unknown }): AnchorRect | null {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    const r = target.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return null;
}

export interface RailTooltipHandle {
  anchorProps: {
    onHoverIn: (event: { currentTarget?: unknown }) => void;
    onHoverOut: () => void;
  };
  tooltip: React.ReactNode;
}

/**
 * Hover tooltip for icon-rail rows. Attach `anchorProps` to the row's own
 * Pressable and render `tooltip` beside it; the bubble is portaled to
 * `document.body` with `fixed` viewport coords so no content stacking context
 * can clip it. Hover-only (web), so touch never shows it.
 */
export function useRailTooltip(label: string): RailTooltipHandle {
  const [anchor, setAnchor] = React.useState<AnchorRect | null>(null);

  const onHoverIn = React.useCallback((event: { currentTarget?: unknown }) => {
    if (!IS_WEB) return;
    setAnchor(rectFromHover(event));
  }, []);
  const onHoverOut = React.useCallback(() => setAnchor(null), []);

  const tooltip =
    IS_WEB && anchor !== null && typeof document !== "undefined"
      ? createPortal(
          // `position: fixed` and the `-50%` percentage translate are web-only CSS
          // that React Native's `ViewStyle` doesn't model, so they live in
          // NativeWind web arbitrary classes; only RN-valid numeric keys stay in
          // `style` (the documented RN-Web escape hatch, mirroring the storefront
          // NavRail tooltip).
          <View
            pointerEvents="none"
            style={{
              left: anchor.x + anchor.width + 10,
              top: anchor.y + anchor.height / 2,
              zIndex: 2147483647,
            }}
            className="web:fixed web:[transform:translateY(-50%)] rounded-lg border border-border bg-popover px-2 py-1 shadow-sm"
          >
            <Text className="text-xs text-popover-foreground" numberOfLines={1}>
              {label}
            </Text>
          </View>,
          document.body,
        )
      : null;

  return { anchorProps: { onHoverIn, onHoverOut }, tooltip };
}

export interface SidebarRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  /** Compact variant for nested rows. */
  sub?: boolean;
  /** Icon-rail variant used when the sidebar is collapsed. */
  iconOnly?: boolean;
  /** Persistent selected state (the active destination). */
  active?: boolean;
  /** Non-interactive, dimmed row (e.g. a destination not yet available). */
  disabled?: boolean;
}

/** Ghost menu row shared by every sidebar navigation entry. */
export function SidebarRow({
  icon: Icon,
  label,
  onPress,
  accessibilityLabel,
  sub = false,
  iconOnly = false,
  active = false,
  disabled = false,
}: SidebarRowProps) {
  const { colors } = useColorScheme();
  const { anchorProps, tooltip } = useRailTooltip(label);
  return (
    <>
      <Pressable
        {...(iconOnly ? anchorProps : null)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ selected: active, disabled }}
        disabled={disabled}
        onPress={onPress}
        className={cn(
          "flex-row items-center rounded-xl web:hover:bg-muted active:bg-muted",
          iconOnly ? "h-9 w-9 justify-center" : "gap-2 px-1.5 w-full",
          !iconOnly && (sub ? "h-8" : "h-9"),
          active && "bg-muted",
          disabled && "opacity-40",
        )}
      >
        <Icon size={sub ? 16 : 18} color={colors.foreground} />
        {!iconOnly && (
          <Text className={cn("text-foreground", sub ? "text-xs" : "text-sm", active && "font-medium")}>
            {label}
          </Text>
        )}
      </Pressable>
      {iconOnly && tooltip}
    </>
  );
}

export interface GhostIconButtonProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  badge?: boolean;
  /** Rail tooltip anchor from `useRailTooltip` (hover measure target). */
  anchorProps?: RailTooltipHandle["anchorProps"];
}

/** Square ghost icon button (header collapse trigger, footer expand trigger). */
export function GhostIconButton({ icon: Icon, label, onPress, badge = false, anchorProps }: GhostIconButtonProps) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      {...anchorProps}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-9 w-9 items-center justify-center rounded-xl web:hover:bg-muted active:bg-muted"
    >
      <Icon size={18} color={colors.mutedForeground} />
      {badge && (
        <View className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 border border-background" />
      )}
    </Pressable>
  );
}
