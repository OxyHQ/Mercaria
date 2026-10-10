import React, { useState } from "react";
import { View, Pressable, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { useRouter, type RoutePath } from "expo-router";
import Head from "expo-router/head";
import { Plus, Package, Search as SearchIcon } from "lucide-react-native";
import { ALL_LISTING_STATUSES, type Listing, type ListingStatus } from "@mercaria/shared-types";
import { Badge } from "@oxy.so/bloom/badge";
import { Button } from "@oxy.so/bloom/button";
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from "@oxy.so/bloom/table";
import { TextField, TextFieldIcon, TextFieldInput } from "@oxy.so/bloom/text-field";
import { isImageUrl, useImageResolver } from "@oxy.so/bloom/image-resolver";
import { Text, PriceDisplay, SourceBadge, toBloomFieldIcon, toBloomIcon, useColorScheme } from "@mercaria/ui";
import { Screen } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { StatusFilter, ResourceList, ResourceState, ListPagination } from "@/components/lists/ResourceList";
import { useTranslation } from "@/lib/i18n";
import { useProducts } from "@/lib/hooks/use-products";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useAuthoringAvailability } from "@/lib/authoring/hooks";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";

const STATUS_LABEL_KEYS: Record<ListingStatus, string> = {
  draft: "products.status.draft", active: "products.status.active", sold: "products.status.sold",
  archived: "products.status.archived", restricted: "products.status.restricted",
};

export default function ProductsScreen() {
  const { t } = useTranslation();
  return <><Head><title>{t("products.documentTitle")}</title></Head>
    <RequireStore permission="products:read">{storeId => <ProductsBody key={storeId} storeId={storeId} />}</RequireStore></>;
}

function ProductsBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const { can } = useActiveStoreContext();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListingStatus | "all">("all");
  const query = useDebouncedValue(search.trim(), 250);
  const { data, isPending, isFetching, isError, isPlaceholderData, refetch } = useProducts(storeId, page, query, status);
  const changingSearch = query !== search.trim();
  const busy = isFetching || changingSearch;
  /**
   * Where "Add product" goes (#367 step 10).
   *
   * The schema-driven wizard exists only where the deployment has mounted the
   * authoring surface (`CATALOG_AUTHORING_ENABLED`, ADR 0007 D12), so the
   * destination is DERIVED from the server's own answer rather than from a
   * client flag. The legacy `/products/new` stays exactly where it was and is
   * still the destination everywhere the wizard is not available — parity
   * first, and retiring it is a separate decision this screen does not make.
   *
   * Annotated `RoutePath` rather than with the two literals it can hold, and
   * that is load-bearing twice over. `route-reachability.test.ts` reads a
   * navigation edge out of a `const x: RoutePath = …` declaration and records
   * BOTH sides of the conditional, so this is the one spelling under which the
   * import graph can see what a user can reach. Writing the narrower union
   * instead hid the edge — and it hid the two `/products/new` edges this screen
   * used to carry as literals, which the gate caught as a route that had gone
   * unreachable. `RoutePath` IS the generated route union, so a target that is
   * not a real route still fails `tsc` here.
   */
  const authoring = useAuthoringAvailability(locale);
  const createHref: RoutePath =
    authoring.data?.outcome === "available" ? "/products/wizard" : "/products/new";

  const filtered = status !== "all" || search.trim() !== "";
  const products = data?.data ?? [];
  const clear = () => { setSearch(""); setStatus("all"); setPage(1); };
  const openProduct = (id: string) => router.push({ pathname: "/products/[id]", params: { id } });
  const statusOptions = [{ value: "all" as const, label: t("common.all") }, ...ALL_LISTING_STATUSES.map(value => ({ value, label: t(STATUS_LABEL_KEYS[value]) }))];
  const pending = isPending || changingSearch;
  const action = can("products:write") ? <Button tone="accent" material="flat" leadingIcon={toBloomIcon(Plus)} onPress={() => router.push(createHref)}>{t("products.addProduct")}</Button> : undefined;
  return <Screen title={t("products.title")} action={action}>
    <ResourceList testID="merchant-products-list" busy={busy} toolbar={
      <View className="gap-3 md:flex-row md:items-center">
        <StatusFilter value={status} options={statusOptions} onChange={next => { setStatus(next); setPage(1); }} />
        <View className="md:flex-1"><TextField radius={8}><TextFieldIcon icon={toBloomFieldIcon(SearchIcon)} />
          <TextFieldInput label={t("products.searchPlaceholder")} value={search} maxLength={200}
            onValueChange={value => { setSearch(value); setPage(1); }} returnKeyType="search" />
        </TextField></View>
      </View>
    } footer={data && !pending && !isError ? <ListPagination page={data.pagination.page} pages={data.pagination.pages} busy={busy} onPage={setPage} /> : null}>
      {pending || isError || !products.length ? <ResourceState loading={pending} error={isError} errorTitle={t("products.loadFailed")} filtered={filtered}
        emptyTitle={t("products.empty.title")} onRetry={() => { void refetch(); }} onClear={clear}
        action={can("products:write") ? { label: t("products.empty.action"), onPress: () => router.push(createHref) } : undefined} />
      : width >= 768 ? <Table accessibilityLabel={t("products.title")} size="sm" minWidth={600}>
        <TableHeader><TableColumn flex={3}><Text className="text-xs font-semibold text-muted-foreground">{t("common.title")}</Text></TableColumn>
          <TableColumn width={115}><Text className="text-xs font-semibold text-muted-foreground">{t("common.status")}</Text></TableColumn>
          <TableColumn flex={2}><Text className="text-xs font-semibold text-muted-foreground">{t("products.stockLabel")}</Text></TableColumn>
          <TableColumn width={130} align="end"><Text className="text-xs font-semibold text-muted-foreground">{t("resourceList.price")}</Text></TableColumn></TableHeader>
        <TableBody>{products.map(product => <TableRow key={product.id} testID="merchant-product-row">
          <TableCell><ProductIdentity product={product} disabled={isPlaceholderData} onPress={() => openProduct(product.id)} /></TableCell>
          <TableCell><ProductStatus status={product.status} /></TableCell>
          <TableCell><Text className="text-xs text-muted-foreground">{t("products.row.variantsInStock", { count: product.variants.length, stock: product.quantity })}</Text></TableCell>
          <TableCell><PriceDisplay price={product.price} primaryClassName="text-sm" /></TableCell>
        </TableRow>)}</TableBody>
      </Table> : <View>{products.map(product => <View key={product.id} testID="merchant-product-row" className="gap-3 border-b border-border p-4">
        <ProductIdentity product={product} disabled={isPlaceholderData} onPress={() => openProduct(product.id)} />
        <View className="flex-row items-center justify-between gap-2"><ProductStatus status={product.status} /><PriceDisplay price={product.price} primaryClassName="text-sm" /></View>
        <Text className="text-xs text-muted-foreground">{t("products.row.variantsInStock", { count: product.variants.length, stock: product.quantity })}</Text>
      </View>)}</View>}
    </ResourceList>
  </Screen>;
}

function ProductStatus({ status }: { status: ListingStatus }) {
  const { t } = useTranslation();
  return <Badge size="label-small" variant="subtle" color={status === "active" ? "primary" : "default"} content={t(STATUS_LABEL_KEYS[status])} />;
}

function ProductIdentity({ product, onPress, disabled }: { product: Listing; onPress: () => void; disabled: boolean }) {
  const resolveImage = useImageResolver();
  const { colors } = useColorScheme();
  const fileId = product.images[0]?.fileId;
  const uri = fileId && !isImageUrl(fileId) ? resolveImage?.(fileId, "thumb") : undefined;
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={product.title}
    className="flex-row items-center gap-3 rounded-lg py-1 active:opacity-70 web:hover:opacity-70">
    <View className="h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
      {uri ? <Image source={{ uri }} style={{ width: 40, height: 40 }} contentFit="cover" accessibilityLabel={product.images[0]?.alt || product.title} /> : <Package size={18} color={colors.mutedForeground} />}
    </View>
    <View className="min-w-0 flex-1 gap-1"><Text className="text-sm font-semibold text-foreground" numberOfLines={2}>{product.title}</Text>
      {product.source ? <SourceBadge provider={product.source.provider} /> : null}
    </View>
  </Pressable>;
}
