import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useOxy } from '@oxy.so/services';
import { FileUpload, type FileUploadFile } from '@oxy.so/bloom/file-upload';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@mercaria/ui';
import type { ListingImage } from '@mercaria/shared-types';
import { useTranslation } from '@/lib/i18n';
import { PRODUCT_PHOTO_MAX_BYTES, validProductPhoto, uploadProductPhoto } from '@/lib/product-photo-upload';
import { ProductMedia } from './ProductMedia';

/** Uploads create store-owned Oxy files through Mercaria. Gallery edits remain
 * local until the parent saves; removing a reference never deletes a file. */
export function ProductPhotoEditor({ storeId, images, title, disabled, onChange, onBusyChange }: {
  storeId: string; images: readonly ListingImage[]; title: string; disabled: boolean;
  onChange: (ids: string[]) => void; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { activeSessionId } = useOxy();
  const [file, setFile] = useState<FileUploadFile | null>(null);
  const [retry, setRetry] = useState<FileUploadFile | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const current = useRef({ images, disabled, onChange, onBusyChange, activeSessionId, storeId });
  current.current = { images, disabled, onChange, onBusyChange, activeSessionId, storeId };
  useEffect(() => () => { if (controller.current) { controller.current.abort(); current.current.onBusyChange(false); } }, []);
  const ids = images.map(image => image.fileId);
  const upload = async (picked: FileUploadFile) => {
    if (current.current.disabled || controller.current) return;
    setError(false); setRetry(null);
    if (!validProductPhoto(picked.mimeType, picked.size)) { setError(true); return; }
    const abort = new AbortController(); controller.current = abort;
    const identity = current.current;
    setFile(picked); setProgress(0); identity.onBusyChange(true);
    try {
      const bytes = Platform.OS === 'web' && picked.raw instanceof Blob ? picked.raw : await (await fetch(picked.uri!)).blob();
      const id = await uploadProductPhoto(storeId, bytes, value => { if (!abort.signal.aborted) setProgress(value); }, abort.signal);
      if (abort.signal.aborted || current.current.storeId !== identity.storeId || current.current.activeSessionId !== identity.activeSessionId || current.current.disabled) return;
      const existing = current.current.images.map(image => image.fileId);
      current.current.onChange([...new Set([...existing, id])]);
    } catch {
      if (!abort.signal.aborted) { setError(true); setRetry(picked); }
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) { setFile(null); current.current.onBusyChange(false); }
    }
  };
  const pickNative = async (): Promise<FileUploadFile | null> => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false });
    if (result.canceled) return null;
    const asset = result.assets[0];
    return { name: asset.fileName ?? 'product-image', size: asset.fileSize ?? 0, mimeType: asset.mimeType, uri: asset.uri };
  };
  const move = (index: number, direction: number) => {
    const next = [...ids]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onChange(next);
  };
  return <View testID="merchant-product-photo-editor" className="gap-3">
    <ProductMedia images={images} title={title} />
    {!disabled ? <>
      <Text className="text-xs text-muted-foreground">{t('products.photos.notice')}</Text>
      <FileUpload file={file} progress={progress} disabled={Boolean(file)}
        allowedExtensions={['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']} maxBytes={PRODUCT_PHOTO_MAX_BYTES}
        accessibilityLabel={t('products.photos.add')} onFileSelected={picked => { void upload(picked); }}
        onPickFiles={Platform.OS === 'web' ? undefined : pickNative}
        onReject={() => { setError(true); setRetry(null); }} labels={{ prompt: t('products.photos.prompt'), select: t('products.photos.add'),
          uploading: () => t('products.photos.uploading'), uploaded: t('products.photos.uploaded'), unsupported: () => t('products.photos.invalid'), tooLarge: () => t('products.photos.invalid') }} />
      {error ? <Text accessibilityRole="alert" className="text-sm text-destructive">{t('products.photos.failed')}</Text> : null}
      {retry ? <Button disabled={Boolean(file)} appearance="outline" onPress={() => { void upload(retry); }}>{t('common.retry')}</Button> : null}
      {images.map((image, index) => <View key={`${image.fileId}:${index}`} className="flex-row flex-wrap items-center gap-2">
        <Text className="text-xs text-foreground">{t('products.photos.position', { position: index + 1 })}</Text>
        <Button size="sm" appearance="outline" disabled={Boolean(file) || index === 0} onPress={() => move(index, -1)}>{t('products.variants.media.earlier')}</Button>
        <Button size="sm" appearance="outline" disabled={Boolean(file) || index === images.length - 1} onPress={() => move(index, 1)}>{t('products.variants.media.later')}</Button>
        <Button size="sm" appearance="outline" disabled={Boolean(file)} onPress={() => onChange(ids.filter((_, position) => position !== index))}>{t('products.photos.remove', { position: index + 1 })}</Button>
      </View>)}
    </> : null}
  </View>;
}
