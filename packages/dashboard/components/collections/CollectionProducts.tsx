import React, { useId, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link } from 'expo-router';
import type { Collection } from '@mercaria/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Collapsible } from '@oxy.so/bloom/collapsible';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@mercaria/ui';
import { OxyProductImage } from '@/components/products/OxyProductImage';
import { ListPagination } from '@/components/lists/ResourceList';
import { useProduct, useProducts } from '@/lib/hooks/use-products';
import type { useSetCollectionProducts } from '@/lib/hooks/use-collections';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { canRetainDetailData } from '@/lib/detail-query-state';
import { useTranslation } from '@/lib/i18n';

export function CollectionProducts({
  storeId,
  collection,
  canWrite,
  busy,
  readBlocked,
  mutation,
}: {
  storeId: string;
  collection: Collection;
  canWrite: boolean;
  busy: boolean;
  readBlocked: boolean;
  mutation: ReturnType<typeof useSetCollectionProducts>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string[]>();
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [page, setPage] = useState(1);
  const panelId = useId();
  const selected = draft ?? collection.productIds;
  const pages = Math.max(1, Math.ceil(selected.length / 20));
  const currentPage = Math.min(page, pages);
  const changed =
    draft !== undefined && JSON.stringify(draft) !== JSON.stringify(collection.productIds);
  const disabled = busy || readBlocked || !canWrite;
  const update = (next: string[]) => {
    setDraft(next);
    mutation.reset();
  };
  const toggle = (id: string, checked: boolean) => {
    if (!disabled)
      update(
        checked
          ? [...selected.filter((value) => value !== id), id]
          : selected.filter((value) => value !== id),
      );
  };
  const move = (index: number, offset: number) => {
    if (disabled || collection.sortOrder !== 'manual') return;
    const next = [...selected];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    update(next);
  };
  const save = () => {
    if (disabled || !changed) return;
    mutation.mutate({ productIds: selected }, { onSuccess: () => setDraft(undefined) });
  };
  return (
    <View
      testID="merchant-collection-products"
      className="gap-3 rounded-xl border border-border bg-white p-4 dark:bg-surface"
    >
      <Text className="text-base font-semibold text-foreground">{t('nav.products')}</Text>
      <Text className="text-sm text-muted-foreground">
        {t('collections.productCount', { count: selected.length })}
      </Text>
      {selected.length === 0 ? (
        <Text className="text-sm text-muted-foreground">
          {t('collections.editor.emptyProducts')}
        </Text>
      ) : null}
      {selected.slice((currentPage - 1) * 20, currentPage * 20).map((id, offset) => {
        const index = (currentPage - 1) * 20 + offset;
        return (
          <SelectedProduct
            key={id}
            storeId={storeId}
            id={id}
            canWrite={canWrite}
            disabled={disabled}
            earlier={
              collection.sortOrder === 'manual' && index > 0 ? () => move(index, -1) : undefined
            }
            later={
              collection.sortOrder === 'manual' && index < selected.length - 1
                ? () => move(index, 1)
                : undefined
            }
            onRemove={() => toggle(id, false)}
          />
        );
      })}
      <ListPagination page={currentPage} pages={pages} busy={false} onPage={setPage} />
      {canWrite ? (
        <>
          <Button
            appearance="outline"
            material="flat"
            aria-expanded={open}
            aria-controls={panelId}
            onPress={() => {
              setHasOpened(true);
              setOpen((value) => !value);
            }}
          >
            {t('collections.editor.browse')}
          </Button>
          {hasOpened ? (
            <Collapsible
              open={open}
              nativeID={panelId}
              testID="merchant-collection-picker"
              contentClassName="gap-3"
            >
              <ProductPicker
                storeId={storeId}
                selected={selected}
                disabled={disabled}
                onToggle={toggle}
              />
            </Collapsible>
          ) : null}
          <View className="min-h-5" accessibilityLiveRegion="polite">
            {mutation.isError ? (
              <Text className="text-sm text-destructive">
                {t('collections.editor.productsFailed')}
              </Text>
            ) : mutation.isSuccess ? (
              <Text className="text-sm text-muted-foreground">
                {t('collections.editor.productsSaved')}
              </Text>
            ) : null}
          </View>
          <View className="flex-row flex-wrap gap-2">
            <Button disabled={disabled || !changed} loading={mutation.isPending} onPress={save}>
              {t('collections.editor.saveProducts')}
            </Button>
            <Button
              appearance="outline"
              material="flat"
              disabled={busy || draft === undefined}
              onPress={() => {
                setDraft(undefined);
                mutation.reset();
              }}
            >
              {t('common.cancel')}
            </Button>
          </View>
        </>
      ) : null}
    </View>
  );
}

function SelectedProduct({
  storeId,
  id,
  canWrite,
  disabled,
  earlier,
  later,
  onRemove,
}: {
  storeId: string;
  id: string;
  canWrite: boolean;
  disabled: boolean;
  earlier?: () => void;
  later?: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const query = useProduct(storeId, id);
  const product = canRetainDetailData(query.error) ? query.data : undefined;
  const name = product?.title ?? id;
  return (
    <View
      testID="merchant-collection-selected-product"
      className="gap-2 rounded-lg border border-border p-3"
    >
      {product ? (
        <Link href={{ pathname: '/products/[id]', params: { id } }} asChild>
          <Pressable
            accessibilityLabel={product.title}
            className="flex-row items-center gap-3 rounded-lg active:opacity-70"
          >
            <OxyProductImage fileId={product.images[0]?.fileId} alt={product.title} size={40} />
            <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">
              {product.title}
            </Text>
          </Pressable>
        </Link>
      ) : (
        <View className="gap-1">
          <Text className="text-sm text-muted-foreground">
            {query.isPending ? t('common.loading') : t('collections.editor.productUnavailable')}
          </Text>
          <Text className="text-xs text-muted-foreground">{id}</Text>
        </View>
      )}
      {query.isError ? (
        <Button
          size="sm"
          appearance="outline"
          material="flat"
          disabled={query.isFetching}
          onPress={() => {
            void query.refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      ) : null}
      {canWrite ? (
        <View className="flex-row flex-wrap gap-2">
          {earlier ? (
            <Button
              size="sm"
              appearance="outline"
              material="flat"
              disabled={disabled}
              accessibilityLabel={t('collections.editor.earlier', { title: name })}
              onPress={earlier}
            >
              {t('products.variants.media.earlier')}
            </Button>
          ) : null}
          {later ? (
            <Button
              size="sm"
              appearance="outline"
              material="flat"
              disabled={disabled}
              accessibilityLabel={t('collections.editor.later', { title: name })}
              onPress={later}
            >
              {t('products.variants.media.later')}
            </Button>
          ) : null}
          <Button
            size="sm"
            appearance="outline"
            material="flat"
            disabled={disabled}
            onPress={onRemove}
          >
            {t('collections.editor.remove', { title: name })}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function ProductPicker({
  storeId,
  selected,
  disabled,
  onToggle,
}: {
  storeId: string;
  selected: readonly string[];
  disabled: boolean;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebouncedValue(search.trim(), 250);
  const query = useProducts(storeId, page, debounced);
  const pending = query.isFetching || debounced !== search.trim();
  return (
    <View className="gap-3">
      <TextFieldInput
        label={t('products.searchPlaceholder')}
        value={search}
        maxLength={200}
        disabled={disabled}
        onValueChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
      />
      {pending ? (
        <Loading variant="inline" size="sm" accessibilityLabel={t('common.loading')} />
      ) : null}
      {query.isError ? (
        <View className="gap-2">
          <Text className="text-sm text-destructive">{t('products.loadFailed')}</Text>
          <Button
            size="sm"
            appearance="outline"
            material="flat"
            disabled={query.isFetching}
            onPress={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </View>
      ) : null}
      {!query.isError
        ? query.data?.data.map((product) => (
            <Checkbox
              key={product.id}
              checked={selected.includes(product.id)}
              accessibilityLabel={product.title}
              disabled={disabled || pending || query.isPlaceholderData}
              onCheckedChange={(checked) => onToggle(product.id, checked)}
              labelContent={
                <View className="flex-row items-center gap-3">
                  <OxyProductImage
                    fileId={product.images[0]?.fileId}
                    alt={product.title}
                    size={40}
                  />
                  <Text className="min-w-0 flex-1 text-sm text-foreground">{product.title}</Text>
                </View>
              }
            />
          ))
        : null}
      {!pending && !query.isError && query.data?.data.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t('resourceList.noResults')}</Text>
      ) : null}
      {query.data && !query.isError ? (
        <ListPagination
          page={query.data.pagination.page}
          pages={query.data.pagination.pages}
          busy={disabled || pending}
          onPage={setPage}
        />
      ) : null}
    </View>
  );
}
