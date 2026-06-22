import React, { useCallback, useMemo, useState } from "react";
import { View, Pressable, ScrollView, FlatList } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { useOxy } from "@oxyhq/services";
import {
  Barcode,
  Minus,
  Plus,
  Search,
  Trash2,
  User as UserIcon,
  X,
} from "lucide-react-native";
import type { Listing, ProductVariantDTO } from "@mercaria/shared-types";
import {
  Text,
  Input,
  Button,
  PriceDisplay,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequirePos } from "@/components/shell/RequirePos";
import { useCatalog, useCategories, type CatalogFilters } from "@/lib/hooks/use-catalog";
import { lookupByCode } from "@/lib/api/catalog";
import {
  useRegisterCart,
  useRegisterCartCount,
  type RegisterCartLine,
} from "@/lib/stores/register-cart";
import { computeCartSubtotal } from "@/lib/cart-totals";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

/** Debounce (ms) for the catalog search box before refiring the query. */
const SEARCH_DEBOUNCE_MS = 300;

/** The register screen is store + register-location scoped. */
export default function RegisterScreen() {
  return (
    <>
      <Head>
        <title>Register | Mercaria POS</title>
      </Head>
      <RequirePos permission="draft_orders:write">
        {(storeId) => <Register storeId={storeId} />}
      </RequirePos>
    </>
  );
}

function Register({ storeId }: { storeId: string }) {
  const cartCount = useRegisterCartCount();

  return (
    <Screen
      title="Register"
      subtitle="Ring up an in-person sale"
      action={<StoreSwitcher />}
      scroll={false}
    >
      {/* Web: two columns (catalog left, cart right). Native/narrow: catalog with
          a sticky cart summary bar at the bottom. */}
      <View className="flex-1 md:flex-row md:gap-6">
        <View className="flex-1">
          <Catalog storeId={storeId} />
        </View>
        <View className="hidden w-[360px] md:flex">
          <CartPanel />
        </View>
      </View>

      {/* Native / narrow web: a compact cart summary bar that opens the cart. */}
      <View className="md:hidden">
        <MobileCartBar count={cartCount} />
      </View>
    </Screen>
  );
}

/** Map a listing image value to a renderable URL (http passthrough or resolve). */
function useImageUri() {
  const { oxyServices } = useOxy();
  return useCallback(
    (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      if (value.startsWith("http")) return value;
      const url = oxyServices.getFileDownloadUrl(value, "thumb");
      return url && url.startsWith("http") ? url : undefined;
    },
    [oxyServices],
  );
}

/** Build a register-cart line from a listing + one of its variants. */
function lineFromVariant(
  listing: Listing,
  variant: ProductVariantDTO,
): Omit<RegisterCartLine, "quantity"> {
  return {
    listingId: listing.id,
    variantId: variant.id,
    title: listing.title,
    variantTitle: variant.title,
    unitPrice: variant.price,
    available: variant.available,
    optionValues: variant.optionValues,
  };
}

function Catalog({ storeId }: { storeId: string }) {
  const { colors } = useColorScheme();
  const resolveUri = useImageUri();
  const addLine = useRegisterCart((s) => s.addLine);

  const [search, setSearch] = useState("");
  const [code, setCode] = useState("");
  const [category, setCategory] = useState("");
  const [pickerListing, setPickerListing] = useState<Listing | null>(null);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  const filters = useMemo<CatalogFilters>(
    () => ({ q: debouncedSearch, category, inStock: true }),
    [debouncedSearch, category],
  );

  const { data, isPending, isError } = useCatalog(storeId, filters);
  const { data: categories } = useCategories();

  const listings = data?.data ?? [];

  const addListing = useCallback(
    (listing: Listing) => {
      const inStockVariants = listing.variants.filter((v) => v.available > 0);
      if (listing.variants.length === 1) {
        const variant = listing.variants[0];
        if (variant.available <= 0) {
          toast.error("Out of stock");
          return;
        }
        addLine(lineFromVariant(listing, variant));
        return;
      }
      if (inStockVariants.length === 0) {
        toast.error("Out of stock");
        return;
      }
      setPickerListing(listing);
    },
    [addLine],
  );

  const onSubmitCode = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed === "") return;
    try {
      const match = await lookupByCode(storeId, trimmed);
      if (!match) {
        toast.error("No product for that code");
        return;
      }
      if (match.variant.available <= 0) {
        toast.error("Out of stock");
        return;
      }
      addLine(lineFromVariant(match.listing, match.variant));
      setCode("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Lookup failed";
      toast.error(message);
    }
  }, [code, storeId, addLine]);

  return (
    <View className="flex-1">
      {/* Search + SKU/barcode entry. */}
      <View className="gap-3">
        <View className="flex-row items-center gap-2 rounded-xl border border-border bg-surface px-3">
          <Search size={18} color={colors.mutedForeground} />
          <Input
            value={search}
            onChangeText={setSearch}
            placeholder="Search the catalog"
            className="h-12 flex-1 border-0 bg-transparent px-0"
          />
        </View>
        <View className="flex-row items-center gap-2">
          <View className="flex-1 flex-row items-center gap-2 rounded-xl border border-border bg-surface px-3">
            <Barcode size={18} color={colors.mutedForeground} />
            <Input
              value={code}
              onChangeText={setCode}
              placeholder="Scan or type SKU / barcode"
              autoCapitalize="none"
              onSubmitEditing={onSubmitCode}
              returnKeyType="done"
              className="h-12 flex-1 border-0 bg-transparent px-0"
            />
          </View>
          <Button onPress={onSubmitCode} className="h-12 px-5">
            <Text className="font-semibold text-primary-foreground">Add</Text>
          </Button>
        </View>
      </View>

      {/* Category filter pills. */}
      {categories && categories.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 py-3 pr-4"
        >
          <CategoryPill
            label="All"
            active={category === ""}
            onPress={() => setCategory("")}
          />
          {categories.map((node) => (
            <CategoryPill
              key={node.id}
              label={node.name}
              active={category === node.slug}
              onPress={() => setCategory(node.slug)}
            />
          ))}
        </ScrollView>
      ) : null}

      {/* Catalog grid. */}
      <View className="mt-1 flex-1">
        {isPending ? (
          <ScreenLoading />
        ) : isError ? (
          <ScreenMessage title="Couldn't load the catalog" body="Please try again." />
        ) : listings.length === 0 ? (
          <ScreenMessage title="No products" body="Nothing matches your search." />
        ) : (
          <FlatList
            data={listings}
            keyExtractor={(item) => item.id}
            numColumns={2}
            columnWrapperClassName="gap-3"
            contentContainerClassName="gap-3 pb-6"
            renderItem={({ item }) => (
              <CatalogTile
                listing={item}
                imageUri={resolveUri(item.images[0]?.fileId)}
                onPress={() => addListing(item)}
              />
            )}
          />
        )}
      </View>

      <VariantPickerSheet
        listing={pickerListing}
        onClose={() => setPickerListing(null)}
        onPick={(listing, variant) => {
          addLine(lineFromVariant(listing, variant));
          setPickerListing(null);
        }}
      />
    </View>
  );
}

function CategoryPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={
        active
          ? "h-10 items-center justify-center rounded-full bg-primary px-4"
          : "h-10 items-center justify-center rounded-full border border-border bg-surface px-4 active:opacity-80"
      }
    >
      <Text
        numberOfLines={1}
        className={active ? "text-sm font-semibold text-primary-foreground" : "text-sm font-medium text-foreground"}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function CatalogTile({
  listing,
  imageUri,
  onPress,
}: {
  listing: Listing;
  imageUri: string | undefined;
  onPress: () => void;
}) {
  const outOfStock = listing.quantity <= 0;
  return (
    <Pressable
      onPress={onPress}
      disabled={outOfStock}
      accessibilityRole="button"
      accessibilityLabel={listing.title}
      className="min-h-[200px] flex-1 overflow-hidden rounded-2xl border border-border bg-surface active:opacity-80 web:hover:border-primary"
    >
      <View className="aspect-square w-full bg-secondary">
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={{ width: "100%", height: "100%" }} contentFit="cover" transition={150} />
        ) : null}
      </View>
      <View className="gap-1 p-3">
        <Text numberOfLines={2} className="text-sm font-semibold text-foreground">
          {listing.title}
        </Text>
        <PriceDisplay price={listing.price} />
        <Text className="text-xs text-muted-foreground">
          {outOfStock ? "Out of stock" : `${listing.quantity} in stock`}
        </Text>
      </View>
    </Pressable>
  );
}

function VariantPickerSheet({
  listing,
  onClose,
  onPick,
}: {
  listing: Listing | null;
  onClose: () => void;
  onPick: (listing: Listing, variant: ProductVariantDTO) => void;
}) {
  return (
    <Sheet open={listing !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{listing?.title ?? "Choose a variant"}</SheetTitle>
        </SheetHeader>
        {listing ? (
          <ScrollView contentContainerClassName="gap-3 py-2">
            {listing.variants.map((variant) => {
              const disabled = variant.available <= 0;
              return (
                <Pressable
                  key={variant.id}
                  onPress={() => !disabled && onPick(listing, variant)}
                  disabled={disabled}
                  className={
                    disabled
                      ? "min-h-[64px] rounded-2xl border border-border bg-secondary p-4 opacity-50"
                      : "min-h-[64px] rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
                  }
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-base font-semibold text-foreground">{variant.title}</Text>
                      <Text className="text-xs text-muted-foreground">
                        {disabled ? "Out of stock" : `${variant.available} available`}
                      </Text>
                    </View>
                    <PriceDisplay price={variant.price} />
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CartPanel() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const lines = useRegisterCart((s) => s.lines);
  const discountCode = useRegisterCart((s) => s.discountCode);
  const customerId = useRegisterCart((s) => s.customerId);
  const setQuantity = useRegisterCart((s) => s.setQuantity);
  const removeLine = useRegisterCart((s) => s.removeLine);
  const setDiscountCode = useRegisterCart((s) => s.setDiscountCode);

  const subtotal = useMemo(() => computeCartSubtotal(lines), [lines]);
  const isEmpty = lines.length === 0;

  return (
    <View className="flex-1 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-lg font-bold text-foreground">Cart</Text>

      {isEmpty ? (
        <View className="flex-1 items-center justify-center py-12">
          <Text className="text-sm text-muted-foreground">No items yet</Text>
        </View>
      ) : (
        <ScrollView className="mt-3 flex-1" contentContainerClassName="gap-3">
          {lines.map((line) => (
            <View key={line.variantId} className="rounded-xl border border-border bg-background p-3">
              <View className="flex-row items-start justify-between gap-2">
                <View className="flex-1">
                  <Text numberOfLines={2} className="text-sm font-semibold text-foreground">
                    {line.title}
                  </Text>
                  <Text className="text-xs text-muted-foreground">{line.variantTitle}</Text>
                </View>
                <Pressable
                  onPress={() => removeLine(line.variantId)}
                  accessibilityRole="button"
                  accessibilityLabel="Remove item"
                  className="h-9 w-9 items-center justify-center rounded-lg active:bg-secondary"
                >
                  <X size={16} color={colors.mutedForeground} />
                </Pressable>
              </View>
              <View className="mt-2 flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <Pressable
                    onPress={() => setQuantity(line.variantId, line.quantity - 1)}
                    accessibilityRole="button"
                    accessibilityLabel="Decrease quantity"
                    className="h-9 w-9 items-center justify-center rounded-lg border border-border active:bg-secondary"
                  >
                    <Minus size={16} color={colors.foreground} />
                  </Pressable>
                  <Text className="min-w-[28px] text-center text-base font-semibold text-foreground">
                    {line.quantity}
                  </Text>
                  <Pressable
                    onPress={() => setQuantity(line.variantId, line.quantity + 1)}
                    disabled={line.quantity >= line.available}
                    accessibilityRole="button"
                    accessibilityLabel="Increase quantity"
                    className="h-9 w-9 items-center justify-center rounded-lg border border-border active:bg-secondary disabled:opacity-40"
                  >
                    <Plus size={16} color={colors.foreground} />
                  </Pressable>
                </View>
                <PriceDisplay price={line.unitPrice} />
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Discount + customer + charge. */}
      <View className="mt-3 gap-3 border-t border-border pt-3">
        <Input
          value={discountCode ?? ""}
          onChangeText={(text) => setDiscountCode(text.trim() === "" ? null : text)}
          placeholder="Discount code (optional)"
          autoCapitalize="characters"
          className="h-11"
        />
        <Pressable
          onPress={() => router.push("/customer")}
          accessibilityRole="button"
          className="h-11 flex-row items-center gap-2 rounded-xl border border-border px-3 active:opacity-80"
        >
          <UserIcon size={16} color={colors.mutedForeground} />
          <Text className="text-sm font-medium text-foreground">
            {customerId ? "Customer attached" : "Walk-in (add customer)"}
          </Text>
        </Pressable>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">Subtotal</Text>
          <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" />
        </View>
        <Button
          onPress={() => router.push("/charge")}
          disabled={isEmpty}
          className="h-14 disabled:opacity-40"
        >
          <Text className="text-base font-semibold text-primary-foreground">Charge</Text>
        </Button>
      </View>
    </View>
  );
}

/** Narrow / native cart summary bar that routes to the cart-driven charge. */
function MobileCartBar({ count }: { count: number }) {
  const router = useRouter();
  const lines = useRegisterCart((s) => s.lines);
  const subtotal = useMemo(() => computeCartSubtotal(lines), [lines]);

  if (count === 0) return null;

  return (
    <View className="border-t border-border bg-surface px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <View>
          <Text className="text-xs text-muted-foreground">{count} item{count === 1 ? "" : "s"}</Text>
          <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" />
        </View>
        <Button onPress={() => router.push("/charge")} className="h-12 flex-1">
          <Text className="text-base font-semibold text-primary-foreground">Charge</Text>
        </Button>
      </View>
    </View>
  );
}
