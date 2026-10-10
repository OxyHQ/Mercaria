import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "../ui/image";
import { Play } from "lucide-react-native";
import { Button } from "@oxy.so/bloom/button";
import { Carousel, CarouselItem } from "@oxy.so/bloom/carousel";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import { surfaceStyle } from "@oxy.so/bloom/shapes";
import { useImageResolver } from "@oxy.so/bloom/image-resolver";
import { useIsRtl } from "@oxy.so/bloom/hooks";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Review, ReviewMedia, ReviewMediaItem } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { ReviewCard } from "./ReviewCard";
import { ShopDetailIcon } from "./ShopDetailIcon";
import { resolveCatalogImage } from "../../lib/stored-image-url";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { useColorScheme } from "../../lib/useColorScheme";
import { REVIEW_PREVIEW_ARROW_BUTTON_PROPS, useShelfCarouselProps } from "../../lib/shelf-carousel";

/** A retry changes the image request instance, not its address or identity. */
export function ReviewMediaImage({ media, thumbnail = false, label }: {
  media: ReviewMedia; thumbnail?: boolean; label: string;
}) {
  const resolver = useImageResolver();
  const uri = resolveCatalogImage(media.fileId, undefined, resolver, thumbnail ? "thumb" : undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const t = useSharedUiTranslation();
  useEffect(() => { setFailed(false); setAttempt(0); }, [uri]);
  if (!uri || failed) return (
    <View className="flex-1 items-center justify-center gap-space-8 bg-bg-fill-secondary p-space-8">
      {!thumbnail ? <>
        <Text accessibilityRole="alert" className="text-shop-bodySmall text-text-tertiary">{t("ui.reviewMedia.unavailable")}</Text>
        {uri ? <Button material="flat" onPress={() => { setFailed(false); setAttempt(value => value + 1); }}>{t("ui.reviewMedia.retry")}</Button> : null}
      </> : null}
    </View>
  );
  return <Image key={attempt} source={{ uri }} accessibilityLabel={label}
    contentFit={thumbnail ? "cover" : "contain"} style={StyleSheet.absoluteFill}
    onError={() => setFailed(true)} />;
}

export function ReviewMediaStrip({ items, onSelect }: {
  items: ReviewMediaItem[]; onSelect: (mediaId: string) => void;
}) {
  const t = useSharedUiTranslation();
  const shelf = useShelfCarouselProps();
  if (!items.length) return null;
  return <Carousel {...shelf} gap={8} inset={0} showDots={false} accessibilityLabel={t("ui.reviewMedia.title")}
    arrowsPlacement="overlay" arrowsVisibility="hover" arrowButtonProps={REVIEW_PREVIEW_ARROW_BUTTON_PROPS}
    testID="review-media-strip">
    {items.slice(0, 10).map(({ media }, index) => {
      const label = t(media.kind === "video" ? "ui.reviewMedia.viewVideo" : "ui.reviewMedia.viewImage", { position: index + 1 });
      return <CarouselItem key={media.id} width={60}>
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => onSelect(media.id)}
          className="relative h-[60px] overflow-hidden rounded-radius-12 border-[0.5px] border-border-image bg-bg-fill-secondary active:scale-[0.98] motion-reduce:active:scale-100">
          <ReviewMediaImage media={media} thumbnail label={label} />
          {media.kind === "video" ? <View pointerEvents="none" className="absolute inset-0 items-center justify-center"><Play size={20} color="#ffffff" fill="#ffffff" /></View> : null}
        </Pressable>
      </CarouselItem>;
    })}
  </Carousel>;
}

export interface ReviewMediaViewerProps {
  items: ReviewMediaItem[];
  selectedId: string;
  onSelect: (mediaId: string) => void;
  onClose: () => void;
  scopeLabel: string;
  /** The app owns players and the data query, the shared UI owns presentation. */
  renderVideo: (media: ReviewMedia, active: boolean) => ReactNode;
  renderReviewActions?: (review: Review) => ReactNode;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadError?: boolean;
  onLoadMore?: () => void;
}

/** Shop's viewer: 68px vertical rail + fitted media + associated review on
 * desktop, full-height scrollable media/review stack and 44px rail on mobile.
 * Bloom owns focus trapping, Escape/backdrop dismissal, reduced motion and paging. */
export function ReviewMediaViewer({ items, selectedId, onSelect, onClose, scopeLabel,
  renderVideo, renderReviewActions, hasMore, loadingMore, loadError, onLoadMore }: ReviewMediaViewerProps) {
  const { width, height } = useWindowDimensions();
  const wide = width >= 976;
  const rtl = useIsRtl();
  const t = useSharedUiTranslation();
  const { colors, isDarkColorScheme } = useColorScheme();
  const backgroundColor = isDarkColorScheme ? "#121212" : "#ffffff";
  const control = useDialogControl();
  const safeArea = useSafeAreaInsets();
  const rail = useRef<ScrollView>(null);
  const [railWidth, setRailWidth] = useState(0);
  const [railContentWidth, setRailContentWidth] = useState(0);
  const index = items.findIndex(item => item.media.id === selectedId);
  const selected = items[index];
  const thumbSize = wide ? 68 : 44;
  const panelWidth = wide ? Math.max(900, Math.min(1200, width - (width >= 1280 ? 240 : 120), height * 1.56410256 - 187.692308)) : width;
  const panelHeight = wide ? panelWidth * 741 / 1159 : height;
  const mediaHeight = wide ? panelHeight - 48 - 44 : width >= 768 ? 720 : Math.min(height * 0.6573, 492);
  useEffect(() => { control.open(); }, [control]);
  useEffect(() => {
    if (!selected) control.close();
  }, [selected, control]);
  useEffect(() => {
    if (index < 0) return;
    if (wide) {
      rail.current?.scrollTo({ y: Math.max(0, index * (thumbSize + 8) - 80), animated: false });
      return;
    }
    if (railWidth <= 0 || railContentWidth <= 0) return;
    const maxOffset = Math.max(0, railContentWidth - railWidth);
    const fromStart = Math.min(maxOffset, Math.max(0, 16 + index * (thumbSize + 8) - (railWidth - thumbSize) / 2));
    // Web uses negative RTL offsets, Android physical offsets from the left,
    // and iOS logical offsets from the start. Keep the same selected media ID.
    const x = !rtl ? fromStart : Platform.OS === "web" ? -fromStart
      : Platform.OS === "android" ? maxOffset - fromStart : fromStart;
    rail.current?.scrollTo({ x, animated: false });
  }, [index, wide, thumbSize, rtl, railWidth, railContentWidth]);
  const thumbnails = <ScrollView ref={rail} horizontal={!wide} showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}
    style={wide ? { width: 68, flexGrow: 0 } : { height: 44, flexGrow: 0 }}
    onLayout={({ nativeEvent }) => setRailWidth(nativeEvent.layout.width)}
    onContentSizeChange={setRailContentWidth}
    contentContainerStyle={{ gap: 8, paddingHorizontal: wide ? 0 : 16 }} testID="review-media-thumbnails">
    {items.map(({ media }, position) => {
      const label = t(media.kind === "video" ? "ui.reviewMedia.viewVideo" : "ui.reviewMedia.viewImage", { position: position + 1 });
      return <Pressable key={media.id} accessibilityRole="button" accessibilityLabel={label}
        accessibilityState={{ selected: position === index }} aria-pressed={position === index} onPress={() => onSelect(media.id)}
        style={{ width: thumbSize, height: thumbSize }}
        className={`overflow-hidden ${wide ? "rounded-radius-16" : "rounded-radius-12"} border-2 ${position === index ? "border-text" : "border-transparent"}`}>
        <ReviewMediaImage media={media} thumbnail label={label} />
        {media.kind === "video" ? <View pointerEvents="none" className="absolute inset-0 items-center justify-center"><Play size={16} color="#ffffff" fill="#ffffff" /></View> : null}
      </Pressable>;
    })}
  </ScrollView>;
  const details = selected ? <View className="gap-space-16" testID="review-media-associated-review">
    <ReviewCard review={selected.review} expanded embedded scopeLabel={scopeLabel} footerActions={renderReviewActions?.(selected.review)} />
    {hasMore || loadError ? <Button material="flat" onPress={onLoadMore} loading={loadingMore}>
      {t(loadError ? "ui.reviewMedia.retry" : "ui.reviewMedia.more")}
    </Button> : null}
  </View> : null;
  return <Dialog control={control} onClose={onClose} label={t("ui.reviewMedia.title")}
    placement={wide ? "center" : "end"} width={width} maxWidth={panelWidth} maxHeightRatio={1} minSideGutter={0}
    inset={{ top: 0, bottom: 0, left: 0, right: 0 }} contentPadding={0} scrollable={false} material="flat"
    backdrop={{ blurIntensity: 0, dimOpacity: 0.4 }}
    style={wide ? { ...surfaceStyle({ curve: "round", radius: 40 }), width: panelWidth, height: panelHeight, backgroundColor, borderWidth: 0 } : undefined}
    panelStyle={!wide ? { ...surfaceStyle({ curve: "round", radius: 0 }), backgroundColor, borderWidth: 0 } : undefined}
    testID="review-media-viewer">
    <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1,
      padding: wide ? 24 : 0, paddingTop: wide ? 24 : Platform.OS === "web" ? 0 : safeArea.top,
      paddingBottom: wide ? 24 : Platform.OS === "web" ? 16 : safeArea.bottom + 16 }}>
      <View className="flex-row justify-end" style={{ height: wide ? 44 : 64, padding: wide ? 0 : 16 }}>
        <Button iconOnly size="lg" material="flat" appearance="outline" onPress={() => control.close()}
          accessibilityLabel={t("ui.sheet.close")} className="size-space-44 rounded-radius-max border-[0.5px] border-border-image bg-bg-fill shadow-shop-s"
          icon={<ShopDetailIcon name="cross" size={20} color={colors.foreground} />} />
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: wide ? 20 : 16, minHeight: 0, flex: wide ? 1 : undefined }}>
        {wide ? thumbnails : null}
        <View style={{ flex: wide ? 1 : undefined, minWidth: 0, height: mediaHeight }} testID="review-media-stage">
          <Carousel index={Math.max(0, index)} onIndexChange={position => { const item = items[position]; if (item) onSelect(item.media.id); }}
            gap={0} inset={0} showDots={false} showArrows={items.length > 1} arrowsPlacement="overlay" hideUnavailableArrows
            previousLabel={t("ui.carousel.previous")} nextLabel={t("ui.carousel.next")} accessibilityLabel={t("ui.reviewMedia.title")}
            arrowButtonProps={REVIEW_PREVIEW_ARROW_BUTTON_PROPS}>
            {items.map(({ media }, position) => <CarouselItem key={media.id}>
              <View style={{ height: mediaHeight }}>
                {media.kind === "video" ? renderVideo(media, position === index)
                  : <ReviewMediaImage media={media} label={t("ui.reviewMedia.viewImage", { position: position + 1 })} />}
              </View>
            </CarouselItem>)}
          </Carousel>
        </View>
        {!wide ? thumbnails : null}
        {wide ? <ScrollView style={{ width: width >= 1280 ? 360 : 320, flexGrow: 0 }} showsVerticalScrollIndicator={false}>{details}</ScrollView>
          : <View className="px-space-16">{details}</View>}
      </View>
    </ScrollView>
  </Dialog>;
}
