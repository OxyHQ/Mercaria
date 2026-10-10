import React, { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Box as SkeletonBox } from '@oxy.so/bloom/skeleton';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';

/** Preserve mounted content (including unsaved edits) when its background read fails. */
export function DetailContent({
  hasData,
  pending,
  fetching,
  error,
  errorTitle,
  onRetry,
  testID,
  children,
}: {
  hasData: boolean;
  pending: boolean;
  fetching: boolean;
  error: boolean;
  errorTitle: string;
  onRetry: () => void;
  testID: string;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [height, setHeight] = useState(560);
  return (
    <View testID={testID}>
      <View className="min-h-16 justify-center pb-3" accessibilityLiveRegion="polite">
        {error && hasData ? (
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="text-sm text-foreground">{errorTitle}</Text>
            <Button
              size="sm"
              appearance="outline"
              material="flat"
              disabled={fetching}
              onPress={onRetry}
            >
              {t('common.retry')}
            </Button>
          </View>
        ) : fetching ? (
          <Loading variant="inline" size="sm" accessibilityLabel={t('common.loading')} />
        ) : null}
      </View>
      <View
        style={{ minHeight: fetching ? height : 560 }}
        onLayout={(event) => {
          if (hasData && !fetching) setHeight(Math.max(560, event.nativeEvent.layout.height));
        }}
      >
        {hasData ? (
          children
        ) : pending || fetching ? (
          <View
            testID="merchant-detail-skeleton"
            className="gap-4"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <SkeletonBox width="100%" height={200} borderRadius={12} />
            <SkeletonBox width="100%" height={144} borderRadius={12} />
            <SkeletonBox width="100%" height={144} borderRadius={12} />
          </View>
        ) : (
          <View className="min-h-[560px] rounded-xl border border-border bg-white dark:bg-surface">
            <EmptyState
              title={errorTitle}
              description={t('common.pleaseTryAgain')}
              action={{ label: t('common.retry'), onPress: onRetry }}
            />
          </View>
        )}
      </View>
    </View>
  );
}
