import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useOxy } from '@oxy.so/services';
import { FileUpload, type FileUploadFile } from '@oxy.so/bloom/file-upload';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@mercaria/ui';
import type { ListingImage, ListingMedia } from '@mercaria/shared-types';
import { useTranslation } from '@/lib/i18n';
import {
  PRODUCT_PHOTO_MAX_BYTES,
  validProductPhoto,
  uploadProductPhoto,
  PRODUCT_VIDEO_MAX_BYTES,
  validProductMedia,
  uploadProductMedia,
} from '@/lib/product-photo-upload';
import { ProductMedia } from './ProductMedia';

/** Uploads create store-owned Oxy files through Mercaria. Gallery edits remain
 * local until the parent saves; removing a reference never deletes a file. */
export function ProductPhotoEditor({
  storeId,
  images,
  title,
  disabled,
  onChange,
  onBusyChange,
  media,
  onMediaChange,
}: {
  storeId: string;
  images: readonly ListingImage[];
  title: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
} & (
  | {
      media: readonly ListingMedia[];
      onMediaChange: (media: ListingMedia[]) => void;
      onChange?: never;
    }
  | { media?: never; onMediaChange?: never; onChange: (ids: string[]) => void }
)) {
  const { t } = useTranslation();
  const mixed = Boolean(onMediaChange);
  const entries: readonly ListingMedia[] =
    media ?? images.map((image) => ({ ...image, kind: 'image' }));
  const copy = {
    notice: t(mixed ? 'products.media.notice' : 'products.photos.notice'),
    add: t(mixed ? 'products.media.add' : 'products.photos.add'),
    prompt: t(mixed ? 'products.media.prompt' : 'products.photos.prompt'),
    uploading: t(mixed ? 'products.media.uploading' : 'products.photos.uploading'),
    uploaded: t(mixed ? 'products.media.uploaded' : 'products.photos.uploaded'),
    invalid: t(mixed ? 'products.media.invalid' : 'products.photos.invalid'),
    failed: t(mixed ? 'products.media.failed' : 'products.photos.failed'),
  };
  const { activeSessionId } = useOxy();
  const [file, setFile] = useState<FileUploadFile | null>(null);
  const [retry, setRetry] = useState<FileUploadFile | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const current = useRef({
    images,
    entries,
    disabled,
    onChange,
    onMediaChange,
    onBusyChange,
    activeSessionId,
    storeId,
  });
  current.current = {
    images,
    entries,
    disabled,
    onChange,
    onMediaChange,
    onBusyChange,
    activeSessionId,
    storeId,
  };
  useEffect(
    () => () => {
      if (controller.current) {
        controller.current.abort();
        current.current.onBusyChange(false);
      }
    },
    [],
  );
  const change = (next: readonly ListingMedia[]) => {
    if (onMediaChange) onMediaChange(next.map((item, position) => ({ ...item, position })));
    else onChange?.(next.map((item) => item.fileId));
  };
  const upload = async (picked: FileUploadFile) => {
    if (current.current.disabled || controller.current) return;
    setError(false);
    setRetry(null);
    if (!(mixed ? validProductMedia : validProductPhoto)(picked.mimeType, picked.size)) {
      setError(true);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    const identity = current.current;
    setFile(picked);
    setProgress(0);
    identity.onBusyChange(true);
    try {
      const bytes =
        Platform.OS === 'web' && picked.raw instanceof Blob
          ? picked.raw
          : await (await fetch(picked.uri!)).blob();
      const uploaded = mixed
        ? await uploadProductMedia(
            storeId,
            bytes,
            (value) => {
              if (!abort.signal.aborted) setProgress(value);
            },
            abort.signal,
          )
        : {
            kind: 'image' as const,
            fileId: await uploadProductPhoto(
              storeId,
              bytes,
              (value) => {
                if (!abort.signal.aborted) setProgress(value);
              },
              abort.signal,
            ),
            position: 0,
          };
      if (
        abort.signal.aborted ||
        current.current.storeId !== identity.storeId ||
        current.current.activeSessionId !== identity.activeSessionId ||
        current.current.disabled
      )
        return;
      const existing = current.current.entries;
      if (!existing.some((item) => item.fileId === uploaded.fileId)) {
        const next = [...existing, { ...uploaded, position: existing.length }];
        if (current.current.onMediaChange) current.current.onMediaChange(next);
        else current.current.onChange?.(next.map((item) => item.fileId));
      }
    } catch {
      if (!abort.signal.aborted) {
        setError(true);
        setRetry(picked);
      }
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) {
        setFile(null);
        current.current.onBusyChange(false);
      }
    }
  };
  const pickNative = async (): Promise<FileUploadFile | null> => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: mixed ? ['images', 'videos'] : ['images'],
      allowsMultipleSelection: false,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    return {
      name: asset.fileName ?? 'product-image',
      size: asset.fileSize ?? 0,
      mimeType: asset.mimeType,
      uri: asset.uri,
    };
  };
  const move = (index: number, direction: number) => {
    const next = [...entries];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    change(next);
  };
  return (
    <View testID="merchant-product-photo-editor" className="gap-3">
      <ProductMedia images={images} media={media} title={title} />
      {!disabled ? (
        <>
          <Text className="text-xs text-muted-foreground">{copy.notice}</Text>
          <FileUpload
            file={file}
            progress={progress}
            disabled={Boolean(file)}
            allowedExtensions={
              mixed
                ? ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'mp4']
                : ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']
            }
            maxBytes={mixed ? PRODUCT_VIDEO_MAX_BYTES : PRODUCT_PHOTO_MAX_BYTES}
            accessibilityLabel={copy.add}
            onFileSelected={(picked) => {
              void upload(picked);
            }}
            onPickFiles={Platform.OS === 'web' ? undefined : pickNative}
            onReject={() => {
              setError(true);
              setRetry(null);
            }}
            labels={{
              prompt: copy.prompt,
              select: copy.add,
              uploading: () => copy.uploading,
              uploaded: copy.uploaded,
              unsupported: () => copy.invalid,
              tooLarge: () => copy.invalid,
            }}
          />
          {mixed ? <Text className="text-xs text-muted-foreground">{copy.invalid}</Text> : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {copy.failed}
            </Text>
          ) : null}
          {retry ? (
            <Button
              disabled={Boolean(file)}
              appearance="outline"
              onPress={() => {
                void upload(retry);
              }}
            >
              {t('common.retry')}
            </Button>
          ) : null}
          {entries.map((image, index) => (
            <View
              key={`${image.fileId}:${index}`}
              className="flex-row flex-wrap items-center gap-2"
            >
              <Text className="text-xs text-foreground">
                {t(mixed ? 'products.media.position' : 'products.photos.position', {
                  position: index + 1,
                })}
              </Text>
              <Button
                size="sm"
                appearance="outline"
                disabled={Boolean(file) || index === 0}
                onPress={() => move(index, -1)}
              >
                {t('products.variants.media.earlier')}
              </Button>
              <Button
                size="sm"
                appearance="outline"
                disabled={Boolean(file) || index === entries.length - 1}
                onPress={() => move(index, 1)}
              >
                {t('products.variants.media.later')}
              </Button>
              <Button
                size="sm"
                appearance="outline"
                disabled={Boolean(file)}
                onPress={() => change(entries.filter((_, position) => position !== index))}
              >
                {t(mixed ? 'products.media.remove' : 'products.photos.remove', {
                  position: index + 1,
                })}
              </Button>
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}
