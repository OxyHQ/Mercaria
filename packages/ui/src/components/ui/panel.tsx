import * as React from "react";
import {
  View,
  Modal,
  Pressable,
  Animated,
  useWindowDimensions,
  StyleSheet,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import {
  innerEdgeBorderClassName,
  offscreenTranslateX,
  type LogicalSide,
} from "../../lib/logical-side";
import { useIsRtlLayout } from "../../lib/use-layout-direction";

const USE_NATIVE_DRIVER = Platform.OS !== "web";

interface PanelProps {
  /** Whether the panel is open */
  open: boolean;
  /** Callback when panel should close */
  onClose: () => void;
  /**
   * Which LOGICAL side the panel appears on — the leading (`start`) or trailing
   * (`end`) edge of the reading direction, so it mirrors under RTL along with
   * the rest of the layout (#429).
   */
  side?: LogicalSide;
  /** Width of the panel on desktop */
  width?: number;
  /** Children to render inside the panel */
  children: React.ReactNode;
  /** Additional className for the panel container */
  className?: string;
}

/**
 * Panel - A responsive side panel component
 *
 * - Desktop (>=768px): Renders as part of flex layout
 * - Mobile (<768px): Renders as modal with slide animation
 *
 * The anchor is a LOGICAL inset (`insetInlineStart` / `insetInlineEnd`), which
 * RN 0.85.3 registers and react-native-web passes through as a real CSS logical
 * property, so it mirrors on its own. The two things that cannot mirror on their
 * own — the transform sign and the divider edge — come from
 * `../../lib/logical-side`, which explains why each is physical.
 */
export function Panel({
  open,
  onClose,
  side = "end",
  width = 320,
  children,
  className,
}: PanelProps) {
  const { width: screenWidth } = useWindowDimensions();
  const isLargeScreen = screenWidth >= 768;
  const insets = useSafeAreaInsets();
  const rtl = useIsRtlLayout();

  /** Where the panel sits when closed. Collapses side, direction and width. */
  const parkedX = offscreenTranslateX(side, rtl, screenWidth);
  const edgeBorder = innerEdgeBorderClassName(side, rtl);

  // Animation values for mobile
  const slideAnim = React.useRef(new Animated.Value(parkedX)).current;
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  // Re-park when the screen size OR the direction changes. A web locale switch
  // moves `parkedX` to the other sign, and a panel left parked at the old one
  // would open from the wrong edge on its next press.
  React.useEffect(() => {
    if (!open) {
      slideAnim.setValue(parkedX);
    }
  }, [parkedX, open]);

  // Animate open/close on mobile
  React.useEffect(() => {
    if (!isLargeScreen) {
      if (open) {
        Animated.parallel([
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 300,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 300,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
        ]).start();
      } else {
        Animated.parallel([
          Animated.timing(slideAnim, {
            toValue: parkedX,
            duration: 250,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
          Animated.timing(fadeAnim, {
            toValue: 0,
            duration: 250,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
        ]).start();
      }
    }
  }, [open, isLargeScreen, parkedX]);

  // Desktop: Render as part of flex layout
  if (isLargeScreen) {
    if (!open) return null;

    return (
      <View
        style={{ width, paddingTop: insets.top }}
        className={cn("bg-background", edgeBorder, "border-border", className)}
      >
        {children}
      </View>
    );
  }

  // Mobile: Render as modal with slide animation
  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={StyleSheet.absoluteFill}>
        {/* Backdrop */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              opacity: fadeAnim,
            },
          ]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        {/* Panel */}
        <Animated.View
          style={[
            styles.mobilePanel,
            side === "start" ? { insetInlineStart: 0 } : { insetInlineEnd: 0 },
            {
              width: screenWidth,
              transform: [{ translateX: slideAnim }],
            },
          ]}
        >
          <View
            className={cn("flex-1 bg-background", edgeBorder, "border-border", className)}
            style={{ paddingTop: insets.top }}
          >
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mobilePanel: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
});
