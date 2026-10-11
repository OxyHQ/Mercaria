import { Dialog } from '@oxy.so/bloom/dialog';
import { Button } from '@oxy.so/bloom/button';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, View, useWindowDimensions } from 'react-native';
import {
  ZoomableMediaGallery,
  type ZoomableMediaGalleryHandle,
} from '@oxy.so/bloom/zoomable-media-gallery';
import { useImageResolver } from '@oxy.so/bloom/image-resolver';
import { isOxyFileId, type ListingMedia, type ListingImage } from '@mercaria/shared-types';
import { Text, useSharedUiTranslation } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import { OxyProductImage } from './OxyProductImage';

/** Read-only merchant media review. Upload/reorder/delete require their own supported flows. */
export function ProductMedia({
  images,
  media: allMedia,
  title,
}: {
  images: readonly ListingImage[];
  media?: readonly ListingMedia[];
  title: string;
}) {
  const { t } = useTranslation();
  const uiT = useSharedUiTranslation();
  const { width } = useWindowDimensions();
  const resolveImage = useImageResolver();
  const [selectedVideo, setSelectedVideo] = useState<ListingMedia>();
  const entries: readonly ListingMedia[] =
    allMedia ?? images.map((image) => ({ ...image, kind: 'image' }));
  const viewer = useRef<ZoomableMediaGalleryHandle>(null);
  const size = width < 768 ? 112 : 144;
  const media = entries.flatMap((image, sourceIndex) => {
    if (image.kind === 'video') return [];
    const uri = isOxyFileId(image.fileId) ? resolveImage?.(image.fileId) : undefined;
    return uri ? [{ uri, alt: image.alt || title, sourceIndex }] : [];
  });
  if (entries.length === 0) return null;
  return (
    <View testID="merchant-product-media" className="gap-3">
      <Text className="text-sm font-semibold text-foreground">
        {allMedia ? t('products.media.title') : t('products.wizard.listing.mediaTitle')}
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {entries.map((image, index) => {
          const selected = media.findIndex((item) => item.sourceIndex === index);
          return (
            <Pressable
              key={`${image.fileId}:${index}`}
              testID="merchant-product-media-tile"
              accessibilityRole="button"
              accessibilityLabel={
                image.kind === 'video'
                  ? t('products.media.viewVideo', { position: index + 1 })
                  : uiT('ui.gallery.viewImage', { position: index + 1 })
              }
              disabled={image.kind === 'image' ? selected < 0 : !isOxyFileId(image.fileId)}
              onPress={() => {
                if (image.kind === 'video') setSelectedVideo(image);
                else viewer.current?.open(media, selected);
              }}
              className="rounded-lg active:opacity-70 web:hover:opacity-80"
            >
              <OxyProductImage
                fileId={image.fileId}
                alt={image.alt || title}
                size={size}
                thumbnailOnly={image.kind === 'video'}
              />
              {image.kind === 'video' ? (
                <Text className="text-xs text-foreground">{t('products.media.video')}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <ProductVideoDialog
        media={selectedVideo}
        title={title}
        onClose={() => setSelectedVideo(undefined)}
      />
      <ZoomableMediaGallery
        ref={viewer}
        appearance="page"
        indicatorVariant="thumbnails"
        cornerRadius={12}
        labels={{
          previous: uiT('ui.gallery.previous'),
          next: uiT('ui.gallery.next'),
          goTo: (position) => uiT('ui.gallery.viewImage', { position }),
        }}
      />
    </View>
  );
}

function ProductVideoDialog({
  media,
  title,
  onClose,
}: {
  media?: ListingMedia;
  title: string;
  onClose: () => void;
}) {
  const resolve = useImageResolver();
  const { t } = useTranslation();
  const uri = media && isOxyFileId(media.fileId) ? resolve?.(media.fileId) : undefined;
  return (
    <Dialog open={Boolean(media)} onClose={onClose} title={t('products.media.video')}>
      {uri ? (
        <ProductVideo key={uri} uri={uri} title={title} />
      ) : (
        <Text accessibilityRole="alert">{t('products.media.unavailable')}</Text>
      )}
    </Dialog>
  );
}
function ProductVideo({ uri, title }: { uri: string; title: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ProductVideoPlayer
      key={attempt}
      uri={uri}
      title={title}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
function ProductVideoPlayer({
  uri,
  title,
  onRetry,
}: {
  uri: string;
  title: string;
  onRetry: () => void;
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.muted = true;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  useFocusEffect(
    useCallback(
      () => () => {
        player.pause();
      },
      [player],
    ),
  );
  const { t } = useTranslation();
  return (
    <View className="gap-3" style={{ height: 320 }}>
      {status === 'error' ? (
        <>
          <Text accessibilityRole="alert">{t('products.media.unavailable')}</Text>
          <Button onPress={onRetry}>{t('common.retry')}</Button>
        </>
      ) : (
        <VideoView
          player={player}
          nativeControls
          contentFit="contain"
          accessibilityLabel={title}
          style={{ flex: 1 }}
          surfaceType="textureView"
        />
      )}
    </View>
  );
}
