import React, { useMemo, useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { Plus, Package, ChevronLeft, ChevronRight } from "lucide-react-native";
import type { Listing } from "@mercaria/shared-types";
import { Text, Button, Input, PriceDisplay, SourceBadge, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useProducts } from "@/lib/hooks/use-products";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";

export default function ProductsScreen() {
  return (
    <>
      <Head>
        <title>Products | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <ProductsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function ProductsBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const { data, isPending, isError } = useProducts(storeId, page, search);

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
        <Button onPress={() => router.push("/products/new")}>
          <View className="flex-row items-center gap-2">
            <Plus size={16} color={colors.primaryForeground} />
            <Text className="font-semibold text-primary-foreground">Add product</Text>
          </View>
        </Button>
      </View>
    ) : (
      <StoreSwitcher />
    );

  return (
    <Screen title="Products" subtitle="Your store catalog" action={action}>
      <View className="mb-4">
        <Input value={search} onChangeText={setSearch} placeholder="Search products on this page…" />
      </View>

      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load products" body="Please try again." />
      ) : filtered.length === 0 ? (
        <EmptyProducts canWrite={can("products:write")} onCreate={() => router.push("/products/new")} />
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
          {product.variants.length} variant{product.variants.length === 1 ? "" : "s"} ·{" "}
          {product.quantity} in stock
        </Text>
        {product.source ? <SourceBadge provider={product.source.provider} /> : null}
      </View>
      <PriceDisplay price={product.price} primaryClassName="text-sm font-semibold" />
      <View className={`rounded-full px-2 py-1 ${STATUS_STYLES[product.status] ?? "bg-muted"}`}>
        <Text className={`text-[10px] font-semibold capitalize ${STATUS_STYLES[product.status]?.split(" ")[1] ?? "text-muted-foreground"}`}>
          {product.status}
        </Text>
      </View>
    </Pressable>
  );
}

function EmptyProducts({ canWrite, onCreate }: { canWrite: boolean; onCreate: () => void }) {
  const { colors } = useColorScheme();
  return (
    <View className="items-center justify-center rounded-2xl border border-dashed border-border py-16">
      <Package size={36} color={colors.mutedForeground} />
      <Text className="mt-4 text-base font-semibold text-foreground">No products yet</Text>
      {canWrite ? (
        <Button className="mt-6" onPress={onCreate}>
          <Text className="font-semibold text-primary-foreground">Add your first product</Text>
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
        Page {page} of {pages}
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
