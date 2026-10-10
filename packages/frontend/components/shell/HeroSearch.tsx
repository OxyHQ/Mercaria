import { STOREFRONT_NAV_FROM } from "@/lib/layout";
import { CatalogImage, merchantImageSource } from "@mercaria/ui";
import { useImageResolver } from "@oxy.so/bloom/image-resolver";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { Link, type Href } from "expo-router";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { PriceDisplay, Text, type ProductSummary } from "@mercaria/ui";
import type { StoreSummary } from "@mercaria/shared-types";
import { MercariaWordmark } from "@/components/ui/mercaria-wordmark";
import { ShoppingComposer } from "./ShoppingComposer";

const CYCLE_MS = 7000;

/** Shop's public hero: 7s staggered depth transitions, 4s alternating idle,
 * pointer tilt, and a stable central search. No per-frame React state updates. */
function HeroCard({
  children,
  index,
  width,
  x,
  y,
  clock,
  pointerX,
  pointerY,
  reduced,
  href,
  label,
  onInteraction,
}: {
  children: ReactNode;
  index: number;
  width: number;
  x: number;
  y: number;
  clock: SharedValue<number>;
  pointerX: SharedValue<number>;
  pointerY: SharedValue<number>;
  reduced: boolean;
  href: Href;
  label: string;
  onInteraction: (key: string, active: boolean) => void;
}) {
  const hover = useSharedValue(1);
  useEffect(() => () => {
    for (const kind of ["hover", "focus", "press"]) onInteraction(`${index}:${kind}`, false);
  }, [index, onInteraction]);
  const style = useAnimatedStyle(() => {
    const progress = reduced
      ? 0
      : (clock.value % CYCLE_MS) / (CYCLE_MS / 2) - 1;
    const delayed = progress * (1 + (index % 4) / 25);
    const turn = Math.max(-1, Math.min(1, Math.pow(delayed, 23)));
    const opacity = Math.max(0, 1 - Math.pow(delayed, 22));
    const float = reduced
      ? 0
      : (Math.sin((clock.value * Math.PI) / 4000 + index) + 1) * width * 0.025;
    return {
      opacity,
      transform: [
        { perspective: 1000 },
        { translateX: -width / 2 - turn * width - progress * width * 0.2 },
        { translateY: -width / 2 + float },
        { rotateY: `${-turn * 90 + (reduced ? 0 : pointerX.value * 15)}deg` },
        { rotateX: `${reduced ? 0 : pointerY.value * -15}deg` },
        { scale: hover.value },
      ],
    };
  });
  return (
    <Animated.View
      style={[
        { position: "absolute", left: x, top: y, width, zIndex: 1 },
        style,
      ]}
      testID={`hero-card-${index}`}
    >
      <Link href={href} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={label}
          onHoverIn={() => {
            hover.value = withTiming(1.025, { duration: reduced ? 0 : 200 });
            onInteraction(`${index}:hover`, true);
          }}
          onHoverOut={() => {
            hover.value = withTiming(1, { duration: reduced ? 0 : 200 });
            onInteraction(`${index}:hover`, false);
          }}
          onFocus={() => onInteraction(`${index}:focus`, true)}
          onBlur={() => onInteraction(`${index}:focus`, false)}
          onPressIn={() => {
            hover.value = withTiming(0.98, { duration: reduced ? 0 : 100 });
            onInteraction(`${index}:press`, true);
          }}
          onPressOut={() => {
            hover.value = withTiming(1, { duration: reduced ? 0 : 200 });
            onInteraction(`${index}:press`, false);
          }}
          className="overflow-hidden rounded-[24px] border border-black/[0.04] bg-background web:shadow-xl"
        >
          {children}
        </Pressable>
      </Link>
    </Animated.View>
  );
}

export function HeroSearch({
  products,
  merchants,
  onVisibilityChange,
}: {
  products: ProductSummary[];
  merchants: StoreSummary[];
  onVisibilityChange: (visible: boolean) => void;
}) {
  const resolveImage = useImageResolver();
  const { width: viewport, height: windowHeight } = useWindowDimensions();
  const [width, setWidth] = useState(viewport);
  const [cycle, setCycle] = useState(0);
  const stage = useRef<View>(null);
  const search = useRef<View>(null);
  const reduced = useReducedMotion();
  const clock = useSharedValue(CYCLE_MS / 2);
  const active = useSharedValue(true);
  const paused = useSharedValue(false);
  const interactions = useRef(new Set<string>());
  const onInteraction = useCallback((key: string, engaged: boolean) => {
    if (engaged) interactions.current.add(key);
    else interactions.current.delete(key);
    paused.value = interactions.current.size > 0;
  }, [paused]);
  const pointerX = useSharedValue(0);
  const pointerY = useSharedValue(0);
  const desktop = viewport >= STOREFRONT_NAV_FROM;
  const collageHeight = desktop ? Math.min(windowHeight * 0.4, 400) : 0;
  const productWidth = desktop
    ? Math.min(viewport * 0.12, 240)
    : Math.min(width * 0.27, 132);
  useFrameCallback((frame) => {
    if (active.value && !paused.value && !reduced)
      clock.value += Math.min(frame.timeSincePreviousFrame ?? 0, 50);
  });
  useAnimatedReaction(
    () => Math.floor(clock.value / CYCLE_MS),
    (current, previous) => {
      if (previous !== null && current !== previous) runOnJS(setCycle)(current);
    },
  );
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const hero: unknown = stage.current;
    const field: unknown = search.current;
    if (!(hero instanceof HTMLElement) || !(field instanceof HTMLElement))
      return;
    let onScreen = true;
    const updateActivity = () => {
      active.value = onScreen && !document.hidden;
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === field) onVisibilityChange(entry.isIntersecting);
        if (entry.target === hero) {
          onScreen = entry.isIntersecting;
          updateActivity();
        }
      }
    });
    observer.observe(hero);
    observer.observe(field);
    document.addEventListener("visibilitychange", updateActivity);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateActivity);
    };
  }, [active, onVisibilityChange]);

  // These are the reference's circular card positions, centred on the search.
  const position = (index: number, merchant: boolean) => {
    const angle =
      (index -
        Math.PI * 0.2 -
        (merchant ? 0 : 0.8) +
        (index % 2) * Math.PI * 1.3) *
      ((2 * Math.PI) / 10);
    if (Math.sin(angle) > 0) return null;
    const offset =
      merchant && Math.cos(angle) > 0
        ? 20
        : !merchant && Math.cos(angle) < 0
          ? -50
          : 0;
    return {
      x: width * (0.5 + 0.4 * Math.cos(angle)),
      y: collageHeight * (0.65 + 0.4 * Math.sin(angle)) + offset,
    };
  };
  const current = products.length
    ? Array.from(
        { length: Math.min(4, products.length) },
        (_, index) => products[(cycle * 4 + index) % products.length],
      )
    : [];
  return (
    <View
      ref={stage}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onPointerMove={(event) => {
        if (reduced || event.nativeEvent.pointerType !== "mouse") return;
        pointerX.value = withTiming(
          (event.nativeEvent.pageX / viewport) * 2 - 1,
          { duration: 200 },
        );
        pointerY.value = withTiming(
          (event.nativeEvent.pageY / windowHeight) * 2 - 1,
          { duration: 200 },
        );
      }}
      onPointerLeave={() => {
        pointerX.value = withTiming(0);
        pointerY.value = withTiming(0);
      }}
      className="relative pb-8 md:pb-10"
      testID="home-hero"
    >
      <View
        className="relative overflow-hidden"
        style={{ height: collageHeight }}
        pointerEvents="box-none"
      >
        {desktop
          ? current.map((product, index) => {
              const coordinates = position(index, false) ?? {
                x: width * (index === 1 ? 0.4 : 0.59),
                y: collageHeight * (index === 1 ? 0.28 : 0.22),
              };
              return (
                <HeroCard
                  key={index}
                  index={index}
                  width={productWidth}
                  {...coordinates}
                  clock={clock}
                  pointerX={pointerX}
                  pointerY={pointerY}
                  reduced={reduced}
                  label={product.title}
                  onInteraction={onInteraction}
                  href={{ pathname: "/products/[id]", params: { id: product.id } }}
                >
                  <View className="gap-2 p-2 md:p-3">
                    <CatalogImage
                      fileId={product.imageFileId}
                      legacyUrl={product.imageUrl}
                      accessibilityLabel={product.title}
                      className="aspect-square w-full overflow-hidden rounded-2xl bg-muted"
                    />
                    <View className="gap-1 px-1 pb-1">
                      <Text
                        numberOfLines={1}
                        className="text-xs font-semibold text-foreground"
                      >
                        {product.title}
                      </Text>
                      <PriceDisplay
                        price={product.price}
                        primaryClassName="text-xs font-semibold"
                      />
                    </View>
                  </View>
                </HeroCard>
              );
            })
          : null}
        {desktop
          ? merchants.slice(0, 4).map((merchant, index) => {
              const coverSource = merchantImageSource(merchant.coverImageUrl, resolveImage, merchant.coverFileId);
              const logoSource = merchantImageSource(merchant.logoUrl, resolveImage, merchant.logoFileId);
              const coordinates = position(index, true);
              if (!coordinates) return null;
              return (
                <HeroCard
                  key={merchant.id}
                  index={index + 4}
                  width={Math.min(viewport * 0.09, 180)}
                  {...coordinates}
                  clock={clock}
                  pointerX={pointerX}
                  pointerY={pointerY}
                  reduced={reduced}
                  label={merchant.name}
                  onInteraction={onInteraction}
                  href={{ pathname: "/stores/[handle]", params: { handle: merchant.handle } }}
                >
                  <View
                    className="aspect-square items-center justify-center"
                    style={{ backgroundColor: merchant.brandColor }}
                  >
                    {coverSource ? (
                      <Image
                        source={coverSource}
                        className="absolute inset-0"
                        contentFit="cover"
                      />
                    ) : null}
                    {logoSource ? (
                      <Image
                        source={logoSource}
                        className="h-16 w-[75%]"
                        contentFit="contain"
                      />
                    ) : (
                      <Text
                        className="px-3 text-center text-base font-bold"
                        style={{
                          color:
                            merchant.textTone === "light" ? "white" : "black",
                        }}
                      >
                        {merchant.name}
                      </Text>
                    )}
                  </View>
                </HeroCard>
              );
            })
          : null}
      </View>
      <View
        className="items-center px-4 pt-7 lg:-mt-16 lg:pt-0"
        pointerEvents="box-none"
      >
        <View className="md:hidden" pointerEvents="none">
          <MercariaWordmark height={40} />
        </View>
        <View className="hidden md:flex" pointerEvents="none">
          <MercariaWordmark height={72} />
        </View>
        {Platform.OS === "web" ? (
          <View
            ref={search}
            className="mt-6 w-full max-w-[600px]"
            onFocus={() => onInteraction("composer", true)}
            onBlur={() => onInteraction("composer", false)}
          >
            <ShoppingComposer inline />
          </View>
        ) : null}
      </View>
    </View>
  );
}
