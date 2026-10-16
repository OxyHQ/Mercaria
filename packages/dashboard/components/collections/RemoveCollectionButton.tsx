import React, { useState } from 'react';
import { View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import type { Collection } from '@mercaria/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { toast } from '@oxy.so/bloom/toast';
import { Text, toBloomIcon } from '@mercaria/ui';
import { useDeleteCollection } from '@/lib/hooks/use-collections';
import { useTranslation } from '@/lib/i18n';

export function RemoveCollectionButton({
  storeId,
  collection,
}: {
  storeId: string;
  collection: Collection;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const mutation = useDeleteCollection(storeId);
  const remove = () => {
    if (mutation.isPending) return;
    mutation.mutate(collection.id, {
      onSuccess: () => {
        setOpen(false);
        toast.success(t('collections.deleted'));
      },
    });
  };
  return (
    <>
      <Button
        size="sm"
        iconOnly
        leadingIcon={toBloomIcon(Trash2)}
        appearance="outline"
        material="flat"
        tone="danger"
        disabled={mutation.isPending}
        accessibilityLabel={t('collections.remove.action', { title: collection.title })}
        onPress={() => {
          mutation.reset();
          setOpen(true);
        }}
      />
      <Dialog
        open={open}
        onClose={() => {
          if (!mutation.isPending) setOpen(false);
        }}
        dismissOnBackdrop={!mutation.isPending}
        title={t('collections.remove.title')}
      >
        <View testID="merchant-remove-collection" className="gap-3">
          <Text className="text-sm text-foreground">
            {t('collections.remove.confirmation', { title: collection.title })}
          </Text>
          <View className="min-h-5" accessibilityLiveRegion="polite">
            {mutation.isError ? (
              <Text className="text-sm text-destructive">{t('collections.deleteError')}</Text>
            ) : null}
          </View>
          <Button
            size="sm"
            appearance="outline"
            material="flat"
            disabled={mutation.isPending}
            onPress={() => setOpen(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button size="sm" tone="danger" loading={mutation.isPending} onPress={remove}>
            {t('collections.remove.title')}
          </Button>
        </View>
      </Dialog>
    </>
  );
}
