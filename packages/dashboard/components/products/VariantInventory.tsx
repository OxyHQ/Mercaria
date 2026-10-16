import React, { useId, useState } from 'react';
import { View } from 'react-native';
import type { InventoryLevelDTO } from '@mercaria/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Collapsible } from '@oxy.so/bloom/collapsible';
import { Field } from '@oxy.so/bloom/field';
import { Loading } from '@oxy.so/bloom/loading';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@mercaria/ui';
import { useVariantLevels, useSetVariantLevelInventory } from '@/lib/hooks/use-products';
import { canRetainDetailData } from '@/lib/detail-query-state';
import { parseInventoryQuantity } from '@/lib/inventory-quantity';
import { useTranslation } from '@/lib/i18n';

/** The rollup is read-only. An absolute edit must name the location it changes. */
export function VariantInventory({
  storeId,
  productId,
  variantId,
  available,
  canWrite,
}: {
  storeId: string;
  productId: string;
  variantId: string;
  available: number;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const query = useVariantLevels(storeId, productId, variantId, open);
  const mutation = useSetVariantLevelInventory(storeId, productId);
  const levels = canRetainDetailData(query.error) ? query.data : undefined;
  const save = (level: InventoryLevelDTO, quantity: number, onSaved: () => void) => {
    if (!canWrite || mutation.isPending || query.isFetching || query.isError) return;
    mutation.mutate(
      { variantId, locationId: level.locationId, available: quantity },
      {
        onSuccess: onSaved,
      },
    );
  };
  return (
    <View testID="merchant-variant-inventory" className="mt-3 gap-3 border-t border-border pt-3">
      <Text className="text-sm text-muted-foreground">
        {t('products.variants.inventory.total', { quantity: available })}
      </Text>
      <Button
        size="sm"
        appearance="outline"
        material="flat"
        aria-expanded={open}
        aria-controls={panelId}
        onPress={() => setOpen((value) => !value)}
      >
        {t('products.variants.inventory.manage')}
      </Button>
      <Collapsible
        open={open}
        nativeID={panelId}
        testID="merchant-inventory-panel"
        contentClassName="min-h-24 gap-2"
      >
        <View className="min-h-7 justify-center" accessibilityLiveRegion="polite">
          {query.isFetching || mutation.isPending ? (
            <Loading variant="inline" size="sm" accessibilityLabel={t('common.loading')} />
          ) : mutation.isError ? (
            <Text className="text-sm text-destructive">
              {t('products.variants.inventoryUpdateFailed')}
            </Text>
          ) : mutation.isSuccess ? (
            <Text className="text-sm text-muted-foreground">
              {t('products.variants.inventoryUpdated')}
            </Text>
          ) : null}
        </View>
        {query.isError ? (
          <View className="gap-2">
            <Text className="text-sm text-muted-foreground">
              {t('products.variants.inventory.loadFailed')}
            </Text>
            <Button
              size="sm"
              appearance="outline"
              material="flat"
              onPress={() => {
                void query.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </View>
        ) : null}
        {levels?.map((level) => (
          <InventoryLevelRow
            key={level.locationId}
            level={level}
            canWrite={canWrite}
            disabled={mutation.isPending || query.isFetching || query.isError}
            isSaving={mutation.isPending}
            onSave={save}
          />
        ))}
        {levels?.length === 0 && !query.isFetching && !query.isError ? (
          <Text className="text-sm text-muted-foreground">
            {t('products.variants.inventory.empty')}
          </Text>
        ) : null}
      </Collapsible>
    </View>
  );
}

function InventoryLevelRow({
  level,
  canWrite,
  disabled,
  isSaving,
  onSave,
}: {
  level: InventoryLevelDTO;
  canWrite: boolean;
  disabled: boolean;
  isSaving: boolean;
  onSave: (level: InventoryLevelDTO, quantity: number, onSaved: () => void) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>();
  const value = draft ?? String(level.available);
  const parsed = parseInventoryQuantity(value);
  return (
    <View testID="merchant-inventory-level" className="gap-2 rounded-lg border border-border p-3">
      <Text className="text-sm font-semibold text-foreground">{level.locationName}</Text>
      <View className="flex-row items-end gap-2">
        <View className="min-w-0 flex-1">
          <Field
            label={t('products.variants.available')}
            error={parsed === null ? t('products.variants.inventory.invalid') : undefined}
          >
            <TextFieldInput
              label={t('products.variants.available')}
              placeholder={null}
              value={value}
              onValueChange={setDraft}
              disabled={!canWrite || disabled}
              keyboardType="number-pad"
            />
          </Field>
        </View>
        {canWrite ? (
          <Button
            appearance="outline"
            material="flat"
            size="sm"
            disabled={disabled || parsed === null || parsed === level.available}
            onPress={() => {
              if (parsed !== null) onSave(level, parsed, () => setDraft(undefined));
            }}
          >
            {t('products.variants.set')}
          </Button>
        ) : null}
      </View>
      {canWrite && draft !== undefined ? (
        <Button
          appearance="outline"
          material="flat"
          size="sm"
          disabled={isSaving}
          onPress={() => setDraft(undefined)}
        >
          {t('common.cancel')}
        </Button>
      ) : null}
    </View>
  );
}
