import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useColorScheme } from "../../lib/useColorScheme";

export interface CartFlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Target = () => View | null;
interface Flight {
  id: number;
  uri: string;
  source: CartFlightRect;
  target: CartFlightRect;
}
interface CartFlightContextValue {
  arrivals: number;
  registerTarget: (target: Target) => () => void;
  flyToCart: (uri: string, source: CartFlightRect) => Promise<void>;
}
const CartFlightContext = createContext<CartFlightContextValue>({
  arrivals: 0,
  registerTarget: () => () => {},
  flyToCart: async () => {},
});

export function useCartFlight() {
  return useContext(CartFlightContext);
}

function measure(view: View | null): Promise<CartFlightRect | null> {
  return new Promise((resolve) => {
    if (!view) {
      resolve(null);
      return;
    }
    view.measureInWindow((x, y, width, height) =>
      resolve(width > 0 && height > 0 ? { x, y, width, height } : null),
    );
  });
}

/** Register the actual glyph, including whichever responsive navigation is visible. */
export function CartFlightTarget({ children }: { children: ReactNode }) {
  const ref = useRef<View>(null);
  const { registerTarget, arrivals } = useCartFlight();
  const reduced = useReducedMotion();
  const previousArrival = useRef(arrivals);
  const scale = useSharedValue(1);
  useEffect(() => registerTarget(() => ref.current), [registerTarget]);
  useEffect(() => {
    if (previousArrival.current === arrivals) return;
    previousArrival.current = arrivals;
    if (reduced) return;
    const config = {
      duration: 200,
      easing: Easing.bezier(0.34, 1.56, 0.64, 1),
    };
    scale.value = withSequence(withTiming(1.3, config), withTiming(1, config));
  }, [arrivals, reduced, scale]);
  useEffect(() => () => cancelAnimation(scale), [scale]);
  const bounce = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return (
    <Animated.View
      ref={ref}
      testID="cart-flight-target"
      collapsable={false}
      className="relative items-center justify-center"
      style={bounce}
    >
      {children}
    </Animated.View>
  );
}

/** Marketplace feedback stays outside Bloom's layout and navigation internals. */
export function CartFlightProvider({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const targets = useRef(new Set<Target>());
  const nextId = useRef(0);
  const mounted = useRef(true);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [arrivals, setArrivals] = useState(0);
  const arrive = useCallback(() => setArrivals((current) => current + 1), []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const registerTarget = useCallback((target: Target) => {
    targets.current.add(target);
    return () => {
      targets.current.delete(target);
    };
  }, []);
  const flyToCart = useCallback(
    async (uri: string, source: CartFlightRect) => {
      if (reduced || !uri) return;
      const measured = await Promise.all(
        [...targets.current].map((target) => measure(target())),
      );
      const target = measured.find(
        (rect) =>
          rect &&
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.x + rect.width <= width &&
          rect.y + rect.height <= height,
      );
      if (!target || !mounted.current) return;
      const id = ++nextId.current;
      setFlights((current) => [...current, { id, uri, source, target }]);
    },
    [height, reduced, width],
  );
  const remove = useCallback(
    (id: number) =>
      setFlights((current) => current.filter((flight) => flight.id !== id)),
    [],
  );
  const value = useMemo(
    () => ({ registerTarget, flyToCart, arrivals }),
    [registerTarget, flyToCart, arrivals],
  );
  return (
    <CartFlightContext.Provider value={value}>
      <View style={{ flex: 1 }}>
        {children}
        {/* Measurements are physical window coordinates, including in RTL. */}
        <View
          pointerEvents="none"
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="absolute inset-0 web:fixed"
          style={{ zIndex: 9999, direction: "ltr" }}
        >
          {flights.map((flight) => (
            <FlyingProduct
              key={flight.id}
              flight={flight}
              onDone={remove}
              onArrive={arrive}
            />
          ))}
        </View>
      </View>
    </CartFlightContext.Provider>
  );
}

type Phase =
  | "initial"
  | "appear"
  | "hold"
  | "fly"
  | "dropPause"
  | "drop"
  | "fade";
const SIZE = 150;
// Timings and curves from Shop's public FlyToCartProvider: appear, hold, fly,
// pause above the glyph, drop into it, then fade. The server mutation owns success.
function FlyingProduct({
  flight,
  onDone,
  onArrive,
}: {
  flight: Flight;
  onDone: (id: number) => void;
  onArrive: () => void;
}) {
  const { colors } = useColorScheme();
  const [phase, setPhase] = useState<Phase>("initial");
  const startX = flight.source.x + flight.source.width / 2 - SIZE / 2;
  const startY = flight.source.y + flight.source.height / 2 - SIZE / 2;
  const endX = flight.target.x + flight.target.width / 2 - SIZE / 2;
  const aboveY = flight.target.y - SIZE / 2;
  const endY = flight.target.y + flight.target.height / 2 - SIZE / 2;
  const x = useSharedValue(startX);
  const y = useSharedValue(startY);
  const scale = useSharedValue(0.5);
  const opacity = useSharedValue(0);
  useEffect(() => {
    let duration: number;
    let next: Phase | undefined;
    if (phase === "initial") {
      duration = 3000;
    } else if (phase === "appear") {
      scale.value = withTiming(1, {
        duration: 350,
        easing: Easing.bezier(0.34, 1.56, 0.64, 1),
      });
      opacity.value = withTiming(1, {
        duration: 140,
        easing: Easing.out(Easing.ease),
      });
      duration = 350;
      next = "hold";
    } else if (phase === "hold") {
      duration = 200;
      next = "fly";
    } else if (phase === "fly") {
      x.value = withTiming(endX, {
        duration: 440,
        easing: Easing.bezier(0.6, 0, 0.15, 1),
      });
      y.value = withTiming(aboveY, {
        duration: 340,
        easing:
          aboveY > startY
            ? Easing.bezier(0, 0.6, 0.3, 1)
            : Easing.bezier(0.1, -0.6, 0.3, 1),
      });
      scale.value = withTiming(0.2, {
        duration: 400,
        easing: Easing.bezier(0.45, 0, 0.15, 1),
      });
      duration = 400;
      next = "dropPause";
    } else if (phase === "dropPause") {
      x.value = endX;
      duration = 15;
      next = "drop";
    } else if (phase === "drop") {
      const config = { duration: 180, easing: Easing.bezier(0.4, 0, 1, 1) };
      y.value = withTiming(endY, config);
      scale.value = withTiming(0.1, config);
      opacity.value = withTiming(0.3, {
        duration: 180,
        easing: Easing.in(Easing.ease),
      });
      duration = 180;
      next = "fade";
    } else {
      onArrive();
      opacity.value = withTiming(0, {
        duration: 200,
        easing: Easing.in(Easing.ease),
      });
      duration = 200;
    }
    const timer = setTimeout(
      () => (next ? setPhase(next) : onDone(flight.id)),
      duration,
    );
    return () => clearTimeout(timer);
  }, [
    aboveY,
    endX,
    endY,
    flight.id,
    onDone,
    onArrive,
    opacity,
    phase,
    scale,
    startY,
    x,
    y,
  ]);
  useEffect(
    () => () => {
      [x, y, scale, opacity].forEach(cancelAnimation);
    },
    [opacity, scale, x, y],
  );
  const motion = useAnimatedStyle(() => ({
    left: x.value,
    top: y.value,
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  return (
    <Animated.View
      testID="cart-flight"
      className="shadow-shop-m"
      style={[
        {
          position: "absolute",
          width: SIZE,
          height: SIZE,
          borderRadius: 20,
        },
        motion,
      ]}
    >
      <Image
        source={{ uri: flight.uri }}
        contentFit="cover"
        accessible={false}
        onLoad={() =>
          setPhase((current) => (current === "initial" ? "appear" : current))
        }
        onError={() => onDone(flight.id)}
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: 20,
          borderWidth: 0.5,
          borderColor: colors.border,
          backgroundColor: colors.card,
        }}
      />
    </Animated.View>
  );
}
