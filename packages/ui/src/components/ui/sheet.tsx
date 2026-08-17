import * as React from "react";
import {
  Modal,
  View,
  Pressable,
  Animated,
  Platform,
  useWindowDimensions,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { cn } from "../../lib/cn";
import {
  innerEdgeBorderClassName,
  offscreenTranslateX,
  oppositeLogicalSide,
  resolvePhysicalSide,
  type LogicalSide,
} from "../../lib/logical-side";
import { useIsRtlLayout } from "../../lib/use-layout-direction";
import { Text } from "./text";

interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

const SheetContext = React.createContext<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}>({
  open: false,
});

const Sheet = ({ open, onOpenChange, children }: SheetProps) => {
  return (
    <SheetContext.Provider value={{ open: open ?? false, onOpenChange }}>
      {children}
    </SheetContext.Provider>
  );
};

const SheetTrigger = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  React.ComponentPropsWithoutRef<typeof Pressable>
>(({ onPress, ...props }, ref) => {
  const { onOpenChange } = React.useContext(SheetContext);

  return (
    <Pressable
      ref={ref}
      onPress={(e) => {
        onOpenChange?.(true);
        onPress?.(e);
      }}
      {...props}
    />
  );
});

SheetTrigger.displayName = "SheetTrigger";

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof View> {
  overlayClassName?: string;
  /**
   * Which LOGICAL edge the sheet slides in from — the leading (`start`) or
   * trailing (`end`) edge of the reading direction, so it mirrors under RTL
   * along with the rest of the layout (#429).
   */
  side?: LogicalSide;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof View>,
  SheetContentProps
>(({ className, overlayClassName, side = "end", children, ...props }, ref) => {
  const { open, onOpenChange } = React.useContext(SheetContext);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const rtl = useIsRtlLayout();

  // Responsive: full width (fixed) on mobile, flex on desktop
  const isMobile = width < 640;
  // Animation distance: full width on mobile, 400px on desktop (max-width)
  const slideDistance = isMobile ? width : 400;
  /** Where the sheet sits when closed. Collapses side, direction and distance. */
  const parkedX = offscreenTranslateX(side, rtl, slideDistance);

  // The face turned towards the content is the OPPOSITE edge to the anchor. Its
  // corner radius is logical and mirrors on its own; its divider cannot be —
  // see `../../lib/logical-side` for the RN limitation behind that.
  const innerEdge = oppositeLogicalSide(side);
  const innerRadius = innerEdge === "start" ? "rounded-s-2xl" : "rounded-e-2xl";
  const edgeBorder = innerEdgeBorderClassName(side, rtl);
  // The drop shadow is cast from that same inner face, so its x offset points
  // away from the screen edge the sheet occupies. Physical, like every shadow.
  const shadowOffsetX = resolvePhysicalSide(side, rtl) === "right" ? -2 : 2;

  const slideAnim = React.useRef(new Animated.Value(parkedX)).current;
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  // Re-park when the slide distance (window resize) OR the direction changes. A
  // web locale switch moves `parkedX` to the other sign, and a sheet left parked
  // at the old one would open from the wrong edge on its next press.
  React.useEffect(() => {
    if (!open) {
      slideAnim.setValue(parkedX);
    }
  }, [parkedX, open]);

  React.useEffect(() => {
    if (open) {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: parkedX,
          duration: 250,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    }
  }, [open, parkedX]);

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={() => onOpenChange?.(false)}
      statusBarTranslucent
    >
      {/* Full screen container */}
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
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => onOpenChange?.(false)}
          />
        </Animated.View>

        {/* Sheet Panel - Animated wrapper */}
        <Animated.View
          style={[
            styles.sheetWrapper,
            side === "start" ? { insetInlineStart: 0 } : { insetInlineEnd: 0 },
            isMobile ? { width: width } : { maxWidth: 400 },
            { transform: [{ translateX: slideAnim }] },
          ]}
        >
          {/* Inner View with NativeWind styles */}
          <View
            ref={ref}
            className={cn(
              "flex-1 bg-background",
              !isMobile && cn(edgeBorder, "border-border", innerRadius),
              className
            )}
            style={[
              { paddingTop: insets.top },
              !isMobile ? styles.sheetInner : null,
              !isMobile
                ? { boxShadow: `${shadowOffsetX}px 0px 10px rgba(0, 0, 0, 0.25)` }
                : null,
            ]}
            {...props}
          >
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
});

SheetContent.displayName = "SheetContent";

const styles = StyleSheet.create({
  sheetWrapper: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
  sheetInner: {
    // The x offset is direction-dependent and is applied beside this, per
    // render; `elevation` is Android's flat shadow and has no direction.
    elevation: 10,
  },
});

const SheetHeader = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentPropsWithoutRef<typeof View>
>(({ className, children, ...props }, ref) => {
  const { onOpenChange } = React.useContext(SheetContext);

  return (
    <View
      ref={ref}
      className={cn(
        "flex-row items-center justify-between px-4 py-3 border-b border-border",
        className
      )}
      {...props}
    >
      <View className="flex-1">{children}</View>
      <Pressable
        className="p-1 rounded-lg active:opacity-70"
        onPress={() => onOpenChange?.(false)}
      >
        <X size={20} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
});

SheetHeader.displayName = "SheetHeader";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentPropsWithoutRef<typeof Text>
>(({ className, ...props }, ref) => {
  return (
    <Text
      ref={ref}
      className={cn("text-base font-semibold text-foreground", className)}
      {...props}
    />
  );
});

SheetTitle.displayName = "SheetTitle";

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentPropsWithoutRef<typeof Text>
>(({ className, ...props }, ref) => {
  return (
    <Text
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});

SheetDescription.displayName = "SheetDescription";

const SheetFooter = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentPropsWithoutRef<typeof View>
>(({ className, ...props }, ref) => {
  return (
    <View
      ref={ref}
      className={cn("p-4 border-t border-border", className)}
      {...props}
    />
  );
});

SheetFooter.displayName = "SheetFooter";

export {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
