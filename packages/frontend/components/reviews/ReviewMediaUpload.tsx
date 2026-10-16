import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { AssetUploadInput } from '@oxy.so/core';
import { useOxy, useUploadFile } from '@oxy.so/services';
import { FileUpload, type FileUploadFile } from '@oxy.so/bloom/file-upload';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@mercaria/ui';
import {
  isOxyFileId,
  reviewMediaKind,
  REVIEW_IMAGE_MIME_TYPES,
  REVIEW_VIDEO_MIME_TYPES,
  REVIEW_VIDEO_MAX_BYTES,
} from '@mercaria/shared-types';
import { useTranslation } from '@/lib/i18n';
import { reviewAttachmentFromAsset, type ReviewAttachment } from '@/lib/reviews/review-uploads';

/** Only new uploads. Selecting an existing file in Oxy's general file manager
 * currently changes its visibility, even before the caller confirms selection. */
export function ReviewMediaUpload({
  accountId,
  disabled,
  onUploaded,
  onBusyChange,
}: {
  accountId: string;
  disabled: boolean;
  onUploaded: (attachment: ReviewAttachment) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const upload = useUploadFile();
  const live = useRef(true);
  const busy = useRef(false);
  const [file, setFile] = useState<FileUploadFile | null>(null);
  const [retryFile, setRetryFile] = useState<FileUploadFile | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const startUpload = async (picked: FileUploadFile) => {
    if (!live.current || busy.current || disabled || !canUsePrivateApi || user?.id !== accountId)
      return;
    setRetryFile(null);
    if (!reviewMediaKind(picked.mimeType ?? '', picked.size)) {
      setError(t('reviews.media.invalid'));
      return;
    }
    let input: AssetUploadInput;
    if (Platform.OS === 'web' && typeof Blob !== 'undefined' && picked.raw instanceof Blob)
      input = picked.raw;
    else if (Platform.OS !== 'web' && picked.uri)
      input = { uri: picked.uri, name: picked.name, type: picked.mimeType, size: picked.size };
    else {
      setError(t('reviews.media.failed'));
      return;
    }
    busy.current = true;
    setFile(picked);
    setRetryFile(null);
    setError(undefined);
    setProgress(0);
    onBusyChange(true);
    try {
      const result = await upload.mutateAsync({
        file: input,
        visibility: 'public',
        onProgress: (value) => {
          if (live.current) setProgress(Math.max(0, Math.min(99, value)));
        },
      });
      if (!live.current) return;
      const id = (result.file ?? result.files?.[0])?.id;
      if (!isOxyFileId(id)) throw new Error('Missing uploaded file ID');
      const { file: asset } = await oxyServices.assets.get(id);
      if (!live.current) return;
      const attachment = reviewAttachmentFromAsset(asset, accountId, id, picked.name);
      if (!attachment) throw new Error('Invalid review attachment');
      onUploaded(attachment);
    } catch {
      if (live.current) {
        setError(t('reviews.media.failed'));
        setRetryFile(picked);
      }
    } finally {
      busy.current = false;
      if (live.current) {
        setFile(null);
        setProgress(0);
        onBusyChange(false);
      }
    }
  };

  const pickNativeFile = async (): Promise<FileUploadFile | null> => {
    const result = await DocumentPicker.getDocumentAsync({
      type: [...REVIEW_IMAGE_MIME_TYPES, ...REVIEW_VIDEO_MIME_TYPES],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (!live.current || result.canceled) return null;
    const asset = result.assets[0];
    return { name: asset.name, size: asset.size ?? 0, uri: asset.uri, mimeType: asset.mimeType };
  };

  return (
    <View className="gap-2" testID="review-media-upload">
      <Text className="text-xs text-muted-foreground">{t('reviews.media.publicNotice')}</Text>
      <Text className="text-xs text-muted-foreground">{t('reviews.media.invalid')}</Text>
      <FileUpload
        file={file}
        progress={progress}
        disabled={disabled || !!file}
        onFileSelected={(picked) => {
          void startUpload(picked);
        }}
        onPickFiles={Platform.OS === 'web' ? undefined : pickNativeFile}
        allowedExtensions={['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'mp4', 'webm']}
        maxBytes={REVIEW_VIDEO_MAX_BYTES}
        accessibilityLabel={t('reviews.media.add')}
        onReject={() => {
          setRetryFile(null);
          setError(t('reviews.media.invalid'));
        }}
        labels={{
          prompt: t('reviews.media.prompt'),
          select: t('reviews.media.add'),
          uploading: () => t('reviews.media.uploading'),
          uploaded: t('reviews.media.uploaded'),
          unsupported: () => t('reviews.media.invalid'),
          tooLarge: () => t('reviews.media.invalid'),
        }}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
      {retryFile && !file ? (
        <Button
          size="sm"
          appearance="outline"
          disabled={disabled}
          onPress={() => {
            void startUpload(retryFile);
          }}
        >
          {t('common.tryAgain')}
        </Button>
      ) : null}
    </View>
  );
}
