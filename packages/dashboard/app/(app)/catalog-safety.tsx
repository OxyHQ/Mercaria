import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Text, useFormatters, conditionLabelKey } from '@mercaria/ui';
import type { CatalogSafetyReviewDecision } from '@mercaria/shared-types';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { useTranslation } from '@/lib/i18n';
import { catalogSafetyCandidates, saveCatalogSafetyReview } from '@/lib/api/catalog-safety';

export default function CatalogSafetyScreen() {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const { user } = useOxy();
  const [cursor, setCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const candidates = useQuery({
    queryKey: ['catalog-safety', user?.id, cursor],
    queryFn: () => catalogSafetyCandidates(cursor),
    enabled: !!user?.id,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const current = candidates.data?.items.find(
    (item) => ('unavailableReason' in item ? item.listingId : item.listing.id) === selectedId,
  );
  const save = useMutation({
    mutationFn: (decision: CatalogSafetyReviewDecision) => {
      if (!current || 'unavailableReason' in current)
        throw new Error(t('catalogSafety.unavailable'));
      return saveCatalogSafetyReview(current.listing.id, current.listing.reviewDigest, decision);
    },
    onSuccess: () => candidates.refetch(),
  });
  return (
    <Screen title={t('catalogSafety.title')} subtitle={t('catalogSafety.intro')}>
      {candidates.isPending ? (
        <ScreenLoading />
      ) : candidates.isError ? (
        <ScreenMessage
          title={t('catalogSafety.accessDenied')}
          body={t('catalogSafety.accessBody')}
        />
      ) : (
        <View className="gap-6 md:flex-row">
          <View className="gap-2 md:w-72">
            {candidates.data.items.map((item) => {
              const id = 'unavailableReason' in item ? item.listingId : item.listing.id;
              return (
                <Button
                  key={id}
                  tone="neutral"
                  appearance={selectedId === id ? 'outline' : 'plain'}
                  onPress={() => {
                    setSelectedId(id);
                    save.reset();
                  }}
                >
                  {'unavailableReason' in item
                    ? t('catalogSafety.unavailable')
                    : item.listing.title}
                </Button>
              );
            })}
            {candidates.data.items.length === 0 ? <Text>{t('catalogSafety.empty')}</Text> : null}
            {candidates.data.nextCursor ? (
              <Button
                tone="neutral"
                appearance="plain"
                onPress={() => {
                  setCursor(candidates.data.nextCursor ?? undefined);
                  setSelectedId(undefined);
                }}
              >
                {t('catalogSafety.next')}
              </Button>
            ) : null}
          </View>
          <View className="flex-1 gap-4">
            {!current ? (
              <ScreenMessage title={t('catalogSafety.select')} />
            ) : 'unavailableReason' in current ? (
              <ScreenMessage
                title={t('catalogSafety.unavailable')}
                body={t('catalogSafety.limitBody')}
              />
            ) : (
              <>
                <Text className="text-xl font-semibold">{current.listing.title}</Text>
                <Text className="text-sm text-muted-foreground">
                  {current.reviewCurrent && current.latestDecision === 'allow'
                    ? t('catalogSafety.allowed')
                    : t('catalogSafety.pending')}
                </Text>
                <Text>{current.description}</Text>
                <Text>{t(conditionLabelKey(current.condition))}</Text>
                {current.conditionDetails.map((detail) =>
                  detail.note ? (
                    <Text key={`${detail.kind}:${detail.note}`}>{detail.note}</Text>
                  ) : null,
                )}
                {current.options.map((option) => (
                  <Text key={option.name}>
                    {option.name}: {option.values.join(', ')}
                  </Text>
                ))}
                {current.listing.variants.map((variant) => (
                  <View key={variant.id} className="gap-1 border-b border-border pb-3">
                    <Text className="font-medium">{variant.title}</Text>
                    {variant.options.map((option) => (
                      <Text key={option.name}>
                        {option.name}: {option.value}
                      </Text>
                    ))}
                    {variant.price ? <Text>{formatMoney(variant.price)}</Text> : null}
                  </View>
                ))}
                <Text className="text-sm text-muted-foreground">{t('catalogSafety.textOnly')}</Text>
                {save.isError ? (
                  <Text accessibilityRole="alert">{t('catalogSafety.saveError')}</Text>
                ) : null}
                {save.isSuccess ? (
                  <Text accessibilityLiveRegion="polite">{t('catalogSafety.saved')}</Text>
                ) : null}
                <View className="flex-row flex-wrap gap-3">
                  <Button disabled={save.isPending} onPress={() => save.mutate('allow')}>
                    {t('catalogSafety.allow')}
                  </Button>
                  <Button
                    tone="neutral"
                    appearance="outline"
                    disabled={save.isPending}
                    onPress={() => save.mutate('withhold')}
                  >
                    {t('catalogSafety.withhold')}
                  </Button>
                </View>
              </>
            )}
          </View>
        </View>
      )}
    </Screen>
  );
}
