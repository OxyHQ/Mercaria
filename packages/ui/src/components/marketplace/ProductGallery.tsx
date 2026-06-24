import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { Text } from "../ui/text";
import { useColorScheme } from "../../lib/useColorScheme";

/** Prev/next chevron icon size (px). */
const NAV_ICON_SIZE = 18;
/** Thumbnail edge length Tailwind class. */
const THUMB_CLASS = "size-14";

/** A single gallery image: a resolvable URL and optional alt text. */
export interface ProductGalleryImage {
  /** Resolvable image URL. */
  uri: string;
  /** Optional alt text for accessibility. */
  alt?: string;
}

export interface ProductGalleryProps {
  /** Ordered gallery images. The first is shown initially. */
  images: ProductGalleryImage[];
  /** Product title — used as the fallback alt text for the main image. */
  title: string;
}

/**
 * Large PDP image gallery: a big `contain`-fit main image on a light rounded
 * surface (so the product floats as the visual anchor of the page), a thumbnail
 * rail to its right on desktop / below it on mobile, and prev/next arrows on
 * web. The component grows to fill its parent (`flex-1`) so the gallery occupies
 * roughly half the content width on desktop. Presentational — selection state is
 * internal; no data fetching.
 */
export function ProductGallery({ images, title }: ProductGalleryProps) {
  const { colors } = useColorScheme();
  const [index, setIndex] = useState(0);
  const hasMany = images.length > 1;
  const current = images[index];

  const go = (delta: number) => {
    setIndex((i) => (i + delta + images.length) % images.length);
  };

  const renderThumb = (image: ProductGalleryImage, i: number, prefix: string) => (
    <Pressable
      key={`${prefix}-${image.uri}-${i}`}
      accessibilityRole="button"
      accessibilityLabel={`View image ${i + 1}`}
      accessibilityState={{ selected: i === index }}
      onPress={() => setIndex(i)}
      className={`${THUMB_CLASS} overflow-hidden rounded-radius-12 border-[1.5px] ${
        i === index ? "border-border-input-active" : "border-border-image"
      }`}
    >
      <Image source={{ uri: image.uri }} contentFit="cover" className="size-full" />
    </Pressable>
  );

  return (
    <View className="flex-1 flex-col gap-space-16 md:sticky md:top-8">
      {/*
        Desktop: the vertical thumbnail rail is intentionally NOT rendered —
        mirroring the Shopify original, which hides it and relies on the
        prev/next arrows for desktop navigation. The mobile horizontal strip
        (below the frame) remains the touch navigation surface.
      */}
      <View className="relative flex-1">
        {/* Main image on a light rounded surface (the product floats, not cropped). */}
        <View className="relative aspect-[0.9/1] overflow-hidden rounded-radius-20 bg-bg-fill-hover web:shadow-sm">
          {current ? (
            <Image
              source={{ uri: current.uri }}
              contentFit="contain"
              style={StyleSheet.absoluteFill}
              accessibilityLabel={current.alt ?? title}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <Text className="text-bodySmall text-text-tertiary">No image</Text>
            </View>
          )}
        </View>

        {/* Prev / next arrows — web desktop only. */}
        {hasMany ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous image"
              onPress={() => go(-1)}
              className="absolute left-space-12 top-1/2 hidden items-center justify-center rounded-radius-max border-[0.5px] border-border-image bg-bg-fill p-space-10 web:-translate-y-1/2 web:shadow-md web:sm:flex"
            >
              <ChevronLeft size={NAV_ICON_SIZE} color={colors.foreground} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next image"
              onPress={() => go(1)}
              className="absolute right-space-12 top-1/2 hidden items-center justify-center rounded-radius-max border-[0.5px] border-border-image bg-bg-fill p-space-10 web:-translate-y-1/2 web:shadow-md web:sm:flex"
            >
              <ChevronRight size={NAV_ICON_SIZE} color={colors.foreground} />
            </Pressable>
          </>
        ) : null}

        {/* Native / mobile-web: horizontal thumbnail strip below the frame. */}
        {hasMany ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingTop: 16 }}
            className="md:hidden"
          >
            {images.map((image, i) => renderThumb(image, i, "h"))}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}
