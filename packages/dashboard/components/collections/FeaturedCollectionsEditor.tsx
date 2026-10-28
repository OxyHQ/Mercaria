import { useState } from 'react';
import { isAxiosError } from 'axios';
import { View } from 'react-native';
import { MAX_FEATURED_COLLECTIONS, type Collection } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { useFeaturedCollections, useSetFeaturedCollections } from '@/lib/hooks/use-collections';
import { addFeaturedCollection, moveFeaturedCollection } from '@/lib/featured-collections';
import { canRetainDetailData } from '@/lib/detail-query-state';
import { useTranslation } from '@/lib/i18n';

export function FeaturedCollectionsEditor({
  storeId,
  collections,
}: {
  storeId: string;
  collections: Collection[];
}) {
  const { t } = useTranslation();
  const query = useFeaturedCollections(storeId);
  const save = useSetFeaturedCollections(storeId);
  const [draft, setDraft] = useState<string[] | null>(null);
  const accessRevoked =
    isAxiosError(save.error) && [401, 403].includes(save.error.response?.status ?? 0);
  const selection = !accessRevoked && canRetainDetailData(query.error) ? query.data : undefined;
  const ids = draft ?? selection?.collectionIds ?? [];
  const busy = save.isPending;
  const options = collections
    .filter(
      (collection) =>
        collection.storeId === storeId &&
        collection.type === 'manual' &&
        collection.isPublished &&
        !ids.includes(collection.id),
    )
    .map((collection) => ({ value: collection.id, label: collection.title }));
  const editable = Boolean(selection);
  const dirty =
    Boolean(selection) && JSON.stringify(ids) !== JSON.stringify(selection?.collectionIds);
  return (
    <View className="mb-4 gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
        {t('collections.featured.title')}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('collections.featured.help', { count: MAX_FEATURED_COLLECTIONS })}
      </Text>
      {query.isPending ? <Text>{t('common.loading')}</Text> : null}
      {query.isError ? (
        <View accessibilityLiveRegion="polite" className="gap-2">
          <Text className="text-destructive">{t('collections.loadError')}</Text>
          <Button
            disabled={query.isFetching || busy}
            onPress={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </View>
      ) : null}
      {selection ? (
        <>
          {ids.length === 0 ? (
            <Text className="text-sm text-muted-foreground">{t('collections.featured.empty')}</Text>
          ) : null}
          {ids.map((id, index) => {
            const collection = collections.find((item) => item.id === id);
            const title = collection?.title ?? t('collections.featured.unavailable');
            return (
              <View key={id} className="gap-2 rounded-xl border border-border p-3">
                <Text className="text-sm font-semibold text-foreground">{title}</Text>
                {!collection?.isPublished || collection.type !== 'manual' ? (
                  <Text className="text-sm text-muted-foreground">
                    {t('collections.featured.hidden')}
                  </Text>
                ) : null}
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !editable || index === 0}
                    onPress={() => setDraft(moveFeaturedCollection(ids, id, -1))}
                  >
                    {t('collections.editor.earlier', { title })}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !editable || index === ids.length - 1}
                    onPress={() => setDraft(moveFeaturedCollection(ids, id, 1))}
                  >
                    {t('collections.editor.later', { title })}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !editable}
                    onPress={() => setDraft(ids.filter((item) => item !== id))}
                  >
                    {t('collections.editor.remove', { title })}
                  </Button>
                </View>
              </View>
            );
          })}
          <Select
            value=""
            disabled={
              busy || !editable || ids.length >= MAX_FEATURED_COLLECTIONS || options.length === 0
            }
            onValueChange={(id) => {
              const collection = collections.find((item) => item.id === id);
              if (collection) setDraft(addFeaturedCollection(ids, collection, storeId));
            }}
          >
            <SelectTrigger label={t('collections.featured.add')}>
              <SelectValue placeholder={t('collections.featured.add')} />
            </SelectTrigger>
            <SelectContent
              items={options}
              renderItem={(option) => (
                <SelectItem value={option.value} label={option.label}>
                  <SelectItemText>{option.label}</SelectItemText>
                </SelectItem>
              )}
            />
          </Select>
          <View className="flex-row gap-2">
            <Button
              disabled={!dirty || !editable || busy}
              onPress={() =>
                save.mutate({ collectionIds: ids }, { onSuccess: () => setDraft(null) })
              }
            >
              {t('common.save')}
            </Button>
            <Button
              disabled={!dirty || busy}
              onPress={() => {
                setDraft(null);
                save.reset();
              }}
            >
              {t('common.cancel')}
            </Button>
          </View>
        </>
      ) : null}
      {save.isError ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">
          {t('collections.featured.failed')}
        </Text>
      ) : null}
      {save.isSuccess && !dirty ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
          {t('collections.featured.saved')}
        </Text>
      ) : null}
    </View>
  );
}
