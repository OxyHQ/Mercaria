import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Text as NativeText,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import type { ProductSummary } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { CurationImage } from "./CurationCard";
import { ProductCard } from "./ProductCard";

export interface EditorialStory {
  id: string;
  heading: string;
  body?: string;
  imageUrl?: string;
  quote?: string;
  products: ProductSummary[];
}

function Reveal({
  children,
  reduced,
  immediate = false,
  kind = "text",
}: {
  children: ReactNode;
  reduced: boolean;
  immediate?: boolean;
  kind?: "text" | "image" | "hero" | "quote";
}) {
  const ref = useRef<View>(null);
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) {
      opacity.setValue(1);
      return;
    }
    if (Platform.OS !== "web") {
      opacity.setValue(0);
      const animation = Animated.timing(opacity, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
      });
      animation.start();
      return () => animation.stop();
    }
    const element: unknown = ref.current;
    if (!(element instanceof HTMLElement)) return;
    const duration =
      kind === "hero"
        ? 1250
        : kind === "image"
          ? 800
          : kind === "quote"
            ? 1120
            : 1050;
    const words =
      kind === "quote"
        ? Array.from(
            element.querySelectorAll('[data-testid="editorial-quote-word"]'),
          )
        : [];
    const targets = words.length ? words : [element];
    const animations = targets.map((target, index) =>
      target.animate(
        [
          {
            opacity: 0,
            filter: `blur(${kind === "quote" ? 7 : 8}px)`,
            transform:
              kind === "quote"
                ? "none"
                : kind === "hero"
                  ? "scale(1.025)"
                  : `translateY(${kind === "image" ? 40 : 24}px) scale(0.995)`,
          },
          {
            opacity: 1,
            filter: "blur(0px)",
            transform: "translateY(0) scale(1)",
          },
        ],
        {
          duration: kind === "quote" ? 400 : duration,
          delay:
            kind === "quote"
              ? (index * 720) / Math.max(1, targets.length - 1)
              : kind === "image"
                ? 120
                : 0,
          easing: "cubic-bezier(0.215, 0.61, 0.355, 1)",
          fill: "backwards",
        },
      ),
    );
    if (immediate)
      return () => animations.forEach((animation) => animation.cancel());
    animations.forEach((animation) => animation.pause());
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          animations.forEach((animation) => animation.play());
          observer.disconnect();
        }
      },
      {
        rootMargin: `0px 0px -${kind === "quote" ? 30 : kind === "image" ? 26 : 12}% 0px`,
      },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      animations.forEach((animation) => animation.cancel());
    };
  }, [immediate, kind, opacity, reduced]);
  return (
    <Animated.View ref={ref} style={{ opacity }}>
      {children}
    </Animated.View>
  );
}

/** Adapts the public CourtneyGrow editorial template to the native catalogue.
 * Reference: CourtneyGrow-BuBdtCZz.js (Shop's public production bundle).
 * 1140px cover, 565px narrative, 2-column products, 64/40px rhythm;
 * desktop pinned title + 0.95 cover scale, mobile 3:4 cover with overlaid copy.
 */
export function EditorialCuration({
  title,
  subtitle,
  introduction,
  previewLabel,
  heroImageUrl,
  mobileHeroImageUrl,
  stories,
  onPressProduct,
}: {
  title: string;
  subtitle: string;
  introduction: string;
  previewLabel: string;
  heroImageUrl?: string;
  mobileHeroImageUrl?: string;
  stories: EditorialStory[];
  onPressProduct: (id: string) => void;
}) {
  const { width } = useWindowDimensions();
  const tablet = width >= 768;
  const [reduced, setReduced] = useState(
    () =>
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const main = useRef<View>(null);
  const heading = useRef<View>(null);
  const cover = useRef<View>(null);
  const content = useRef<View>(null);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web" || width < 1024 || reduced) return;
    const root: unknown = main.current,
      titleNode: unknown = heading.current,
      media: unknown = cover.current,
      body: unknown = content.current;
    if (
      !(root instanceof HTMLElement) ||
      !(titleNode instanceof HTMLElement) ||
      !(media instanceof HTMLElement) ||
      !(body instanceof HTMLElement)
    )
      return;
    let frame = 0,
      progress = 0,
      lastTime = 0;
    const animate = (time: number) => {
      const rootTop = root.getBoundingClientRect().top + window.scrollY;
      const mediaTop = media.getBoundingClientRect().top + window.scrollY;
      const target = Math.max(
        0,
        Math.min(
          1,
          (window.scrollY - rootTop) / Math.max(1, mediaTop - rootTop),
        ),
      );
      progress +=
        (target - progress) *
        (1 - Math.exp(-Math.min(64, time - (lastTime || time - 16)) / 100));
      lastTime = time;
      titleNode.style.opacity = String(1 - progress);
      titleNode.style.filter = `blur(${progress * 10}px)`;
      titleNode.style.transform = `scale(${1 - progress * 0.1})`;
      titleNode.style.transformOrigin = "center top";
      media.style.transform = `scale(${1 - progress * 0.05})`;
      media.style.transformOrigin = "center top";
      body.style.transform = `translateY(${-media.offsetHeight * 0.05 * progress}px)`;
      frame =
        Math.abs(target - progress) > 0.001
          ? requestAnimationFrame(animate)
          : 0;
    };
    const update = () => {
      if (!frame) {
        lastTime = 0;
        frame = requestAnimationFrame(animate);
      }
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      titleNode.style.opacity = "";
      titleNode.style.filter = "";
      titleNode.style.transform = "";
      media.style.transform = "";
      body.style.transform = "";
    };
  }, [reduced, width]);

  const fallback = stories.flatMap((story) => story.products)[0]?.imageUrl;
  return (
    <View
      ref={main}
      className="mx-auto w-full max-w-[1172px] pb-16 md:px-4"
      testID="editorial-curation"
    >
      <View className="relative md:pt-16" testID="curation-header">
        <View
          ref={heading}
          className={
            tablet
              ? `z-0 items-center ${reduced ? "" : "web:lg:sticky web:lg:top-[72px]"}`
              : "absolute inset-x-0 bottom-0 z-20 px-4 pb-4"
          }
          testID="editorial-heading"
        >
          <Reveal reduced={reduced} immediate>
            <View className="w-full max-w-[565px]">
              <Text
                accessibilityRole="header"
                className="mt-2 font-extrabold text-white md:text-center md:text-foreground"
                style={{
                  fontSize: tablet ? 76 : 36,
                  lineHeight: tablet ? 70 : 38,
                  letterSpacing: tablet ? -1.25 : -0.55,
                }}
              >
                {title}
              </Text>
              <Text
                className="mt-3 text-white md:text-center md:text-muted-foreground"
                style={{
                  fontSize: tablet ? 18 : 14,
                  lineHeight: tablet ? 20 : 18,
                }}
              >
                {subtitle}
              </Text>
            </View>
          </Reveal>
        </View>
        <View
          ref={cover}
          className="relative overflow-hidden bg-muted md:z-10 md:mt-16 md:rounded-[20px]"
          style={{ aspectRatio: tablet ? 16 / 9 : 3 / 4 }}
          testID="editorial-cover"
        >
          <Reveal reduced={reduced} immediate kind="hero">
            <View style={{ aspectRatio: tablet ? 16 / 9 : 3 / 4 }}>
              <CurationImage
                imageUrl={
                  tablet ? heroImageUrl : (mobileHeroImageUrl ?? heroImageUrl)
                }
                fallbackImageUrl={fallback}
              />
            </View>
          </Reveal>
          {!tablet ? (
            <LinearGradient
              colors={["transparent", "rgba(0,0,0,0.6)"]}
              className="absolute inset-0"
              pointerEvents="none"
            />
          ) : null}
        </View>
      </View>
      <View
        ref={content}
        className="relative z-10 px-4 md:px-0"
        testID="curation-products"
      >
        <Reveal reduced={reduced}>
          <View className="mx-auto mt-10 w-full max-w-[565px] lg:mt-16">
            <Text className="text-sm leading-[18px]">{introduction}</Text>
            <Text className="mt-3 text-xs text-muted-foreground">
              {previewLabel}
            </Text>
          </View>
        </Reveal>
        {stories.map((story) => (
          <View
            key={story.id}
            className="mt-10 gap-10 lg:mt-16 lg:gap-16"
            testID="editorial-story"
          >
            {story.imageUrl ? (
              <Reveal reduced={reduced} kind="image">
                <View
                  className="mx-auto w-full max-w-[565px] overflow-hidden rounded-[20px] bg-muted"
                  style={{ aspectRatio: 3 / 4 }}
                >
                  <CurationImage
                    imageUrl={story.imageUrl}
                    fallbackImageUrl={story.products[0]?.imageUrl}
                  />
                </View>
              </Reveal>
            ) : null}
            <Reveal reduced={reduced}>
              <View className="mx-auto w-full max-w-[565px]">
                <Text
                  accessibilityRole="header"
                  className="text-lg font-semibold leading-[20px]"
                >
                  {story.heading}
                </Text>
                {story.body ? (
                  <Text className="mt-2 text-sm leading-[18px]">
                    {story.body}
                  </Text>
                ) : null}
              </View>
            </Reveal>
            <Reveal reduced={reduced}>
              <View
                className="mx-auto w-full max-w-[565px] gap-4"
                testID="editorial-product-grid"
              >
                {Array.from(
                  { length: Math.ceil(story.products.length / 2) },
                  (_, row) => (
                    <View key={row} className="flex-row gap-3">
                      {[0, 1].map((column) => {
                        const product = story.products[row * 2 + column];
                        return (
                          <View key={column} className="min-w-0 flex-1">
                            {product ? (
                              <ProductCard
                                product={product}
                                onPress={onPressProduct}
                              />
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  ),
                )}
              </View>
            </Reveal>
            {story.quote ? (
              <Reveal reduced={reduced} kind="quote">
                <View className="mx-auto w-full max-w-[565px] px-4 py-6 lg:px-0">
                  <Text
                    className="text-center font-semibold"
                    style={{
                      fontSize: width >= 1024 ? 50 : 36,
                      lineHeight: width >= 1024 ? 54 : 38,
                      letterSpacing: -1,
                    }}
                  >
                    {story.quote.split(/\s+/).map((word, index) => (
                      <NativeText key={index}>
                        <NativeText testID="editorial-quote-word">
                          {word}
                        </NativeText>{" "}
                      </NativeText>
                    ))}
                  </Text>
                </View>
              </Reveal>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
