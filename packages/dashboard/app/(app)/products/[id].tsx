import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { Boxes } from "lucide-react-native";
import { partitionPinnedFields } from "@mercaria/shared-types";
import type {
  Listing,
  ProductVariantDTO,
  SellerSettableListingStatus,
  UpdateListingInput,
} from "@mercaria/shared-types";
import {
  Text,
  ConnectorPinNotice,
  PriceDisplay,
  SourceBadge,
  useColorScheme,
} from "@mercaria/ui";
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from "@oxy.so/bloom/segmented-control";
import { Button } from "@oxy.so/bloom/button";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Textarea } from "@oxy.so/bloom/textarea";
import { toast } from "@oxy.so/bloom/toast";
import { Screen } from "@/components/shell/Screen";
import { canRetainDetailData } from "@/lib/detail-query-state";
import { ProductOrganization, type ProductOrganizationValue } from "@/components/products/ProductOrganization";
import { VariantInventory } from "@/components/products/VariantInventory";
import { VariantImages } from "@/components/products/VariantImages";
import { VariantIdentifiers } from "@/components/products/VariantIdentifiers";
import { VariantPrice } from "@/components/products/VariantPrice";
import { RemoveVariantButton } from "@/components/products/RemoveVariantButton";
import { CreateVariantForm } from "@/components/products/CreateVariantForm";
import { ProductPhotoEditor } from "@/components/products/ProductPhotoEditor";
import { DetailContent } from "@/components/shell/DetailContent";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  useProduct,
  useUpdateProduct,
  useArchiveProduct,
  useReleaseProductPins,
} from "@/lib/hooks/use-products";
import { useConnection } from "@/lib/hooks/use-channels";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { useTranslation } from "@/lib/i18n";

const STATUSES: SellerSettableListingStatus[] = ["draft", "active", "archived"];

/**
 * Translation KEYS per seller-settable status, not sentences (#398) — this module
 * is evaluated at import, before the locale store has rehydrated, so a resolved
 * label would freeze whatever language loaded first. The picker resolves
 * `t(STATUS_LABEL_KEYS[status])`.
 */
const STATUS_LABEL_KEYS: Record<SellerSettableListingStatus, string> = {
  draft: "products.status.draft",
  active: "products.status.active",
  sold: "products.status.sold",
  archived: "products.status.archived",
};

/**
 * A listing a moderation decision has restricted.
 *
 * `restricted` is not in `SellerSettableListingStatus` — the API refuses to set
 * it or to move a listing out of it — so the picker is disabled rather than
 * offering an action that always 409s. The merchant is told the state exists and
 * that it is not theirs to change; the reason is deliberately NOT shown here,
 * because the allegation and the reporter belong to an appeals surface with a
 * human in it, not to a product form.
 */
function isRestricted(listing: Listing): boolean {
  return listing.status === "restricted";
}

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("products.detail.documentTitle")}</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <ProductDetailBody key={`${storeId}:${id}`} storeId={storeId} productId={String(id)} />}
      </RequireStore>
    </>
  );
}

function ProductDetailBody({ storeId, productId }: { storeId: string; productId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { data: cached, error, isPending, isFetching, isError, refetch } = useProduct(storeId, productId);
  const data = canRetainDetailData(error) ? cached : undefined;
  return <Screen title={data?.title ?? t("products.detail.title")}
    subtitle={data ? t("products.detail.variantCount", { count: data.variants.length }) : t(isError ? "common.pleaseTryAgain" : "common.loading")}
    action={<Button appearance="outline" material="flat" onPress={() => router.replace("/products")}>{t("common.back")}</Button>}>
    <DetailContent testID="merchant-product-detail" hasData={Boolean(data)} pending={isPending} fetching={isFetching}
      error={isError} errorTitle={t("products.detail.loadFailed")} onRetry={() => { void refetch(); }}>
      {data ? <ProductEditor key={`${storeId}:${data.id}`} storeId={storeId} product={data} /> : null}
    </DetailContent>
  </Screen>;
}

function ProductEditor({ storeId, product }: { storeId: string; product: Listing }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const canWrite = can("products:write");

  const updateProduct = useUpdateProduct(storeId, product.id);
  const archiveProduct = useArchiveProduct(storeId);

  // #420: a pin is written by an ordinary edit and removed by nothing, so a
  // field that has stopped tracking the platform is indistinguishable from a
  // broken sync unless this screen says so. What the pins currently DO depends
  // on the channel's `conflictPolicy`, which lives behind `channels:write` — so
  // it is read only when this member can read it, and `undefined` is rendered as
  // "not known" rather than as either policy.
  const source = product.source;
  const canReadChannels = can("channels:write");
  const connection = useConnection(storeId, source?.connectionId, canReadChannels);

  // #427: releasing a pin is gated on `products:write` — the permission an
  // ordinary edit already needs, and the one that CREATES a pin — so the way out
  // is exactly as reachable as the way in.
  //
  // It is offered under every `conflictPolicy`, including `connector_wins`. That
  // is not a control with no effect: `connector_wins` renders a pin INERT
  // without deleting it, so a merchant who releases a field there and later
  // turns "Keep my local edits" back on would otherwise find every pin they
  // thought they had given up waiting for them. The notice's own policy sentence
  // is what says whether the platform is currently overwriting anything.
  const releaseProductPins = useReleaseProductPins(storeId, product.id);
  const unnamedPins = partitionPinnedFields(product.overriddenFields).unnamed;
  const releasePins = (fields: string[]) =>
    releaseProductPins.mutate(fields, {
      onSuccess: () => toast.success(t("products.detail.pins.released")),
      onError: () => toast.error(t("products.detail.pins.releaseFailed")),
    });

  const [photoDraft, setPhotos] = useState<string[]>();
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photos = photoDraft?.map((fileId, position) => ({ fileId, position })) ?? product.images;
  const [titleDraft, setTitle] = useState<string>();
  const [descriptionDraft, setDescription] = useState<string>();
  const title = titleDraft ?? product.title;
  const description = descriptionDraft ?? product.description;
  const [organizationDraft, setOrganization] = useState<ProductOrganizationValue>({ vendor: product.vendor ?? "", productType: product.productType ?? "", tags: product.tags ?? [] });
  const [editedOrganization, setEditedOrganization] = useState({ vendor: false, productType: false, tags: false });
  // Untouched fields follow a refreshed DTO; an in-progress edit stays local.
  const organization: ProductOrganizationValue = {
    vendor: editedOrganization.vendor ? organizationDraft.vendor : product.vendor ?? "",
    productType: editedOrganization.productType ? organizationDraft.productType : product.productType ?? "",
    tags: editedOrganization.tags ? organizationDraft.tags : product.tags ?? [],
  };
  const organizationErrors = {
    vendor: editedOrganization.vendor && Boolean(product.vendor) && !organization.vendor.trim(),
    productType: editedOrganization.productType && Boolean(product.productType) && !organization.productType.trim(),
  };
  const changeOrganization = (next: ProductOrganizationValue) => {
    setEditedOrganization(previous => ({ vendor: previous.vendor || next.vendor !== organization.vendor, productType: previous.productType || next.productType !== organization.productType, tags: previous.tags || next.tags !== organization.tags }));
    setOrganization(next);
  };
  const restricted = isRestricted(product);
  // Falls back to `draft` only so the control has a valid value while disabled —
  // it is never submitted, because `save` is unreachable for a restricted listing.
  const [statusDraft, setStatus] = useState<SellerSettableListingStatus>();
  const status = restricted ? "draft" : statusDraft ?? (product.status as SellerSettableListingStatus);

  const changes: UpdateListingInput = {
    ...(photoDraft !== undefined && JSON.stringify(photoDraft) !== JSON.stringify(product.images.map(image => image.fileId)) ? { imageFileIds: photoDraft } : {}),
    ...(titleDraft !== undefined && title.trim() !== product.title ? { title: title.trim() } : {}),
    ...(descriptionDraft !== undefined && description.trim() !== product.description ? { description: description.trim() } : {}),
    ...(statusDraft !== undefined && status !== product.status ? { status } : {}),
    ...(editedOrganization.vendor && organization.vendor.trim() !== (product.vendor ?? "") ? { vendor: organization.vendor.trim() } : {}),
    ...(editedOrganization.productType && organization.productType.trim() !== (product.productType ?? "") ? { productType: organization.productType.trim() } : {}),
    ...(editedOrganization.tags && JSON.stringify(organization.tags) !== JSON.stringify(product.tags ?? []) ? { tags: organization.tags } : {}),
  };
  const hasChanges = Object.keys(changes).length > 0;
  const save = () => {
    if (!canWrite || uploadingPhoto || updateProduct.isPending || !hasChanges || restricted || organizationErrors.vendor || organizationErrors.productType) return;
    updateProduct.mutate(
      changes,
      {
        onSuccess: () => {
          setPhotos(undefined);
          setTitle(undefined);
          setDescription(undefined);
          setStatus(undefined);
          setEditedOrganization({ vendor: false, productType: false, tags: false });
          toast.success(t("products.detail.saved"));
        },
        onError: () => toast.error(t("products.detail.saveFailed")),
      },
    );
  };

  const archive = () => {
    archiveProduct.mutate(product.id, {
      onSuccess: () => {
        toast.success(t("products.detail.archived"));
        router.replace("/products");
      },
      onError: () => toast.error(t("products.detail.archiveFailed")),
    });
  };

  return (
      <View className="gap-5 lg:flex-row lg:items-start">
      <View testID="merchant-product-main" className="min-w-0 flex-1 gap-5 rounded-xl border border-border bg-white p-4 dark:bg-surface">
        {source ? (
          <View className="gap-3">
            <SourceBadge provider={source.provider} />
            <ConnectorPinNotice
              overriddenFields={product.overriddenFields}
              conflictPolicy={connection.data?.syncSettings.conflictPolicy}
              releaseNote={
                canWrite ? (
                  <Text className="text-xs text-muted-foreground">
                    {t("products.detail.pins.releaseNote")}
                  </Text>
                ) : null
              }
              fieldAction={
                canWrite
                  ? (field) => (
                      <Pressable
                        onPress={() => releasePins([field])}
                        disabled={releaseProductPins.isPending}
                        className="active:opacity-70"
                      >
                        <Text className="text-xs font-medium text-primary">
                          {t("products.detail.pins.release")}
                        </Text>
                      </Pressable>
                    )
                  : undefined
              }
              unnamedAction={
                canWrite && unnamedPins.length > 0 ? (
                  <Pressable
                    onPress={() => releasePins(unnamedPins)}
                    disabled={releaseProductPins.isPending}
                    className="active:opacity-70"
                  >
                    <Text className="text-xs font-medium text-primary">
                      {t("products.detail.pins.releaseUnnamed", { count: unnamedPins.length })}
                    </Text>
                  </Pressable>
                ) : null
              }
              action={
                canReadChannels ? (
                  <Pressable
                    onPress={() => router.push(`/channels/${source.connectionId}`)}
                    className="self-start active:opacity-70"
                  >
                    <Text className="text-xs font-medium text-primary">
                      {t("products.detail.channelSettings")}
                    </Text>
                  </Pressable>
                ) : null
              }
            />
          </View>
        ) : null}
        <Field label={t("common.title")}>
          <TextFieldInput
            label={t("common.title")}
            placeholder={null}
            value={title}
            onValueChange={setTitle}
            disabled={!canWrite || restricted || updateProduct.isPending}
          />
        </Field>
        <Textarea
          label={t("common.description")}
          value={description}
          onValueChange={setDescription}
          disabled={!canWrite || restricted || updateProduct.isPending}
        />
        <ProductPhotoEditor storeId={storeId} images={photos} title={product.title} disabled={!canWrite || restricted || updateProduct.isPending}
          onChange={setPhotos} onBusyChange={setUploadingPhoto} />
        <Field
          label={t("common.status")}
          description={restricted ? t("products.detail.restrictedNotice") : undefined}
        >
          <SegmentedControl
            type="radio"
            value={status}
            onValueChange={setStatus}
            disabled={!canWrite || restricted || updateProduct.isPending}
          >
            {STATUSES.map((s) => (
              <SegmentedControlItem key={s} value={s}>
                <SegmentedControlItemText>{t(STATUS_LABEL_KEYS[s])}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>

        {canWrite ? (
          <View className="flex-row gap-3">
            <Button tone="accent" className="flex-1" onPress={save} disabled={uploadingPhoto || !hasChanges || restricted || organizationErrors.vendor || organizationErrors.productType} loading={updateProduct.isPending}>
              {t("products.detail.saveChanges")}
            </Button>
            <Button tone="danger" onPress={archive} disabled={restricted || uploadingPhoto || updateProduct.isPending} loading={archiveProduct.isPending}>
              {t("products.detail.archive")}
            </Button>
          </View>
        ) : null}

        <VariantsSection storeId={storeId} product={product} canWrite={canWrite} />
      </View>
      <View className="w-full lg:w-72"><ProductOrganization category={product.category} value={organization} onChange={changeOrganization} errors={organizationErrors} disabled={!canWrite || restricted} busy={updateProduct.isPending} /></View>
      </View>
  );
}

function VariantsSection({
  storeId,
  product,
  canWrite,
}: {
  storeId: string;
  product: Listing;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const { can, store } = useActiveStoreContext();
  const [showAdd, setShowAdd] = useState(false);
  const currency = product.variants?.[0]?.price.currency ?? store?.defaultCurrency;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-foreground">
          {t("products.variants.heading")}
        </Text>
        {canWrite ? (
          <Button size="sm" appearance="outline" material="flat" disabled={showAdd}
            onPress={() => setShowAdd(true)}>
            {t("products.variants.add")}
          </Button>
        ) : null}
      </View>

      {showAdd && canWrite ? <CreateVariantForm storeId={storeId} product={product} currency={currency}
        onClose={() => setShowAdd(false)} /> : null}

      <View className="gap-2">
        {product.variants.map((variant) => (
          <VariantRow
            key={variant.id}
            storeId={storeId}
            productId={product.id}
            variant={variant}
            gallery={product.images}
            canWrite={canWrite}
            canInventory={can("inventory:write")}
            removable={product.variants.length > 1}
          />
        ))}
      </View>
    </View>
  );
}

function VariantRow({
  storeId,
  productId,
  variant,
  canWrite,
  canInventory,
  gallery,
  removable,
}: {
  storeId: string;
  productId: string;
  variant: ProductVariantDTO;
  canWrite: boolean;
  canInventory: boolean;
  gallery: Listing["images"];
  removable: boolean;
}) {
  const { colors } = useColorScheme();

  return (
    <View className="rounded-xl border border-border p-3">
      <View testID="merchant-variant-heading" className="mb-2 min-w-0 gap-2 sm:flex-row sm:items-start">
        <View className="min-w-0 flex-row items-start gap-2 sm:flex-1">
          <View className="shrink-0"><Boxes size={16} color={colors.mutedForeground} /></View>
          <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">{variant.title}</Text>
        </View>
        <PriceDisplay price={variant.price} className="flex-wrap sm:shrink-0" primaryClassName="text-sm font-semibold" />
      </View>
      <VariantImages storeId={storeId} productId={productId} variant={variant} gallery={gallery} canWrite={canWrite} />
      <VariantPrice storeId={storeId} productId={productId} variant={variant} canWrite={canWrite} />
      <VariantIdentifiers storeId={storeId} productId={productId} variant={variant} canWrite={canWrite} />
      <VariantInventory storeId={storeId} productId={productId} variantId={variant.id} available={variant.available} canWrite={canInventory} />
      <RemoveVariantButton storeId={storeId} productId={productId} variant={variant} canWrite={canWrite} removable={removable} />
    </View>
  );
}
