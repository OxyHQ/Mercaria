import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Button } from "@oxy.so/bloom/button";
import { Carousel, CarouselItem } from "@oxy.so/bloom/carousel";
import {
  ZoomableMediaGallery,
  type ZoomableMediaGalleryHandle,
  type MeasuredRect,
} from "@oxy.so/bloom/zoomable-media-gallery";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { useColorScheme } from "../../lib/useColorScheme";
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
}

/** Product media uses Bloom's controlled carousel in both the page and viewer.
 * Arrows, swipe and thumbnails update the same index. Bloom owns fullscreen
 * zoom/pan and media transitions. Variant owners remount this on variant id. */
export function ProductGallery({ images, title }: ProductGalleryProps) {
  const { width, height } = useWindowDimensions();
  const { colors } = useColorScheme();
  const t = useSharedUiTranslation();
  const [index, setIndex] = useState(0);
  const viewer = useRef<ZoomableMediaGalleryHandle>(null);
  const frames = useRef<Record<number, View | null>>({});
  const [panelWidth, setPanelWidth] = useState(0);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const desktop = width >= 1024;
  const hasMany = images.length > 1;
  const activeIndex = Math.min(index, Math.max(0, images.length - 1));
  // Shop's desktop gallery reserves 84vh and centres each image at its actual
  // ratio; the photo is not stretched to fill that viewing area.
  const frameHeight = height * (desktop ? 0.84 : 0.45);
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

  const thumbnails = (vertical: boolean) => (
    <ScrollView
      horizontal={!vertical}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      style={vertical ? { width: 48, maxHeight: frameHeight, flexGrow: 0 } : { flexGrow: 0 }}
      contentContainerStyle={{ gap: 8, padding: 2 }}
      testID={vertical ? "product-thumbnails" : "product-viewer-thumbnails"}
    >
      {images.map((image, position) => (
        <Button
          key={`${image.uri}-${position}`}
          iconOnly
          appearance="plain"
          accessibilityLabel={t(GALLERY_VIEW_IMAGE_KEY, { position: position + 1 })}
          pressed={position === activeIndex}
          onPress={() => select(position)}
          style={{
            width: 44,
            height: 44,
            minHeight: 44,
            padding: 0,
            borderRadius: 8,
            overflow: "hidden",
            borderWidth: 1.5,
            borderColor: position === activeIndex ? colors.foreground : colors.border,
            backgroundColor: "#fff",
          }}
        >
          <Image source={{ uri: image.uri }} contentFit="cover" style={{ width: 41, height: 41 }} />
        </Button>
      ))}
    </ScrollView>
  );

  const gallery = () => (
    <Carousel
      accessibilityLabel={title}
      index={activeIndex}
      onIndexChange={select}
      showArrows={hasMany && desktop}
      arrowsPlacement="overlay"
      showDots={hasMany && !desktop}
      gap={0}
      previousLabel={t(GALLERY_PREVIOUS_KEY)}
      nextLabel={t(GALLERY_NEXT_KEY)}
      dotLabel={(position) => t(GALLERY_VIEW_IMAGE_KEY, { position })}
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
      className="min-w-0 lg:flex-1 lg:self-start web:lg:sticky web:lg:top-8"
      testID="product-gallery"
      onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
    >
      {images.length === 0 ? (
        <View
          style={{ height: frameHeight }}
          className="items-center justify-center rounded-radius-28 bg-bg-fill-secondary"
        >
          <Text className="text-bodySmall text-text-tertiary">{t(MARKETPLACE_NO_IMAGE_KEY)}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          {desktop && hasMany ? thumbnails(true) : null}
          {gallery()}
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
