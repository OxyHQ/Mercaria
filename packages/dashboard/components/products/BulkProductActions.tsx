import React, { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { BulkProductStatus, SelectedProduct } from '@/lib/bulk-product-status';
import type { useBulkProductStatus } from '@/lib/hooks/use-bulk-product-status';

const ACTIONS: Record<BulkProductStatus, string> = {
  active: 'products.bulk.activate', draft: 'products.bulk.draft', archived: 'products.bulk.archive',
};

export function BulkProductActions({ selected, allowed, mutation, onUpdated, onClear }: {
  selected: SelectedProduct[]; allowed: boolean; mutation: ReturnType<typeof useBulkProductStatus>;
  onUpdated: (ids: string[]) => void; onClear: () => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<BulkProductStatus>();
  const pending = mutation.isPending;
  const result = mutation.data;
  const confirm = () => {
    if (!action || pending || !allowed || !selected.length) return;
    mutation.mutate({ status: action, products: selected }, { onSuccess: next => onUpdated(next.updated.map(product => product.id)) });
  };
  const close = () => { if (!pending) setAction(undefined); };
  return <>
    {selected.length || result ? <View testID="merchant-bulk-actions" className="gap-2 rounded-lg bg-muted p-3">
      <Text className="text-sm font-semibold text-foreground">{t('products.bulk.selected', { items: selected.length })}</Text>
      {allowed && selected.length ? <View className="flex-row flex-wrap gap-2">
        {(Object.keys(ACTIONS) as BulkProductStatus[]).map(status => <Button key={status} size="sm" appearance="outline" material="flat" disabled={pending}
          onPress={() => { mutation.reset(); setAction(status); }}>{t(ACTIONS[status])}</Button>)}
        <Button size="sm" appearance="outline" material="flat" disabled={pending} onPress={() => { mutation.reset(); onClear(); }}>{t('products.bulk.clear')}</Button>
      </View> : null}
      {result ? <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">{t('products.bulk.result', { updated: result.updated.length, remaining: result.remaining.length })}</Text> : null}
    </View> : null}
    <Dialog open={Boolean(action)} onClose={close} dismissOnBackdrop={!pending} title={action ? t(ACTIONS[action]) : undefined}>
      <View testID="merchant-bulk-confirmation" className="gap-4">
        <Text className="text-sm text-muted-foreground">{t('products.bulk.confirmation')}</Text>
        <Text className="text-sm font-semibold text-foreground">{t('products.bulk.selected', { items: selected.length })}</Text>
        {selected.map(product => <Text key={product.id} className="text-sm text-foreground">{product.title}</Text>)}
        {result ? <View className="gap-2" accessibilityLiveRegion="polite">
          <Text className="text-sm text-foreground">{t('products.bulk.result', { updated: result.updated.length, remaining: result.remaining.length })}</Text>
          {result.remaining.map(product => <Text key={product.id} className="text-sm text-destructive">{t(product.outcome === 'failed' ? 'products.bulk.failed' : 'products.bulk.notAttempted', { title: product.title })}</Text>)}
        </View> : null}
        <View className="flex-row flex-wrap gap-2">
          <Button appearance="outline" material="flat" disabled={pending} onPress={close}>{t(result ? 'common.done' : 'common.cancel')}</Button>
          {selected.length ? <Button disabled={pending || !allowed} loading={pending} onPress={confirm}>{t(result ? 'products.bulk.retry' : 'products.bulk.confirm')}</Button> : null}
        </View>
      </View>
    </Dialog>
  </>;
}
