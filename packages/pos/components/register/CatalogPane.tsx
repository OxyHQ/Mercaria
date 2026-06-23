import React, { useCallback, useMemo, useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { useOxy } from "@oxyhq/services";
import { Barcode, Search } from "lucide-react-native";
import type { Listing, ProductVariantDTO } from "@mercaria/shared-types";
import { Text, Input, Button, useColorScheme } from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { useCatalog, useCategories, type CatalogFilters } from "@/lib/hooks/use-catalog";
import { lookupByCode } from "@/lib/api/catalog";
import { useRegisterCart, type RegisterCartLine } from "@/lib/stores/register-cart";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { ProductTile } from "./ProductTile";
import { VariantPickerSheet } from "./VariantPickerSheet";

/** Debounce (ms) for the catalog search box before refiring the query. */
const SEARCH_DEBOUNCE_MS = 300;

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

/**
 * Left pane of the register: a sticky search bar + SKU/barcode entry, a
 * horizontal category filter row, and a class-driven responsive product grid.
 * Owns the catalog query and the cart `addLine` action directly. Tapping a tile
 * adds the single variant or opens the variant picker when multiple in-stock
 * variants exist; scanning/entering a code looks the SKU up and adds it.
 */
export function CatalogPane({ storeId }: { storeId: string }) {
  const { colors } = useColorScheme();
  const { oxyServices } = useOxy();
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

  const resolveUri = useCallback(
    (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      if (value.startsWith("http")) return value;
      const url = oxyServices.getFileDownloadUrl(value, "thumb");
      return url && url.startsWith("http") ? url : undefined;
    },
    [oxyServices],
  );

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
      {/* Sticky search + SKU/barcode entry + category chips. */}
      <View className="z-10 gap-3 border-b border-border bg-background px-4 pb-3 pt-1 md:px-6 web:sticky web:top-0">
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

        {categories && categories.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 pr-4"
          >
            <CategoryChip
              label="All"
              active={category === ""}
              onPress={() => setCategory("")}
            />
            {categories.map((node) => (
              <CategoryChip
                key={node.id}
                label={node.name}
                active={category === node.slug}
                onPress={() => setCategory(node.slug)}
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {/* Responsive product grid (columns are class-driven, not numColumns). */}
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load the catalog" body="Please try again." />
      ) : listings.length === 0 ? (
        <ScreenMessage title="No products" body="Nothing matches your search." />
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="px-2 pb-28 pt-3 md:px-4 md:pb-8">
          <View className="flex-row flex-wrap">
            {listings.map((listing) => (
              <View
                key={listing.id}
                className="w-1/2 p-2 md:w-1/3 lg:w-1/4 xl:w-1/5"
              >
                <ProductTile
                  listing={listing}
                  imageUri={resolveUri(listing.images[0]?.fileId)}
                  onPress={() => addListing(listing)}
                />
              </View>
            ))}
          </View>
        </ScrollView>
      )}

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

function CategoryChip({
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
          : "h-10 items-center justify-center rounded-full border border-border bg-surface px-4 active:opacity-80 web:hover:border-primary"
      }
    >
      <Text
        numberOfLines={1}
        className={
          active
            ? "text-sm font-semibold text-primary-foreground"
            : "text-sm font-medium text-foreground"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}
