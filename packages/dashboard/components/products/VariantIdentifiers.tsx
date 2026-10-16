import React, { useState } from 'react';
import { View } from 'react-native';
import type { ProductVariantDTO } from '@mercaria/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@mercaria/ui';
import { useUpdateVariant } from '@/lib/hooks/use-products';
import { useTranslation } from '@/lib/i18n';

type IdentifierDraft = Partial<Pick<ProductVariantDTO, 'sku' | 'barcode'>>;

/** These seller identifiers are independent strings, not canonical GTIN claims. */
export function VariantIdentifiers({
  storeId,
  productId,
  variant,
  canWrite,
}: {
  storeId: string;
  productId: string;
  variant: ProductVariantDTO;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const mutation = useUpdateVariant(storeId, productId);
  const [draft, setDraft] = useState<IdentifierDraft>({});
  const sku = draft.sku ?? variant.sku ?? '';
  const barcode = draft.barcode ?? variant.barcode ?? '';
  // Omit untouched fields so saving one identifier never overwrites another
  // editor's update to the other one. The API accepts nonempty strings only.
  const patch: IdentifierDraft = {
    ...(draft.sku !== undefined && sku.trim() !== (variant.sku ?? '') ? { sku: sku.trim() } : {}),
    ...(draft.barcode !== undefined && barcode.trim() !== (variant.barcode ?? '')
      ? { barcode: barcode.trim() }
      : {}),
  };
  const invalidSku = patch.sku === '';
  const invalidBarcode = patch.barcode === '';
  const changed = Object.keys(patch).length > 0;
  const change = (field: keyof IdentifierDraft, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    mutation.reset();
  };
  const save = () => {
    if (!canWrite || mutation.isPending || !changed || invalidSku || invalidBarcode) return;
    mutation.mutate({ variantId: variant.id, input: patch }, { onSuccess: () => setDraft({}) });
  };
  return (
    <View testID="merchant-variant-identifiers" className="gap-2 border-t border-border pt-3">
      <View className="gap-3 sm:flex-row">
        <View className="min-w-0 flex-1">
          <Field
            label={t('products.variants.identifiers.sku')}
            error={invalidSku ? t('products.variants.identifiers.cannotClear') : undefined}
          >
            <TextFieldInput
              label={t('products.variants.identifiers.sku')}
              placeholder={null}
              value={sku}
              onValueChange={(value) => change('sku', value)}
              autoCapitalize="none"
              autoCorrect={false}
              disabled={!canWrite || mutation.isPending}
            />
          </Field>
        </View>
        <View className="min-w-0 flex-1">
          <Field
            label={t('products.variants.identifiers.barcode')}
            error={invalidBarcode ? t('products.variants.identifiers.cannotClear') : undefined}
          >
            <TextFieldInput
              label={t('products.variants.identifiers.barcode')}
              placeholder={null}
              value={barcode}
              onValueChange={(value) => change('barcode', value)}
              autoCapitalize="none"
              autoCorrect={false}
              disabled={!canWrite || mutation.isPending}
            />
          </Field>
        </View>
      </View>
      {canWrite ? (
        <View className="flex-row gap-2">
          <Button
            size="sm"
            appearance="outline"
            material="flat"
            onPress={save}
            disabled={!changed || invalidSku || invalidBarcode}
            loading={mutation.isPending}
          >
            {t('common.save')}
          </Button>
          {Object.keys(draft).length > 0 ? (
            <Button
              size="sm"
              appearance="outline"
              material="flat"
              disabled={mutation.isPending}
              onPress={() => {
                setDraft({});
                mutation.reset();
              }}
            >
              {t('common.cancel')}
            </Button>
          ) : null}
        </View>
      ) : null}
      <View className="min-h-5" accessibilityLiveRegion="polite">
        {mutation.isError ? (
          <Text className="text-sm text-destructive">{t('products.variants.updateFailed')}</Text>
        ) : mutation.isSuccess ? (
          <Text className="text-sm text-muted-foreground">{t('products.variants.updated')}</Text>
        ) : null}
      </View>
    </View>
  );
}
