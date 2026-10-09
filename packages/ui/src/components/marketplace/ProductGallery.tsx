import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Button } from "@oxy.so/bloom/button";
import { Carousel, CarouselItem, type CarouselProps } from "@oxy.so/bloom/carousel";
import { useIsRtl } from "@oxy.so/bloom/hooks";
import {
  ZoomableMediaGallery,
  type ZoomableMediaGalleryHandle,
  type MeasuredRect,
} from "@oxy.so/bloom/zoomable-media-gallery";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { useReducedMotion } from "react-native-reanimated";
import { SHOP_CAROUSEL_ARROW_CLASS_NAME } from "../../lib/shelf-carousel";
import {
  GALLERY_NEXT_KEY,
  GALLERY_PREVIOUS_KEY,
  GALLERY_VIEW_IMAGE_KEY,
  MARKETPLACE_NO_IMAGE_KEY,
} from "../../lib/marketplace-labels";

export interface ProductGalleryImage {
  uri: string;
  alt?: string;
}
export interface ProductGalleryProps {
  images: ProductGalleryImage[];
  title: string;
  ref?: Ref<ProductGalleryHandle>;
}
export interface ProductGalleryHandle {
  activeImage: ProductGalleryImage | undefined;
  measureActiveImage: () => Promise<MeasuredRect | null>;
}

/** Shop's product gallery uses the 44px outlined control with its medium shadow. */
const GALLERY_ARROW_CLASS_NAME = `${SHOP_CAROUSEL_ARROW_CLASS_NAME} h-[44px] w-[44px] p-space-12`;
const GALLERY_ARROW_BUTTON_PROPS = {
  material: "flat",
  appearance: "outline",
  tone: "neutral",
  iconSize: 20,
  className: `${GALLERY_ARROW_CLASS_NAME} shadow-shop-m`,
} satisfies NonNullable<CarouselProps["arrowButtonProps"]>;
const TABLET_ARROW_BUTTON_PROPS = {
  ...GALLERY_ARROW_BUTTON_PROPS,
  className: `${GALLERY_ARROW_CLASS_NAME} shadow-shop-s`,
};

/** Product media uses Bloom's controlled carousel in both the page and viewer.
 * Arrows, swipe and thumbnails update the same index. Bloom owns fullscreen
 * zoom/pan and media transitions. Variant owners remount this on variant id. */
export function ProductGallery({ images, title, ref }: ProductGalleryProps) {
  const { width, height } = useWindowDimensions();
  const rtl = useIsRtl();
  const t = useSharedUiTranslation();
  const [index, setIndex] = useState(0);
  const viewer = useRef<ZoomableMediaGalleryHandle>(null);
  const thumbnailRail = useRef<ScrollView>(null);
  const thumbnailOffset = useRef(0);
  const attachThumbnailRail = useCallback((rail: ScrollView | null) => {
    thumbnailRail.current = rail;
    thumbnailOffset.current = 0;
  }, []);
  const [thumbnailViewportExtent, setThumbnailViewportExtent] = useState(0);
  const reducedMotion = useReducedMotion();
  const frames = useRef<Record<number, View | null>>({});
  const [panelWidth, setPanelWidth] = useState(0);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  // The product columns start at md (768), but Shop changes from horizontal
  // thumbnails to its taller desktop gallery at lg (976).
  const desktop = width >= 976;
  const showThumbnails = width >= 768;
  const hasMany = images.length > 1;
  const activeIndex = Math.min(index, Math.max(0, images.length - 1));
  // ScrollView's horizontal offsets are negative on RTL web, physical on
  // Android and already logical on iOS. The rail tracks distance from start.
  const thumbnailScrollOffset = useCallback((offset: number) => {
    if (desktop || !rtl) return offset;
    if (Platform.OS === "web") return -offset;
    if (Platform.OS === "android") return Math.max(0, images.length * 54 - 6 - thumbnailViewportExtent) - offset;
    return offset;
  }, [desktop, rtl, images.length, thumbnailViewportExtent]);
  // Shop uses 48px thumbnails with 6px between them. Keep the selected photo
  // visible when the carousel/viewer changes it beyond the rail's viewport.
  useEffect(() => {
    if (!showThumbnails || thumbnailViewportExtent <= 0) return;
    const start = activeIndex * 54;
    const end = start + 48;
    const current = thumbnailOffset.current;
    const next = start < current ? start
      : end > current + thumbnailViewportExtent ? end - thumbnailViewportExtent
      : current;
    if (next !== current) thumbnailRail.current?.scrollTo({
      ...(desktop ? { y: next } : { x: thumbnailScrollOffset(next) }), animated: !reducedMotion,
    });
  }, [activeIndex, desktop, showThumbnails, thumbnailViewportExtent, reducedMotion, thumbnailScrollOffset]);
  // Shop's desktop gallery reserves 84vh and centres each image at its actual
  // ratio; the photo is not stretched to fill that viewing area.
  const frameHeight = desktop ? height * 0.84
    : showThumbnails ? Math.min(760, height * 0.65) : height * 0.45;
  const imageWidth = Math.max(0, (panelWidth || width) - (desktop && hasMany ? 64 : 0));
  const select = (next: number) => setIndex(next);
  const measureThumb = useCallback(
    (position: number) =>
      new Promise<MeasuredRect | null>((resolve) => {
        const frame = frames.current[position];
        if (!frame) {
          resolve(null);
          return;
        }
        frame.measureInWindow((x, y, width, height) =>
          resolve(width > 0 && height > 0 ? { x, y, width, height } : null),
        );
      }),
    [],
  );
  const openViewer = async (position: number) => {
    const rect = await measureThumb(position);
    viewer.current?.open(images, position, rect ?? undefined);
  };
  useImperativeHandle(ref, () => ({
    activeImage: images[activeIndex],
    measureActiveImage: () => measureThumb(activeIndex),
  }), [activeIndex, images, measureThumb]);

  const thumbnails = () => (
    <ScrollView
      ref={attachThumbnailRail}
      horizontal={!desktop}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      style={desktop
        ? { width: 48, maxHeight: frameHeight, flexGrow: 0 }
        : { height: 48, maxHeight: 48, minWidth: 0, flexGrow: 0 }}
      contentContainerStyle={{ gap: 6 }}
      onLayout={({ nativeEvent }) => setThumbnailViewportExtent(desktop ? nativeEvent.layout.height : nativeEvent.layout.width)}
      onScroll={({ nativeEvent }) => {
        thumbnailOffset.current = desktop ? nativeEvent.contentOffset.y : thumbnailScrollOffset(nativeEvent.contentOffset.x);
      }}
      scrollEventThrottle={16}
      testID="product-thumbnails"
    >
      {images.map((image, position) => (
        <Button
          key={`${image.uri}-${position}`}
          iconOnly
          appearance="plain"
          material="flat"
          className="group"
          accessibilityLabel={t(GALLERY_VIEW_IMAGE_KEY, { position: position + 1 })}
          pressed={position === activeIndex}
          onPress={() => select(position)}
          onFocus={() => select(position)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || (event.key === " " && event.ctrlKey && event.altKey)) {
              event.preventDefault();
              void openViewer(position);
            }
          }}
          style={{
            width: 48,
            height: 48,
            minHeight: 48,
            padding: 0,
            borderRadius: 8,
            overflow: "hidden",
            borderWidth: 0,
            backgroundColor: "#fff",
          }}
        >
          <Image source={{ uri: image.uri }} contentFit="cover" style={{ width: 48, height: 48 }} />
          <View pointerEvents="none" className="absolute inset-0 rounded-[8px] border-[0.5px] border-border-image" />
          <View pointerEvents="none" className={`absolute inset-0 rounded-[8px] border-2 web:transition-colors web:group-hover:border-foreground ${position === activeIndex ? "border-foreground" : "border-transparent"}`} />
        </Button>
      ))}
    </ScrollView>
  );

  const gallery = () => (
    <Carousel
      accessibilityLabel={title}
      index={activeIndex}
      onIndexChange={select}
      showArrows={hasMany && showThumbnails}
      arrowsPlacement="overlay"
      arrowsVisibility={desktop ? "hover" : "always"}
      arrowButtonProps={desktop ? GALLERY_ARROW_BUTTON_PROPS : TABLET_ARROW_BUTTON_PROPS}
      showDots={false}
      gap={0}
      previousLabel={t(GALLERY_PREVIOUS_KEY)}
      nextLabel={t(GALLERY_NEXT_KEY)}
      testID="product-gallery-carousel"
      style={{ minWidth: 0, flex: 1 }}
    >
      {images.map((image, position) => (
        <CarouselItem key={`${image.uri}-${position}`}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("ui.gallery.open", { title })}
            onPress={() => void openViewer(position)}
            style={{
              height: frameHeight,
              overflow: "hidden",
              borderRadius: 28,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <View
              ref={(frame) => { frames.current[position] = frame; }}
              className="md:shadow-shop-s"
              style={{
                width: Math.min(imageWidth, frameHeight * (ratios[image.uri] ?? 1)),
                height: Math.min(frameHeight, imageWidth / (ratios[image.uri] ?? 1)),
                overflow: "hidden",
                borderRadius: 28,
                backgroundColor: "#fff",
              }}
            >
              <Image
                source={{ uri: image.uri }}
                contentFit="contain"
                style={{ width: "100%", height: "100%" }}
                accessibilityLabel={image.alt ?? title}
                onLoad={({ source }) => {
                  if (source.width > 0 && source.height > 0) {
                    const ratio = source.width / source.height;
                    setRatios(current => current[image.uri] === ratio
                      ? current : { ...current, [image.uri]: ratio });
                  }
                }}
              />
            </View>
          </Pressable>
        </CarouselItem>
      ))}
    </Carousel>
  );

  return (
    <View
      className="min-w-0 md:flex-1 md:self-start web:md:sticky web:md:top-8"
      testID="product-gallery"
      onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
    >
      {images.length === 0 ? (
        <View
          style={{ height: frameHeight }}
          className="items-center justify-center rounded-radius-28 bg-bg-fill-secondary"
        >
          <Text className="text-shop-bodySmall text-text-tertiary">{t(MARKETPLACE_NO_IMAGE_KEY)}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: desktop ? "row" : "column", alignItems: desktop ? "center" : "stretch", gap: 16 }}>
          {desktop && hasMany ? thumbnails() : null}
          {gallery()}
          {!desktop && showThumbnails && hasMany ? thumbnails() : null}
        </View>
      )}
      <ZoomableMediaGallery
        ref={viewer}
        appearance="page"
        onIndexChange={setIndex}
        measureThumb={measureThumb}
        cornerRadius={28}
        indicatorVariant="thumbnails"
        labels={{
          previous: t(GALLERY_PREVIOUS_KEY),
          next: t(GALLERY_NEXT_KEY),
          goTo: (position) => t(GALLERY_VIEW_IMAGE_KEY, { position }),
        }}
      />
    </View>
  );
}
