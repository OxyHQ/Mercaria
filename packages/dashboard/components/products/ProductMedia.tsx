import React, { useRef } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { ZoomableMediaGallery, type ZoomableMediaGalleryHandle } from "@oxy.so/bloom/zoomable-media-gallery";
import { useImageResolver } from "@oxy.so/bloom/image-resolver";
import { isOxyFileId, type ListingImage } from "@mercaria/shared-types";
import { Text, useSharedUiTranslation } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { OxyProductImage } from "./OxyProductImage";

/** Read-only merchant media review. Upload/reorder/delete require their own supported flows. */
export function ProductMedia({ images, title }: { images: readonly ListingImage[]; title: string }) {
  const { t } = useTranslation();
  const ui = useSharedUiTranslation();
  const { width } = useWindowDimensions();
  const resolveImage = useImageResolver();
  const viewer = useRef<ZoomableMediaGalleryHandle>(null);
  const size = width < 768 ? 112 : 144;
  const media = images.flatMap((image, sourceIndex) => {
    const uri = isOxyFileId(image.fileId) ? resolveImage?.(image.fileId) : undefined;
    return uri ? [{ uri, alt: image.alt || title, sourceIndex }] : [];
  });
  if (images.length === 0) return null;
  return <View testID="merchant-product-media" className="gap-3">
    <Text className="text-sm font-semibold text-foreground">{t("products.wizard.listing.mediaTitle")}</Text>
    <View className="flex-row flex-wrap gap-3">{images.map((image, index) => {
      const selected = media.findIndex(item => item.sourceIndex === index);
      return <Pressable key={`${image.fileId}:${index}`} testID="merchant-product-media-tile"
        accessibilityRole="button" accessibilityLabel={ui("ui.gallery.viewImage", { position: index + 1 })}
        disabled={selected < 0} onPress={() => viewer.current?.open(media, selected)}
        className="rounded-lg active:opacity-70 web:hover:opacity-80">
        <OxyProductImage fileId={image.fileId} alt={image.alt || title} size={size} />
      </Pressable>;
    })}</View>
    <ZoomableMediaGallery ref={viewer} appearance="page" indicatorVariant="thumbnails" cornerRadius={12}
      labels={{ previous: ui("ui.gallery.previous"), next: ui("ui.gallery.next"), goTo: position => ui("ui.gallery.viewImage", { position }) }} />
  </View>;
}
