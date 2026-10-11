import React, { useState } from 'react';
import { View } from 'react-native';
import type { Collection, CollectionSortOrder } from '@mercaria/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
} from '@oxy.so/bloom/select';
import { Text } from '@mercaria/ui';
import { useUpdateCollection, useSetCollectionProducts } from '@/lib/hooks/use-collections';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { collectionChanges, type CollectionDraft } from '@/lib/collection-draft';
import { useTranslation } from '@/lib/i18n';
import { OxyProductImage } from '@/components/products/OxyProductImage';
import { CollectionRules } from './CollectionRules';
import { CollectionProducts } from './CollectionProducts';

const SORT_KEYS: Record<CollectionSortOrder, string> = {
  manual: 'collections.editor.sort.manual',
  best_selling: 'collections.editor.sort.bestSelling',
  price_asc: 'collections.editor.sort.priceAscending',
  price_desc: 'collections.editor.sort.priceDescending',
  created_desc: 'collections.editor.sort.newest',
  title_asc: 'collections.editor.sort.title',
};

export function CollectionEditor({
  storeId,
  collection,
  readBlocked,
}: {
  storeId: string;
  collection: Collection;
  readBlocked: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const canWrite = can('collections:write');
  const update = useUpdateCollection(storeId, collection.id);
  const products = useSetCollectionProducts(storeId, collection.id);
  const rules = useUpdateCollection(storeId, collection.id);
  const busy = update.isPending || products.isPending || rules.isPending;
  const [draft, setDraft] = useState<CollectionDraft>({});
  const title = draft.title ?? collection.title;
  const handle = draft.handle ?? collection.handle;
  const description = draft.description ?? collection.description ?? '';
  const published = draft.isPublished ?? collection.isPublished;
  const sortOrder = draft.sortOrder ?? collection.sortOrder;
  const changes = collectionChanges(collection, draft);
  const changed = Object.keys(changes).length > 0;
  const valid =
    title.trim().length > 0 &&
    title.trim().length <= 200 &&
    handle.trim().length > 0 &&
    handle.trim().length <= 120 &&
    description.length <= 5000;
  const disabled = busy || !canWrite;
  const sorts = (Object.keys(SORT_KEYS) as CollectionSortOrder[]).map((value) => ({
    value,
    label: t(SORT_KEYS[value]),
  }));
  const edit = (patch: CollectionDraft) => {
    setDraft((current) => ({ ...current, ...patch }));
    update.reset();
  };
  const save = () => {
    if (disabled || readBlocked || !changed || !valid) return;
    update.mutate(changes, { onSuccess: () => setDraft({}) });
  };
  return (
    <View className="gap-5 pb-8">
      <View
        testID="merchant-collection-editor"
        className="gap-4 rounded-xl border border-border bg-white p-4 dark:bg-surface"
      >
        <Text className="text-base font-semibold text-foreground">
          {t('collections.editor.details')}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {t(
            collection.type === 'manual' ? 'collections.type.manual' : 'collections.type.automated',
          )}
        </Text>
        {collection.imageFileId ? (
          <OxyProductImage fileId={collection.imageFileId} alt={collection.title} size={96} />
        ) : null}
        <Field
          label={t('common.title')}
          error={!title.trim() ? t('collections.create.titleRequired') : undefined}
        >
          <TextFieldInput
            label={t('common.title')}
            value={title}
            onValueChange={(value) => edit({ title: value })}
            maxLength={200}
            disabled={disabled}
          />
        </Field>
        <Field
          label={t('collections.editor.handle')}
          error={!handle.trim() ? t('collections.editor.handleRequired') : undefined}
        >
          <TextFieldInput
            label={t('collections.editor.handle')}
            value={handle}
            onValueChange={(value) => edit({ handle: value })}
            maxLength={120}
            disabled={disabled}
          />
        </Field>
        <Field label={t('common.description')}>
          <TextFieldInput
            label={t('common.description')}
            value={description}
            onValueChange={(value) => edit({ description: value })}
            maxLength={5000}
            multiline
            disabled={disabled}
          />
        </Field>
        <Checkbox
          checked={published}
          disabled={disabled}
          accessibilityLabel={t('collections.editor.published')}
          onCheckedChange={(value) => edit({ isPublished: value })}
          labelContent={
            <Text className="text-sm text-foreground">{t('collections.editor.published')}</Text>
          }
        />
        <Field label={t('collections.editor.sortLabel')}>
          <Select
            value={sortOrder}
            disabled={disabled}
            onValueChange={(value) => {
              const option = sorts.find((item) => item.value === value);
              if (option) edit({ sortOrder: option.value });
            }}
          >
            <SelectTrigger label={t('collections.editor.sortLabel')}>
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent
              label={t('collections.editor.sortLabel')}
              items={sorts}
              renderItem={(item) => (
                <SelectItem value={item.value} label={item.label}>
                  <SelectItemText>{item.label}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              )}
            />
          </Select>
        </Field>
        <View className="min-h-5" accessibilityLiveRegion="polite">
          {update.isError ? (
            <Text className="text-sm text-destructive">{t('collections.editor.saveFailed')}</Text>
          ) : update.isSuccess ? (
            <Text className="text-sm text-muted-foreground">{t('collections.editor.saved')}</Text>
          ) : null}
        </View>
        {canWrite ? (
          <View className="flex-row flex-wrap gap-2">
            <Button
              onPress={save}
              disabled={busy || readBlocked || !changed || !valid}
              loading={update.isPending}
            >
              {t('collections.editor.save')}
            </Button>
            <Button
              appearance="outline"
              material="flat"
              disabled={busy || !Object.keys(draft).length}
              onPress={() => {
                setDraft({});
                update.reset();
              }}
            >
              {t('common.cancel')}
            </Button>
          </View>
        ) : null}
      </View>
      {collection.type === 'manual' ? (
        <CollectionProducts
          storeId={storeId}
          collection={collection}
          canWrite={canWrite}
          busy={busy}
          readBlocked={readBlocked}
          mutation={products}
        />
      ) : (
        <>
          <Text className="text-sm text-muted-foreground">{t('collections.editor.automated')}</Text>
          <CollectionRules
            collection={collection}
            canWrite={canWrite}
            busy={busy}
            readBlocked={readBlocked}
            mutation={rules}
          />
          <CollectionProducts
            storeId={storeId}
            collection={collection}
            canWrite={false}
            busy={busy}
            readBlocked={readBlocked}
            mutation={products}
          />
        </>
      )}
    </View>
  );
}
