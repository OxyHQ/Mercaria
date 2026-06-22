import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { Trash2, Plus } from "lucide-react-native";
import type {
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  ListingOption,
} from "@mercaria/shared-types";
import { Text, Button, Input, Label, Textarea, useColorScheme } from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useCreateProduct } from "@/lib/hooks/use-products";
import { toFairMinor } from "@/lib/money";

/** A single editable variant row in the builder. */
interface VariantDraft {
  key: string;
  title: string;
  priceMajor: string;
  sku: string;
  available: string;
}

let draftCounter = 0;
function newVariantDraft(): VariantDraft {
  draftCounter += 1;
  return { key: `v${draftCounter}`, title: "", priceMajor: "", sku: "", available: "0" };
}

export default function NewProductScreen() {
  return (
    <>
      <Head>
        <title>New product | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="products:write">
        {(storeId) => <NewProductBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function NewProductBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const createProduct = useCreateProduct(storeId);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [vendor, setVendor] = useState("");
  const [optionName, setOptionName] = useState("");
  const [variants, setVariants] = useState<VariantDraft[]>([newVariantDraft()]);

  const updateVariant = (key: string, patch: Partial<VariantDraft>) => {
    setVariants((prev) => prev.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  };

  const submit = () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!category.trim()) {
      toast.error("Category is required");
      return;
    }

    const builtVariants: CreateStoreProductVariantInput[] = [];
    for (const v of variants) {
      const priceMinor = toFairMinor(v.priceMajor);
      if (priceMinor === null) {
        toast.error("Each variant needs a valid price");
        return;
      }
      const available = Number.parseInt(v.available || "0", 10);
      builtVariants.push({
        optionValues:
          optionName.trim() && v.title.trim()
            ? [{ name: optionName.trim(), value: v.title.trim() }]
            : [],
        price: { amount: priceMinor, currency: "FAIR" },
        ...(v.sku.trim() ? { sku: v.sku.trim() } : {}),
        inventory: { available: Number.isFinite(available) ? Math.max(0, available) : 0 },
      });
    }

    const options: ListingOption[] =
      optionName.trim() && variants.some((v) => v.title.trim())
        ? [
            {
              name: optionName.trim(),
              values: variants.map((v) => v.title.trim()).filter(Boolean),
            },
          ]
        : [];

    const input: CreateStoreProductInput = {
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      imageFileIds: [],
      options,
      variants: builtVariants,
      ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
    };

    createProduct.mutate(input, {
      onSuccess: (listing) => {
        toast.success("Product created");
        router.replace(`/products/${listing.id}`);
      },
      onError: () => toast.error("Couldn't create the product"),
    });
  };

  return (
    <Screen title="New product" subtitle="Add a product to your catalog">
      <View className="gap-5">
        <Field label="Title">
          <Input value={title} onChangeText={setTitle} placeholder="Product name" />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChangeText={setDescription} placeholder="Describe the product" />
        </Field>
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Field label="Category (slug)">
              <Input value={category} onChangeText={setCategory} placeholder="electronics" autoCapitalize="none" />
            </Field>
          </View>
          <View className="flex-1">
            <Field label="Vendor / brand">
              <Input value={vendor} onChangeText={setVendor} placeholder="Acme" />
            </Field>
          </View>
        </View>

        <View className="rounded-2xl border border-border bg-surface p-4">
          <Text className="mb-3 text-sm font-semibold text-foreground">Options & variants</Text>
          <Field label="Option name (optional, e.g. Size)">
            <Input value={optionName} onChangeText={setOptionName} placeholder="Size" />
          </Field>

          <View className="mt-4 gap-3">
            {variants.map((v, idx) => (
              <View key={v.key} className="rounded-xl border border-border p-3">
                <View className="mb-2 flex-row items-center justify-between">
                  <Text className="text-xs font-semibold text-muted-foreground">
                    Variant {idx + 1}
                  </Text>
                  {variants.length > 1 ? (
                    <Pressable
                      onPress={() => setVariants((prev) => prev.filter((x) => x.key !== v.key))}
                      className="active:opacity-70"
                    >
                      <Trash2 size={16} color={colors.mutedForeground} />
                    </Pressable>
                  ) : null}
                </View>
                {optionName.trim() ? (
                  <View className="mb-2">
                    <Label>{optionName.trim()} value</Label>
                    <Input
                      value={v.title}
                      onChangeText={(t) => updateVariant(v.key, { title: t })}
                      placeholder="M"
                    />
                  </View>
                ) : null}
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <Label>Price (⊜)</Label>
                    <Input
                      value={v.priceMajor}
                      onChangeText={(t) => updateVariant(v.key, { priceMajor: t })}
                      placeholder="0.00"
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <View className="flex-1">
                    <Label>Stock</Label>
                    <Input
                      value={v.available}
                      onChangeText={(t) => updateVariant(v.key, { available: t })}
                      placeholder="0"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                <View className="mt-2">
                  <Label>SKU (optional)</Label>
                  <Input value={v.sku} onChangeText={(t) => updateVariant(v.key, { sku: t })} placeholder="SKU-123" />
                </View>
              </View>
            ))}
          </View>

          <Button
            variant="outline"
            size="sm"
            className="mt-3 self-start"
            onPress={() => setVariants((prev) => [...prev, newVariantDraft()])}
          >
            <View className="flex-row items-center gap-1.5">
              <Plus size={14} color={colors.foreground} />
              <Text className="text-sm font-medium text-foreground">Add variant</Text>
            </View>
          </Button>
        </View>

        <View className="flex-row gap-3">
          <Button variant="outline" className="flex-1" onPress={() => router.back()}>
            <Text className="font-medium text-foreground">Cancel</Text>
          </Button>
          <Button className="flex-1" onPress={submit} isLoading={createProduct.isPending}>
            <Text className="font-semibold text-primary-foreground">Create product</Text>
          </Button>
        </View>
      </View>
    </Screen>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Label>{label}</Label>
      {children}
    </View>
  );
}
