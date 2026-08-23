import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, Trash2, Plus, Boxes } from "lucide-react-native";
import { partitionPinnedFields } from "@mercaria/shared-types";
import type {
  Listing,
  ProductVariantDTO,
  SellerSettableListingStatus,
} from "@mercaria/shared-types";
import {
  Text,
  Button,
  ConnectorPinNotice,
  Input,
  Label,
  Textarea,
  PriceDisplay,
  SourceBadge,
  ToggleGroup,
  ToggleGroupItem,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  useProduct,
  useUpdateProduct,
  useArchiveProduct,
  useCreateVariant,
  useUpdateVariant,
  useDeleteVariant,
  useSetVariantInventory,
  useReleaseProductPins,
} from "@/lib/hooks/use-products";
import { useConnection } from "@/lib/hooks/use-channels";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { useTranslation } from "@/lib/i18n";
import { toMajorString, toMinorUnits } from "@/lib/money";

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
        {(storeId) => <ProductDetailBody storeId={storeId} productId={String(id)} />}
      </RequireStore>
    </>
  );
}

function ProductDetailBody({ storeId, productId }: { storeId: string; productId: string }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useProduct(storeId, productId);

  if (isPending) {
    return (
      <Screen title={t("products.detail.title")}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title={t("products.detail.title")}>
        <ScreenMessage title={t("products.detail.loadFailed")} body={t("common.pleaseTryAgain")} />
      </Screen>
    );
  }
  return <ProductEditor storeId={storeId} product={data} />;
}

function ProductEditor({ storeId, product }: { storeId: string; product: Listing }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
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

  const [title, setTitle] = useState(product.title);
  const [description, setDescription] = useState(product.description);
  const restricted = isRestricted(product);
  // Falls back to `draft` only so the control has a valid value while disabled —
  // it is never submitted, because `save` is unreachable for a restricted listing.
  const [status, setStatus] = useState<SellerSettableListingStatus>(
    restricted ? "draft" : (product.status as SellerSettableListingStatus),
  );

  const save = () => {
    if (restricted) return;
    updateProduct.mutate(
      { title: title.trim(), description: description.trim(), status },
      {
        onSuccess: () => toast.success(t("products.detail.saved")),
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
    <Screen
      title={product.title}
      subtitle={t("products.detail.variantCount", { count: product.variants.length })}
      action={
        <Pressable
          onPress={() => router.back()}
          className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
        >
          <ChevronLeft size={16} color={colors.foreground} />
          <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
        </Pressable>
      }
    >
      <View className="gap-5">
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
        <View className="gap-1.5">
          <Label>{t("common.title")}</Label>
          <Input value={title} onChangeText={setTitle} editable={canWrite} />
        </View>
        <View className="gap-1.5">
          <Label>{t("common.description")}</Label>
          <Textarea value={description} onChangeText={setDescription} editable={canWrite} />
        </View>
        <View className="gap-1.5">
          <Label>{t("common.status")}</Label>
          {restricted ? (
            <Text className="text-sm text-muted-foreground">
              {t("products.detail.restrictedNotice")}
            </Text>
          ) : null}
          <ToggleGroup
            type="single"
            value={status}
            onValueChange={(v) => {
              if (canWrite && !restricted && typeof v === "string" && v) {
                setStatus(v as SellerSettableListingStatus);
              }
            }}
          >
            {STATUSES.map((s) => (
              <ToggleGroupItem key={s} value={s}>
                <Text className="text-sm capitalize text-foreground">{t(STATUS_LABEL_KEYS[s])}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </View>

        {canWrite ? (
          <View className="flex-row gap-3">
            <Button className="flex-1" onPress={save} isLoading={updateProduct.isPending}>
              <Text className="font-semibold text-primary-foreground">
                {t("products.detail.saveChanges")}
              </Text>
            </Button>
            <Button variant="destructive" onPress={archive} isLoading={archiveProduct.isPending}>
              <Text className="font-semibold text-destructive-foreground">
                {t("products.detail.archive")}
              </Text>
            </Button>
          </View>
        ) : null}

        <VariantsSection storeId={storeId} product={product} canWrite={canWrite} />
      </View>
    </Screen>
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
  const { colors } = useColorScheme();
  const { can, store } = useActiveStoreContext();
  const createVariant = useCreateVariant(storeId, product.id);
  /**
   * A new variant joins a product whose existing variants already name a
   * currency, so it matches them; a product with none takes the STORE's
   * (#927). Never a literal — writing FAIR here denominated a EUR store's
   * catalogue in FairCoin, at eight decimals instead of two.
   */
  const currency = product.variants?.[0]?.price.currency ?? store?.defaultCurrency;

  const optionName = product.options?.[0]?.name ?? "";
  const [showAdd, setShowAdd] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newStock, setNewStock] = useState("0");

  const addVariant = () => {
    // Refuse rather than default: an unknown currency must not become FAIR.
    if (!currency) return;
    const priceMinor = toMinorUnits(newPrice, currency);
    if (priceMinor === null) {
      toast.error(t("products.variants.priceInvalid"));
      return;
    }
    const available = Math.max(0, Number.parseInt(newStock || "0", 10) || 0);
    createVariant.mutate(
      {
        optionValues:
          optionName && newValue.trim() ? [{ name: optionName, value: newValue.trim() }] : [],
        price: { amount: priceMinor, currency },
        inventory: { available },
      },
      {
        onSuccess: () => {
          toast.success(t("products.variants.added"));
          setShowAdd(false);
          setNewValue("");
          setNewPrice("");
          setNewStock("0");
        },
        onError: () => toast.error(t("products.variants.addFailed")),
      },
    );
  };

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-foreground">
          {t("products.variants.heading")}
        </Text>
        {canWrite ? (
          <Pressable
            onPress={() => setShowAdd((s) => !s)}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Plus size={16} color={colors.primary} />
            <Text className="text-sm font-medium text-primary">{t("products.variants.add")}</Text>
          </Pressable>
        ) : null}
      </View>

      {showAdd ? (
        <View className="mb-3 rounded-xl border border-border p-3">
          {optionName ? (
            <View className="mb-2">
              <Label>{optionName}</Label>
              <Input
                value={newValue}
                onChangeText={setNewValue}
                placeholder={t("products.variants.valuePlaceholder")}
              />
            </View>
          ) : null}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Label>{t("products.priceLabel")}</Label>
              <Input value={newPrice} onChangeText={setNewPrice} keyboardType="decimal-pad" placeholder="0.00" />
            </View>
            <View className="flex-1">
              <Label>{t("products.stockLabel")}</Label>
              <Input value={newStock} onChangeText={setNewStock} keyboardType="number-pad" placeholder="0" />
            </View>
          </View>
          <Button size="sm" className="mt-3 self-start" onPress={addVariant} isLoading={createVariant.isPending}>
            <Text className="text-sm font-semibold text-primary-foreground">
              {t("products.variants.saveVariant")}
            </Text>
          </Button>
        </View>
      ) : null}

      <View className="gap-2">
        {product.variants.map((variant) => (
          <VariantRow
            key={variant.id}
            storeId={storeId}
            productId={product.id}
            variant={variant}
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
  removable,
}: {
  storeId: string;
  productId: string;
  variant: ProductVariantDTO;
  canWrite: boolean;
  canInventory: boolean;
  removable: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const updateVariant = useUpdateVariant(storeId, productId);
  const deleteVariant = useDeleteVariant(storeId, productId);
  const setInventory = useSetVariantInventory(storeId, productId);

  /**
   * The variant's OWN currency (#927) — a stored price already names its
   * denomination, so nothing here needs the store or a literal. Rendering
   * at FAIR's eight decimals showed a EUR price 10^6 too large, and the
   * matching write hid it by being wrong in the same direction.
   */
  const currency = variant.price.currency;
  const [price, setPrice] = useState(toMajorString(variant.price.amount, currency));
  const [stock, setStock] = useState(String(variant.available));

  const savePrice = () => {
    const priceMinor = toMinorUnits(price, currency);
    if (priceMinor === null) {
      toast.error(t("products.variants.priceInvalid"));
      return;
    }
    updateVariant.mutate(
      { variantId: variant.id, input: { price: { amount: priceMinor, currency } } },
      {
        onSuccess: () => toast.success(t("products.variants.updated")),
        onError: () => toast.error(t("products.variants.updateFailed")),
      },
    );
  };

  const saveStock = () => {
    const available = Math.max(0, Number.parseInt(stock || "0", 10) || 0);
    setInventory.mutate(
      { variantId: variant.id, available },
      {
        onSuccess: () => toast.success(t("products.variants.inventoryUpdated")),
        onError: () => toast.error(t("products.variants.inventoryUpdateFailed")),
      },
    );
  };

  const remove = () => {
    deleteVariant.mutate(variant.id, {
      onSuccess: () => toast.success(t("products.variants.removed")),
      onError: () => toast.error(t("products.variants.removeFailed")),
    });
  };

  return (
    <View className="rounded-xl border border-border p-3">
      <View className="mb-2 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Boxes size={16} color={colors.mutedForeground} />
          <Text className="text-sm font-semibold text-foreground">{variant.title}</Text>
        </View>
        <PriceDisplay price={variant.price} primaryClassName="text-sm font-semibold" />
      </View>
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <Label>{t("products.priceLabel")}</Label>
          <Input value={price} onChangeText={setPrice} keyboardType="decimal-pad" editable={canWrite} />
        </View>
        {canWrite ? (
          <Button size="sm" variant="outline" onPress={savePrice} isLoading={updateVariant.isPending}>
            <Text className="text-sm font-medium text-foreground">{t("common.save")}</Text>
          </Button>
        ) : null}
      </View>
      <View className="mt-2 flex-row items-end gap-2">
        <View className="flex-1">
          <Label>{t("products.variants.available")}</Label>
          <Input value={stock} onChangeText={setStock} keyboardType="number-pad" editable={canInventory} />
        </View>
        {canInventory ? (
          <Button size="sm" variant="outline" onPress={saveStock} isLoading={setInventory.isPending}>
            <Text className="text-sm font-medium text-foreground">{t("products.variants.set")}</Text>
          </Button>
        ) : null}
      </View>
      {canWrite && removable ? (
        <Pressable onPress={remove} className="mt-2 flex-row items-center gap-1 self-end active:opacity-70">
          <Trash2 size={14} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{t("products.variants.removeVariant")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
