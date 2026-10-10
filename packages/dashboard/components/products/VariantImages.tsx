import React, { useId, useState } from "react";
import { View } from "react-native";
import { isOxyFileId, type ListingImage, type ProductVariantDTO } from "@mercaria/shared-types";
import { Button } from "@oxy.so/bloom/button";
import { Checkbox } from "@oxy.so/bloom/checkbox";
import { Collapsible } from "@oxy.so/bloom/collapsible";
import { Loading } from "@oxy.so/bloom/loading";
import { Text, useSharedUiTranslation } from "@mercaria/ui";
import { useVariantImages, useReplaceVariantImages } from "@/lib/hooks/use-products";
import { useTranslation } from "@/lib/i18n";
import { OxyProductImage } from "./OxyProductImage";

/** Select from the product's existing Oxy gallery; this is not an upload channel. */
export function VariantImages({ storeId, productId, variant, gallery, canWrite }: {
  storeId: string; productId: string; variant: ProductVariantDTO; gallery: readonly ListingImage[]; canWrite: boolean;
}) {
  const { t } = useTranslation();
  const uiT = useSharedUiTranslation();
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const panelId = useId();
  const [draft, setDraft] = useState<readonly string[]>();
  const query = useVariantImages(storeId, productId, variant.id, canWrite && open);
  const mutation = useReplaceVariantImages(storeId, productId, variant.id);
  const selected = draft ?? query.data?.map(image => image.fileId) ?? [];
  const choices = gallery.filter((image, index) => isOxyFileId(image.fileId) && gallery.findIndex(candidate => candidate.fileId === image.fileId) === index);
  const invalid = selected.some(id => !choices.some(image => image.fileId === id)) || selected.length > 100;
  const ready = query.data !== undefined && !query.isFetching && !query.isError;
  const disabled = !ready || mutation.isPending || !canWrite;
  const changed = draft !== undefined && JSON.stringify(selected) !== JSON.stringify(query.data?.map(image => image.fileId));
  // Chosen photographs lead in their saved/draft order. Unchosen files retain
  // gallery order; moving a selection never reorders the product gallery.
  const ordered = [...selected.flatMap(id => choices.find(image => image.fileId === id) ?? []), ...choices.filter(image => !selected.includes(image.fileId))];
  const update = (next: readonly string[]) => { setDraft(next); mutation.reset(); };
  const move = (index: number, offset: number) => {
    const next = [...selected]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; update(next);
  };
  const save = () => {
    if (disabled || !changed || invalid) return;
    mutation.mutate(selected, { onSuccess: () => { setDraft(undefined); setOpen(false); } });
  };
  return <View testID="merchant-variant-images" className="mb-3 gap-2">
    {variant.images ? <View className="flex-row items-center gap-2">
      <OxyProductImage fileId={variant.images.images[0]?.fileId} alt={variant.title} size={48} />
      <Text className="min-w-0 flex-1 text-xs text-muted-foreground">{variant.images.source === "listing_fallback" ? t("products.variants.media.fallback") : t("products.variants.media.selected", { count: variant.images.images.length })}</Text>
    </View> : null}
    {canWrite ? <Button size="sm" appearance="outline" material="flat" aria-expanded={open} aria-controls={panelId}
      onPress={() => { setHasOpened(true); setOpen(value => !value); }}>{t("products.variants.media.manage")}</Button> : null}
    {canWrite && hasOpened ? <Collapsible open={open} nativeID={panelId} testID="merchant-variant-image-picker" contentClassName="gap-3 rounded-lg border border-border p-3">
      <View className="min-h-6" accessibilityLiveRegion="polite">
        {query.isFetching ? <Loading variant="inline" size="sm" accessibilityLabel={t("common.loading")} />
          : query.isError ? <Text className="text-sm text-destructive">{t("products.variants.media.loadFailed")}</Text>
          : mutation.isError ? <Text className="text-sm text-destructive">{t("products.variants.media.saveFailed")}</Text>
          : invalid ? <Text className="text-sm text-destructive">{t("products.variants.media.unavailable")}</Text> : null}
      </View>
      {query.isError ? <Button size="sm" appearance="outline" material="flat" disabled={query.isFetching} onPress={() => { void query.refetch(); }}>{t("common.retry")}</Button> : null}
      {ready && selected.length === 0 ? <Text className="text-sm text-muted-foreground">{t("products.variants.media.fallback")}</Text> : null}
      {choices.length === 0 ? <Text className="text-sm text-muted-foreground">{t("products.variants.media.empty")}</Text> : null}
      {ordered.map(image => {
        const position = selected.indexOf(image.fileId);
        const label = image.alt || uiT("ui.gallery.viewImage", { position: gallery.indexOf(image) + 1 });
        return <View key={image.fileId} testID="merchant-variant-image-choice" className="gap-2 rounded-lg border border-border p-2">
          <Checkbox checked={position >= 0} accessibilityLabel={label} disabled={disabled || (position < 0 && selected.length >= 100)}
            onCheckedChange={checked => update(checked ? [...selected, image.fileId] : selected.filter(id => id !== image.fileId))}
            labelContent={<View className="flex-row items-center gap-2"><OxyProductImage fileId={image.fileId} alt={label} size={48} /><Text className="min-w-0 flex-1 text-sm text-foreground">{label}</Text></View>} />
          {position >= 0 ? <View className="flex-row flex-wrap gap-2">
            <Button size="sm" appearance="outline" material="flat" disabled={disabled || position === 0} onPress={() => move(position, -1)}>{t("products.variants.media.earlier")}</Button>
            <Button size="sm" appearance="outline" material="flat" disabled={disabled || position === selected.length - 1} onPress={() => move(position, 1)}>{t("products.variants.media.later")}</Button>
          </View> : null}
        </View>;
      })}
      <Button size="sm" appearance="outline" material="flat" disabled={disabled || selected.length === 0} onPress={() => update([])}>{t("products.variants.media.useGallery")}</Button>
      <View className="flex-row flex-wrap gap-2">
        <Button size="sm" onPress={save} disabled={disabled || !changed || invalid} loading={mutation.isPending}>{t("common.save")}</Button>
        <Button size="sm" appearance="outline" material="flat" disabled={mutation.isPending} onPress={() => { setDraft(undefined); setOpen(false); mutation.reset(); }}>{t("common.cancel")}</Button>
      </View>
    </Collapsible> : null}
  </View>;
}
