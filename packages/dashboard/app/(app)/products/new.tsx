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
import { toast } from "@oxyhq/bloom/toast";
import { Screen } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useCreateProduct } from "@/lib/hooks/use-products";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { toMinorUnits } from "@/lib/money";

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
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("products.new.documentTitle")}</title>
      </Head>
      <RequireStore permission="products:write">
        {(storeId) => <NewProductBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function NewProductBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const createProduct = useCreateProduct(storeId);
  /**
   * The currency a catalog price is written in is the STORE's (#927).
   *
   * Not FAIR. The catalog stores NATIVE currency, and FAIR is a preferred
   * PRESENTMENT default — a different role. Writing FAIR here priced a EUR
   * store's catalogue in FairCoin at eight decimals instead of two, and it
   * was invisible on this screen because the read used FAIR too.
   */
  const { store } = useActiveStoreContext();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [vendor, setVendor] = useState("");
  const [optionName, setOptionName] = useState("");
  const [variants, setVariants] = useState<VariantDraft[]>([newVariantDraft()]);

  const updateVariant = (key: string, patch: Partial<VariantDraft>) => {
    setVariants((prev) => prev.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  };

  /**
   * `RequireStore` redirects when no active store resolves, so by the time
   * this body renders the store is present. Reading it through the optional
   * chain keeps that a narrowing rather than a `!` assertion, and the form —
   * and therefore the submit button — does not exist without it.
   */
  const currency = store?.defaultCurrency;

  const submit = () => {
    if (!title.trim()) {
      toast.error(t("products.new.titleRequired"));
      return;
    }
    if (!category.trim()) {
      toast.error(t("products.new.categoryRequired"));
      return;
    }

    // Unreachable while the guard above holds; it is here so the currency
    // can never be `undefined` at a write, rather than quietly becoming FAIR.
    if (!currency) return;

    const builtVariants: CreateStoreProductVariantInput[] = [];
    for (const v of variants) {
      const priceMinor = toMinorUnits(v.priceMajor, currency);
      if (priceMinor === null) {
        toast.error(t("products.new.variantPriceInvalid"));
        return;
      }
      const available = Number.parseInt(v.available || "0", 10);
      builtVariants.push({
        optionValues:
          optionName.trim() && v.title.trim()
            ? [{ name: optionName.trim(), value: v.title.trim() }]
            : [],
        price: { amount: priceMinor, currency },
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
        toast.success(t("products.new.created"));
        router.replace(`/products/${listing.id}`);
      },
      onError: () => toast.error(t("products.new.createFailed")),
    });
  };

  return (
    <Screen title={t("products.new.title")} subtitle={t("products.new.subtitle")}>
      <View className="gap-5">
        <Field label={t("common.title")}>
          <Input value={title} onChangeText={setTitle} placeholder={t("products.new.titlePlaceholder")} />
        </Field>
        <Field label={t("common.description")}>
          <Textarea
            value={description}
            onChangeText={setDescription}
            placeholder={t("products.new.descriptionPlaceholder")}
          />
        </Field>
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Field label={t("products.new.categoryLabel")}>
              <Input
                value={category}
                onChangeText={setCategory}
                placeholder={t("products.new.categoryPlaceholder")}
                autoCapitalize="none"
              />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={t("products.new.vendorLabel")}>
              <Input value={vendor} onChangeText={setVendor} placeholder={t("products.new.vendorPlaceholder")} />
            </Field>
          </View>
        </View>

        <View className="rounded-2xl border border-border bg-surface p-4">
          <Text className="mb-3 text-sm font-semibold text-foreground">
            {t("products.new.optionsHeading")}
          </Text>
          <Field label={t("products.new.optionNameLabel")}>
            <Input
              value={optionName}
              onChangeText={setOptionName}
              placeholder={t("products.new.optionNamePlaceholder")}
            />
          </Field>

          <View className="mt-4 gap-3">
            {variants.map((v, idx) => (
              <View key={v.key} className="rounded-xl border border-border p-3">
                <View className="mb-2 flex-row items-center justify-between">
                  <Text className="text-xs font-semibold text-muted-foreground">
                    {t("products.new.variantIndex", { index: idx + 1 })}
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
                    <Label>{t("products.new.optionValueLabel", { option: optionName.trim() })}</Label>
                    <Input
                      value={v.title}
                      onChangeText={(value) => updateVariant(v.key, { title: value })}
                      placeholder={t("products.new.optionValuePlaceholder")}
                    />
                  </View>
                ) : null}
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <Label>{t("products.priceLabel")}</Label>
                    <Input
                      value={v.priceMajor}
                      onChangeText={(value) => updateVariant(v.key, { priceMajor: value })}
                      placeholder="0.00"
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <View className="flex-1">
                    <Label>{t("products.stockLabel")}</Label>
                    <Input
                      value={v.available}
                      onChangeText={(value) => updateVariant(v.key, { available: value })}
                      placeholder="0"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                <View className="mt-2">
                  <Label>{t("products.new.skuLabel")}</Label>
                  <Input
                    value={v.sku}
                    onChangeText={(value) => updateVariant(v.key, { sku: value })}
                    placeholder={t("products.new.skuPlaceholder")}
                  />
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
              <Text className="text-sm font-medium text-foreground">{t("products.new.addVariant")}</Text>
            </View>
          </Button>
        </View>

        <View className="flex-row gap-3">
          <Button variant="outline" className="flex-1" onPress={() => router.back()}>
            <Text className="font-medium text-foreground">{t("common.cancel")}</Text>
          </Button>
          <Button className="flex-1" onPress={submit} isLoading={createProduct.isPending}>
            <Text className="font-semibold text-primary-foreground">{t("products.new.submit")}</Text>
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
