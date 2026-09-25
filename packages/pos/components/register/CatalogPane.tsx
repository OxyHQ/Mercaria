import React, { useCallback, useMemo, useState } from "react";
import { View, ScrollView } from "react-native";
import { useOxy } from "@oxy.so/services";
import { Barcode, Search } from "lucide-react-native";
import type { Listing, ProductVariantDTO } from "@mercaria/shared-types";
import { toBloomFieldIcon } from "@mercaria/ui";
import { TextField, TextFieldIcon, TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { Chip } from "@oxy.so/bloom/chip";
import { toast } from "@oxy.so/bloom/toast";
import { useDialogControl } from "@oxy.so/bloom/dialog";
import { ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { useCatalog, useCategories, type CatalogFilters } from "@/lib/hooks/use-catalog";
import { lookupByCode } from "@/lib/api/catalog";
import { useRegisterCart, type RegisterCartLine } from "@/lib/stores/register-cart";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useTranslation } from "@/lib/i18n";
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
  const { oxyServices } = useOxy();
  const { t } = useTranslation();
  const addLine = useRegisterCart((s) => s.addLine);

  const [search, setSearch] = useState("");
  const [code, setCode] = useState("");
  const [category, setCategory] = useState("");
  // Held until the sheet has finished closing (`onClosed`), so its title and
  // rows do not blank out under the exit animation.
  const [pickerListing, setPickerListing] = useState<Listing | null>(null);
  const pickerControl = useDialogControl();

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
          toast.error(t("catalog.outOfStock"));
          return;
        }
        addLine(lineFromVariant(listing, variant));
        return;
      }
      if (inStockVariants.length === 0) {
        toast.error(t("catalog.outOfStock"));
        return;
      }
      setPickerListing(listing);
      pickerControl.open();
    },
    [addLine, pickerControl, t],
  );

  const onSubmitCode = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed === "") return;
    try {
      const match = await lookupByCode(storeId, trimmed);
      if (!match) {
        toast.error(t("catalog.noProductForCode"));
        return;
      }
      if (match.variant.available <= 0) {
        toast.error(t("catalog.outOfStock"));
        return;
      }
      addLine(lineFromVariant(match.listing, match.variant));
      setCode("");
    } catch (error) {
      const message = error instanceof Error ? error.message : t("catalog.lookupFailed");
      toast.error(message);
    }
  }, [code, storeId, addLine, t]);

  return (
    <View className="flex-1">
      {/* Sticky search + SKU/barcode entry + category chips. */}
      <View className="z-10 gap-3 border-b border-border bg-background px-4 pb-3 pt-1 md:px-6 web:sticky web:top-0">
        <TextField style={{ height: 48 }}>
          <TextFieldIcon icon={toBloomFieldIcon(Search)} />
          <TextFieldInput
            label={t("catalog.searchPlaceholder")}
            value={search}
            onValueChange={setSearch}
          />
        </TextField>
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <TextField style={{ height: 48 }}>
              <TextFieldIcon icon={toBloomFieldIcon(Barcode)} />
              <TextFieldInput
                label={t("catalog.codePlaceholder")}
                value={code}
                onValueChange={setCode}
                autoCapitalize="none"
                onSubmitEditing={onSubmitCode}
                returnKeyType="done"
              />
            </TextField>
          </View>
          <Button
            tone="accent"
            size="lg"
            onPress={onSubmitCode}
            style={{ height: 48, paddingHorizontal: 20 }}
          >
            {t("catalog.add")}
          </Button>
        </View>

        {categories && categories.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 pe-4"
          >
            <CategoryChip
              label={t("common.all")}
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
        <ScreenMessage title={t("catalog.loadFailed")} body={t("common.pleaseTryAgain")} />
      ) : listings.length === 0 ? (
        <ScreenMessage title={t("catalog.emptyTitle")} body={t("catalog.emptyBody")} />
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
        control={pickerControl}
        listing={pickerListing}
        onClosed={() => setPickerListing(null)}
        onPick={(listing, variant) => {
          addLine(lineFromVariant(listing, variant));
          pickerControl.close();
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
    <Chip size="2xl" variant="outlined" selected={active} onPress={onPress}>
      {label}
    </Chip>
  );
}
