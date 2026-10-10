import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useIsRtl } from "@oxy.so/bloom/hooks";
import { useDialogFrame } from "@oxy.so/bloom/dialog";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withClamp,
  withTiming,
} from "react-native-reanimated";

export type StoreMenuDirection = "initial" | "forward" | "backward";

function IncomingPage({ children, direction, width }: {
  children: ReactNode;
  direction: StoreMenuDirection;
  width: number;
}) {
  const rtl = useIsRtl();
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(reducedMotion ? 1 : 0);
  // Shop's pushIn/popIn travel 40% of the page, not of the viewport.
  const offset = direction === "initial" ? 0 : width * 0.4
    * (direction === "forward" ? 1 : -1) * (rtl ? -1 : 1);
  useEffect(() => {
    progress.value = reducedMotion ? 1 : withClamp({ min: 0, max: 1 }, withTiming(1, {
      duration: direction === "initial" ? 150 : 300,
      easing: direction === "initial"
        ? Easing.bezier(0.42, 0, 0.58, 1)
        : Easing.bezier(0.32, 0.72, 0, 1),
    }));
  }, [direction, progress, reducedMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * offset }],
  }));
  return (
    <Animated.View testID="store-menu-page" style={[{ flex: 1 }, style]}>
      {children}
    </Animated.View>
  );
}

/** Only the incoming page moves; Bloom retains the dialog and its focus scope. */
export function StoreMenuTransition({ children, page, direction }: {
  children: ReactNode;
  page: string;
  direction: StoreMenuDirection;
}) {
  const [width, setWidth] = useState(0);
  useDialogFrame({ key: page });
  return (
    <View style={{ flex: 1, overflow: "hidden" }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      <IncomingPage key={page} direction={direction} width={width}>
        {children}
      </IncomingPage>
    </View>
  );
}
