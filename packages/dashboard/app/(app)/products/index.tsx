import React, { useMemo, useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { Plus, Package, ChevronLeft, ChevronRight } from "lucide-react-native";
import type { Listing, ListingStatus } from "@mercaria/shared-types";
import { Text, Button, Input, PriceDisplay, SourceBadge, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useProducts } from "@/lib/hooks/use-products";
import { useAuthoringAvailability } from "@/lib/authoring/hooks";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";

/**
 * Translation KEYS per listing status, not sentences (#398).
 *
 * Evaluated once at import, before the locale store has rehydrated, so a
 * resolved label here would freeze whatever language loaded first. The row
 * resolves `t(STATUS_LABEL_KEYS[status])` instead.
 */
const STATUS_LABEL_KEYS: Record<ListingStatus, string> = {
  draft: "products.status.draft",
  active: "products.status.active",
  sold: "products.status.sold",
  archived: "products.status.archived",
  restricted: "products.status.restricted",
};

export default function ProductsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("products.documentTitle")}</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <ProductsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function ProductsBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const { data, isPending, isError } = useProducts(storeId, page, search);

  /**
   * Where "Add product" goes (#367 step 10).
   *
   * The schema-driven wizard exists only where the deployment has mounted the
   * authoring surface (`CATALOG_AUTHORING_ENABLED`, ADR 0007 D12), so the
   * destination is DERIVED from the server's own answer rather than from a
   * client flag. The legacy `/products/new` stays exactly where it was and is
   * still the destination everywhere the wizard is not available — parity
   * first, and retiring it is a separate decision this screen does not make.
   */
  const authoring = useAuthoringAvailability(locale);
  const createHref: "/products/new" | "/products/wizard" =
    authoring.data?.outcome === "available" ? "/products/wizard" : "/products/new";

  const filtered = useMemo(() => {
    const items = data?.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((p) => p.title.toLowerCase().includes(q));
  }, [data, search]);

  const action =
    can("products:write") ? (
      <View className="flex-row items-center gap-2">
        <StoreSwitcher />
        <Button onPress={() => router.push(createHref)}>
          <View className="flex-row items-center gap-2">
            <Plus size={16} color={colors.primaryForeground} />
            <Text className="font-semibold text-primary-foreground">{t("products.addProduct")}</Text>
          </View>
        </Button>
      </View>
    ) : (
      <StoreSwitcher />
    );

  return (
    <Screen title={t("products.title")} subtitle={t("products.subtitle")} action={action}>
      <View className="mb-4">
        <Input value={search} onChangeText={setSearch} placeholder={t("products.searchPlaceholder")} />
      </View>

      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t("products.loadFailed")} body={t("common.pleaseTryAgain")} />
      ) : filtered.length === 0 ? (
        <EmptyProducts canWrite={can("products:write")} onCreate={() => router.push(createHref)} />
      ) : (
        <View className="gap-2">
          {filtered.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              onPress={() => router.push(`/products/${product.id}`)}
            />
          ))}
        </View>
      )}

      {data && data.pagination.pages > 1 ? (
        <Pagination
          page={data.pagination.page}
          pages={data.pagination.pages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => p + 1)}
        />
      ) : null}
    </Screen>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-primary/10 text-primary",
  draft: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground",
  sold: "bg-muted text-muted-foreground",
};

function ProductRow({ product, onPress }: { product: Listing; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3 active:opacity-80 web:hover:border-primary"
    >
      <View className="h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-muted">
        <Package size={20} className="text-muted-foreground" />
      </View>
      <View className="flex-1 gap-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {product.title}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t("products.row.variantsInStock", {
            count: product.variants.length,
            stock: product.quantity,
          })}
        </Text>
        {product.source ? <SourceBadge provider={product.source.provider} /> : null}
      </View>
      <PriceDisplay price={product.price} primaryClassName="text-sm font-semibold" />
      <View className={`rounded-full px-2 py-1 ${STATUS_STYLES[product.status] ?? "bg-muted"}`}>
        <Text className={`text-[10px] font-semibold capitalize ${STATUS_STYLES[product.status]?.split(" ")[1] ?? "text-muted-foreground"}`}>
          {t(STATUS_LABEL_KEYS[product.status])}
        </Text>
      </View>
    </Pressable>
  );
}

function EmptyProducts({ canWrite, onCreate }: { canWrite: boolean; onCreate: () => void }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  return (
    <View className="items-center justify-center rounded-2xl border border-dashed border-border py-16">
      <Package size={36} color={colors.mutedForeground} />
      <Text className="mt-4 text-base font-semibold text-foreground">{t("products.empty.title")}</Text>
      {canWrite ? (
        <Button className="mt-6" onPress={onCreate}>
          <Text className="font-semibold text-primary-foreground">{t("products.empty.action")}</Text>
        </Button>
      ) : null}
    </View>
  );
}

function Pagination({
  page,
  pages,
  onPrev,
  onNext,
}: {
  page: number;
  pages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  return (
    <View className="mt-4 flex-row items-center justify-center gap-4">
      <Pressable
        onPress={onPrev}
        disabled={page <= 1}
        className="h-9 w-9 items-center justify-center rounded-lg border border-border active:opacity-70 disabled:opacity-40"
      >
        <ChevronLeft size={18} color={colors.foreground} />
      </Pressable>
      <Text className="text-sm text-muted-foreground">
        {t("common.pageOf", { current: page, total: pages })}
      </Text>
      <Pressable
        onPress={onNext}
        disabled={page >= pages}
        className="h-9 w-9 items-center justify-center rounded-lg border border-border active:opacity-70 disabled:opacity-40"
      >
        <ChevronRight size={18} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
