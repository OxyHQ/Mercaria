import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, Trash2, Plus, Boxes } from "lucide-react-native";
import type { Listing, ListingStatus, ProductVariantDTO } from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  Textarea,
  PriceDisplay,
  ToggleGroup,
  ToggleGroupItem,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@/components/sonner";
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
} from "@/lib/hooks/use-products";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { toFairMinor, toMajorString } from "@/lib/money";

const STATUSES: ListingStatus[] = ["draft", "active", "archived"];

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Head>
        <title>Product | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <ProductDetailBody storeId={storeId} productId={String(id)} />}
      </RequireStore>
    </>
  );
}

function ProductDetailBody({ storeId, productId }: { storeId: string; productId: string }) {
  const { data, isPending, isError } = useProduct(storeId, productId);

  if (isPending) {
    return (
      <Screen title="Product">
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title="Product">
        <ScreenMessage title="Couldn't load product" body="Please try again." />
      </Screen>
    );
  }
  return <ProductEditor storeId={storeId} product={data} />;
}

function ProductEditor({ storeId, product }: { storeId: string; product: Listing }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const canWrite = can("products:write");

  const updateProduct = useUpdateProduct(storeId, product.id);
  const archiveProduct = useArchiveProduct(storeId);

  const [title, setTitle] = useState(product.title);
  const [description, setDescription] = useState(product.description);
  const [status, setStatus] = useState<ListingStatus>(product.status);

  const save = () => {
    updateProduct.mutate(
      { title: title.trim(), description: description.trim(), status },
      {
        onSuccess: () => toast.success("Product saved"),
        onError: () => toast.error("Couldn't save the product"),
      },
    );
  };

  const archive = () => {
    archiveProduct.mutate(product.id, {
      onSuccess: () => {
        toast.success("Product archived");
        router.replace("/products");
      },
      onError: () => toast.error("Couldn't archive the product"),
    });
  };

  return (
    <Screen
      title={product.title}
      subtitle={`${product.variants.length} variant${product.variants.length === 1 ? "" : "s"}`}
      action={
        <Pressable
          onPress={() => router.back()}
          className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
        >
          <ChevronLeft size={16} color={colors.foreground} />
          <Text className="text-sm font-medium text-foreground">Back</Text>
        </Pressable>
      }
    >
      <View className="gap-5">
        <View className="gap-1.5">
          <Label>Title</Label>
          <Input value={title} onChangeText={setTitle} editable={canWrite} />
        </View>
        <View className="gap-1.5">
          <Label>Description</Label>
          <Textarea value={description} onChangeText={setDescription} editable={canWrite} />
        </View>
        <View className="gap-1.5">
          <Label>Status</Label>
          <ToggleGroup
            type="single"
            value={status}
            onValueChange={(v) => {
              if (canWrite && typeof v === "string" && v) {
                setStatus(v as ListingStatus);
              }
            }}
          >
            {STATUSES.map((s) => (
              <ToggleGroupItem key={s} value={s}>
                <Text className="text-sm capitalize text-foreground">{s}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </View>

        {canWrite ? (
          <View className="flex-row gap-3">
            <Button className="flex-1" onPress={save} isLoading={updateProduct.isPending}>
              <Text className="font-semibold text-primary-foreground">Save changes</Text>
            </Button>
            <Button variant="destructive" onPress={archive} isLoading={archiveProduct.isPending}>
              <Text className="font-semibold text-destructive-foreground">Archive</Text>
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
  const { colors } = useColorScheme();
  const { can } = useActiveStoreContext();
  const createVariant = useCreateVariant(storeId, product.id);

  const optionName = product.options?.[0]?.name ?? "";
  const [showAdd, setShowAdd] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newStock, setNewStock] = useState("0");

  const addVariant = () => {
    const priceMinor = toFairMinor(newPrice);
    if (priceMinor === null) {
      toast.error("Enter a valid price");
      return;
    }
    const available = Math.max(0, Number.parseInt(newStock || "0", 10) || 0);
    createVariant.mutate(
      {
        optionValues:
          optionName && newValue.trim() ? [{ name: optionName, value: newValue.trim() }] : [],
        price: { amount: priceMinor, currency: "FAIR" },
        inventory: { available },
      },
      {
        onSuccess: () => {
          toast.success("Variant added");
          setShowAdd(false);
          setNewValue("");
          setNewPrice("");
          setNewStock("0");
        },
        onError: () => toast.error("Couldn't add the variant"),
      },
    );
  };

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-foreground">Variants & inventory</Text>
        {canWrite ? (
          <Pressable
            onPress={() => setShowAdd((s) => !s)}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <Plus size={16} color={colors.primary} />
            <Text className="text-sm font-medium text-primary">Add</Text>
          </Pressable>
        ) : null}
      </View>

      {showAdd ? (
        <View className="mb-3 rounded-xl border border-border p-3">
          {optionName ? (
            <View className="mb-2">
              <Label>{optionName}</Label>
              <Input value={newValue} onChangeText={setNewValue} placeholder="value" />
            </View>
          ) : null}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Label>Price (⊜)</Label>
              <Input value={newPrice} onChangeText={setNewPrice} keyboardType="decimal-pad" placeholder="0.00" />
            </View>
            <View className="flex-1">
              <Label>Stock</Label>
              <Input value={newStock} onChangeText={setNewStock} keyboardType="number-pad" placeholder="0" />
            </View>
          </View>
          <Button size="sm" className="mt-3 self-start" onPress={addVariant} isLoading={createVariant.isPending}>
            <Text className="text-sm font-semibold text-primary-foreground">Save variant</Text>
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
  const { colors } = useColorScheme();
  const updateVariant = useUpdateVariant(storeId, productId);
  const deleteVariant = useDeleteVariant(storeId, productId);
  const setInventory = useSetVariantInventory(storeId, productId);

  const [price, setPrice] = useState(toMajorString(variant.price.amount, "FAIR"));
  const [stock, setStock] = useState(String(variant.available));

  const savePrice = () => {
    const priceMinor = toFairMinor(price);
    if (priceMinor === null) {
      toast.error("Enter a valid price");
      return;
    }
    updateVariant.mutate(
      { variantId: variant.id, input: { price: { amount: priceMinor, currency: "FAIR" } } },
      {
        onSuccess: () => toast.success("Variant updated"),
        onError: () => toast.error("Couldn't update the variant"),
      },
    );
  };

  const saveStock = () => {
    const available = Math.max(0, Number.parseInt(stock || "0", 10) || 0);
    setInventory.mutate(
      { variantId: variant.id, available },
      {
        onSuccess: () => toast.success("Inventory updated"),
        onError: () => toast.error("Couldn't update inventory"),
      },
    );
  };

  const remove = () => {
    deleteVariant.mutate(variant.id, {
      onSuccess: () => toast.success("Variant removed"),
      onError: () => toast.error("Couldn't remove the variant"),
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
          <Label>Price (⊜)</Label>
          <Input value={price} onChangeText={setPrice} keyboardType="decimal-pad" editable={canWrite} />
        </View>
        {canWrite ? (
          <Button size="sm" variant="outline" onPress={savePrice} isLoading={updateVariant.isPending}>
            <Text className="text-sm font-medium text-foreground">Save</Text>
          </Button>
        ) : null}
      </View>
      <View className="mt-2 flex-row items-end gap-2">
        <View className="flex-1">
          <Label>Available</Label>
          <Input value={stock} onChangeText={setStock} keyboardType="number-pad" editable={canInventory} />
        </View>
        {canInventory ? (
          <Button size="sm" variant="outline" onPress={saveStock} isLoading={setInventory.isPending}>
            <Text className="text-sm font-medium text-foreground">Set</Text>
          </Button>
        ) : null}
      </View>
      {canWrite && removable ? (
        <Pressable onPress={remove} className="mt-2 flex-row items-center gap-1 self-end active:opacity-70">
          <Trash2 size={14} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">Remove variant</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
