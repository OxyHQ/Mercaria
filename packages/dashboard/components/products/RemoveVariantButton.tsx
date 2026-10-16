import React, { useState } from 'react';
import { View } from 'react-native';
import type { ProductVariantDTO } from '@mercaria/shared-types';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@mercaria/ui';
import { useDeleteVariant } from '@/lib/hooks/use-products';
import { useTranslation } from '@/lib/i18n';

export function RemoveVariantButton({
  storeId,
  productId,
  variant,
  canWrite,
  removable,
}: {
  storeId: string;
  productId: string;
  variant: ProductVariantDTO;
  canWrite: boolean;
  removable: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const mutation = useDeleteVariant(storeId, productId);
  const allowed = canWrite && removable;
  const remove = () => {
    if (!allowed || mutation.isPending) return;
    mutation.mutate(variant.id, { onSuccess: () => setOpen(false) });
  };
  return (
    <View className="mt-2 items-end">
      {allowed ? (
        <Button
          size="sm"
          appearance="outline"
          material="flat"
          tone="danger"
          disabled={mutation.isPending}
          onPress={() => {
            mutation.reset();
            setOpen(true);
          }}
        >
          {t('products.variants.removeVariant')}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onClose={() => {
          if (!mutation.isPending) setOpen(false);
        }}
        dismissOnBackdrop={!mutation.isPending}
        title={t('products.variants.removeVariant')}
      >
        <View testID="merchant-remove-variant" className="gap-3">
          <Text className="text-sm text-foreground">
            {t('products.variants.removeConfirmation', { variant: variant.title })}
          </Text>
          <View className="min-h-5" accessibilityLiveRegion="polite">
            {!removable ? (
              <Text className="text-sm text-muted-foreground">
                {t('products.variants.keepOneVariant')}
              </Text>
            ) : mutation.isError ? (
              <Text className="text-sm text-destructive">
                {t('products.variants.removeFailed')}
              </Text>
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
          <Button
            size="sm"
            tone="danger"
            disabled={!allowed}
            loading={mutation.isPending}
            onPress={remove}
          >
            {t('products.variants.removeVariant')}
          </Button>
        </View>
      </Dialog>
    </View>
  );
}
