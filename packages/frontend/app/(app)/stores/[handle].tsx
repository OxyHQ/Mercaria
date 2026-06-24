import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { vars } from "nativewind";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronDown, Heart, Search, SlidersHorizontal } from "lucide-react-native";
import {
  DropdownMenu,
  Input,
  ProductCard,
  ReviewStars,
  SectionHeader,
  Switch,
  Text,
  formatReviewCount,
  type ProductSummary,
} from "@mercaria/ui";
import type { Listing, MerchantSummary } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { StoreMenuSheet } from "@/components/store/StoreMenuSheet";
import { storeThemeVars } from "@/lib/store-theme";
import { useStore, useStoreCollections } from "@/lib/hooks/use-store";
import { useListings } from "@/lib/hooks/use-listings";
import { useDebouncedCallback } from "@/lib/hooks/use-debounced-callback";
import { useWindowScrollY } from "@/lib/hooks/use-window-scroll";

/** Hero height (px) — full-bleed brand cover with the centered wordmark. */
const HERO_HEIGHT = 360;
/** Fraction of scroll the cover drifts at, vs the page — lower = more lag. */
const PARALLAX_FACTOR = 0.3;
/** Extra cover bleed (px) above the hero so the parallax drift never gaps. */
const PARALLAX_EXTRA = 140;
/** Capped wordmark height (px) inside the hero. */
const WORDMARK_HEIGHT = 92;
/** Light text tone over a brand-tinted surface (data-driven, mirrors MerchantCard). */
const TONE_LIGHT = "#FFFFFF";
/** Dark text tone over a brand-tinted surface (data-driven, mirrors MerchantCard). */
const TONE_DARK = "#111111";
/** Hex alpha suffix (~85%) for the glassy brand-tinted pill fills. */
const GLASS_ALPHA = "D9";
/** Fixed dark cover overlay (~25%) so the wordmark reads over any cover. */
const COVER_DARK_OVERLAY = "rgba(0,0,0,0.25)";
/** Gold star fill (mirrors MerchantCard / ReviewStars constant). */
const STAR_COLOR = "#FFB800";
/** Hero gradient stops: transparent at top → opaque brand at the bottom. */
const HERO_GRADIENT_LOCATIONS = [0.35, 1] as const;
/** Page size for the products grid (drives "Load more"). */
const PAGE_LIMIT = 24;
/** Debounce (ms) before a search keystroke commits to the listings query. */
const SEARCH_DEBOUNCE_MS = 300;
/** Loading-grid placeholder count. */
const SKELETON_TILE_COUNT = 8;

type SortValue = "best" | "newest" | "price_asc" | "price_desc";

const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: "best", label: "Best selling" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
];

/** Map the page's sort selection to the listings query's `sort` param. */
function toQuerySort(sort: SortValue): "newest" | "price_asc" | "price_desc" | undefined {
  if (sort === "best") return undefined;
  return sort;
}

/** Project a catalog `Listing` into the `ProductSummary` shape `ProductCard` consumes. */
function toProductSummary(listing: Listing, brand: string): ProductSummary {
  const firstImage = listing.images[0];
  return {
    id: listing.id,
    title: listing.title,
    brand,
    imageUrl: firstImage?.fileId ?? "",
    rating: 0,
    reviewCount: 0,
    price: listing.price,
    compareAtPrice: listing.compareAtPrice,
    saved: listing.saved,
  };
}

/** A glassy, brand-tinted translucent pill — the store page's signature affordance. */
function glassStyle(store: MerchantSummary) {
  return { backgroundColor: `${store.brandColor}${GLASS_ALPHA}` } as const;
}

/** A single collection pill: round image + title in a brand-tinted glassy chip. */
function CollectionPill({
  title,
  imageUrl,
  active,
  toneColor,
  store,
  onPress,
}: {
  title: string;
  imageUrl?: string;
  active: boolean;
  toneColor: string;
  store: MerchantSummary;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      className={`h-11 flex-row items-center gap-2 rounded-full border pl-1.5 pr-4 web:shadow-sm ${
        active ? "border-foreground" : "border-border"
      }`}
      style={glassStyle(store)}
    >
      {imageUrl ? (
        <View className="h-8 w-8 overflow-hidden rounded-full bg-secondary">
          <Image source={{ uri: imageUrl }} contentFit="cover" className="h-8 w-8 rounded-full" />
        </View>
      ) : null}
      <Text numberOfLines={1} className="text-sm font-semibold" style={{ color: toneColor }}>
        {title}
      </Text>
    </Pressable>
  );
}

/**
 * The hero cover image with a web scroll-linked parallax drift. It's a tiny
 * isolated subtree subscribing to {@link useWindowScrollY} so only the cover
 * re-renders per scroll frame (not the whole store body). The image is oversized
 * upward by {@link PARALLAX_EXTRA} and translates DOWN a fraction of the scroll,
 * so relative to the page it lags (parallax) while never revealing an edge
 * (top stays ≤ 0, bottom stays ≥ hero height). On native the offset is 0 — a
 * static, fully-covering hero.
 */
function ParallaxCover({ uri }: { uri: string }) {
  const scrollY = useWindowScrollY();
  const translateY = Math.min(scrollY * PARALLAX_FACTOR, PARALLAX_EXTRA);
  return (
    <Image
      source={{ uri }}
      contentFit="cover"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: -PARALLAX_EXTRA,
        height: HERO_HEIGHT + PARALLAX_EXTRA,
        transform: [{ translateY }],
      }}
    />
  );
}

/** Loading placeholder grid matching the products grid rhythm. */
function GridSkeleton() {
  return (
    <View className="flex-row flex-wrap" accessibilityLabel="Loading products">
      {Array.from({ length: SKELETON_TILE_COUNT }).map((_, i) => (
        <View key={i} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
          <View className="gap-2">
            <View className="aspect-square w-full rounded-2xl bg-muted" />
            <View className="h-3 w-1/2 rounded bg-muted" />
            <View className="h-3 w-3/4 rounded bg-muted" />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Body of the store page — only rendered once `store` is present. */
function StoreBody({ handle, store }: { handle: string; store: MerchantSummary }) {
  const router = useRouter();
  const toneColor = store.textTone === "light" ? TONE_LIGHT : TONE_DARK;
  // Scoped shadcn theme tokens derived from the store's palette. Applied to the
  // page wrapper so every shared component below (cards, inputs, pills, buttons)
  // renders in the merchant's brand palette without per-component edits.
  const themeVars = useMemo(
    () => vars(storeThemeVars(store.brandColor, store.textTone)),
    [store.brandColor, store.textTone],
  );
  const { data: collections } = useStoreCollections(handle);

  const onPressProduct = (id: string) => {
    router.push(`/products/${id}` as Parameters<typeof router.push>[0]);
  };

  const [followed, setFollowed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeCollectionId, setActiveCollectionId] = useState<string | undefined>(undefined);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortValue>("best");
  const [inStockOnly, setInStockOnly] = useState(false);
  const [page, setPage] = useState(1);

  const commitSearch = useDebouncedCallback((value: string) => {
    setQ(value);
    setPage(1);
  }, SEARCH_DEBOUNCE_MS);

  const onChangeSearch = (value: string) => {
    setSearchInput(value);
    commitSearch.run(value.trim());
  };

  const selectCollection = (id?: string) => {
    setActiveCollectionId(id);
    setPage(1);
  };

  const onSelectSort = (value: SortValue) => {
    setSort(value);
    setPage(1);
  };

  const onToggleInStock = (next: boolean) => {
    setInStockOnly(next);
    setPage(1);
  };

  const { data, isLoading, isError } = useListings({
    storeId: store.id,
    collectionId: activeCollectionId,
    q: q || undefined,
    sort: toQuerySort(sort),
    inStock: inStockOnly ? true : undefined,
    page,
    limit: PAGE_LIMIT,
  });

  const products = useMemo(
    () => (data?.data ?? []).map((listing) => toProductSummary(listing, store.name)),
    [data, store.name],
  );

  const publishedCollections = useMemo(
    () => (collections ?? []).filter((c) => c.isPublished),
    [collections],
  );

  const hasNextPage = data?.pagination.hasNextPage ?? false;
  const activeSortLabel =
    SORT_OPTIONS.find((o) => o.value === sort)?.label ?? SORT_OPTIONS[0].label;

  return (
    // Scopes the store's brand palette to the whole page via `themeVars` (the
    // shadcn theme tokens are remapped so `bg-background` is the brand color,
    // `bg-card`/`bg-secondary` become glassy translucent fills, and text tokens
    // take the store's tone). Every shared component below inherits the palette.
    // The enclosing `ScreenShell` paints the brand color across the full panel
    // (incl. its `pb-24` and rounded bottom) via `surfaceStyle`, so no surface
    // peeks below the hero — this wrapper only carries the themed token scope.
    <View style={themeVars}>
      {/* ---- Hero ---- */}
      <View className="relative w-full overflow-hidden" style={{ height: HERO_HEIGHT }}>
        {store.coverImageUrl ? <ParallaxCover uri={store.coverImageUrl} /> : null}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: COVER_DARK_OVERLAY }]} />
        {/* Brand-color scrim fading up from the bottom into the page tint. */}
        <LinearGradient
          pointerEvents="none"
          colors={["transparent", store.brandColor]}
          locations={HERO_GRADIENT_LOCATIONS}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />

        {/* Top-left store identity (glassy) — opens the store menu sheet. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${store.name} menu`}
          onPress={() => setMenuOpen(true)}
          className="absolute left-4 top-4 flex-row items-center gap-2 rounded-full border border-white/30 px-3 py-2 web:shadow"
          style={glassStyle(store)}
        >
          {store.logoUrl ? (
            <Image
              source={{ uri: store.logoUrl }}
              contentFit="contain"
              style={{ width: 22, height: 22 }}
            />
          ) : null}
          <Text numberOfLines={1} className="text-sm font-bold" style={{ color: toneColor }}>
            {store.name}
          </Text>
        </Pressable>

        {/* Top-right glassy "Follow" toggle (visual only). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={followed ? `Following ${store.name}` : `Follow ${store.name}`}
          onPress={() => setFollowed((f) => !f)}
          className="absolute right-4 top-4 flex-row items-center gap-1.5 rounded-full border border-white/30 px-4 py-2 web:shadow"
          style={glassStyle(store)}
        >
          <Heart
            size={15}
            color={toneColor}
            fill={followed ? toneColor : "transparent"}
          />
          <Text className="text-sm font-semibold" style={{ color: toneColor }}>
            {followed ? "Following" : "Follow"}
          </Text>
        </Pressable>

        {/* Centered wordmark + rating. */}
        <View className="absolute inset-x-0 bottom-6 items-center px-6">
          {store.logoUrl ? (
            <Image
              source={{ uri: store.logoUrl }}
              contentFit="contain"
              style={{ height: WORDMARK_HEIGHT, width: "70%", maxWidth: 320 }}
            />
          ) : (
            <Text
              numberOfLines={2}
              className="text-center text-4xl font-bold"
              style={{ color: toneColor }}
            >
              {store.name}
            </Text>
          )}
          <View className="mt-3 flex-row items-center gap-2">
            <ReviewStars rating={store.rating} count={store.reviewCount} size={16} />
            <Text className="text-sm font-semibold" style={{ color: toneColor }}>
              {`${store.rating} (${formatReviewCount(store.reviewCount)})`}
            </Text>
          </View>
        </View>
      </View>

      {/* Content panel: sits on the brand-tinted page surface; the hero gradient
          fades into it. Cards/pills below use the glassy themed tokens. */}
      <View className="rounded-t-3xl bg-background pt-5">
        {/* ---- Collection pills ---- */}
        {publishedCollections.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
            className="mb-6"
          >
            <CollectionPill
              title="Shop all"
              active={activeCollectionId === undefined}
              toneColor={toneColor}
              store={store}
              onPress={() => selectCollection(undefined)}
            />
            {publishedCollections.map((collection) => (
              <CollectionPill
                key={collection.id}
                title={collection.title}
                imageUrl={collection.imageUrl}
                active={activeCollectionId === collection.id}
                toneColor={toneColor}
                store={store}
                onPress={() => selectCollection(collection.id)}
              />
            ))}
          </ScrollView>
        ) : null}

        {/* ---- Collection tiles grid ---- */}
        {publishedCollections.length > 0 ? (
          <View className="mb-8">
            <SectionHeader title="Collections" />
            <View className="flex-row flex-wrap px-2">
              {publishedCollections.map((collection) => {
                const isActive = activeCollectionId === collection.id;
                return (
                  <View key={collection.id} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={collection.title}
                      onPress={() => selectCollection(isActive ? undefined : collection.id)}
                      className={`group overflow-hidden rounded-2xl border bg-secondary web:shadow-sm web:transition-transform web:duration-300 web:hover:-translate-y-1 ${
                        isActive ? "border-foreground" : "border-border"
                      }`}
                    >
                      <View className="relative aspect-[4/3] w-full">
                        {collection.imageUrl ? (
                          <Image
                            source={{ uri: collection.imageUrl }}
                            contentFit="cover"
                            style={StyleSheet.absoluteFill}
                            className="web:transition-transform web:duration-300 web:group-hover:scale-105"
                          />
                        ) : null}
                        <View
                          pointerEvents="none"
                          style={[StyleSheet.absoluteFill, { backgroundColor: COVER_DARK_OVERLAY }]}
                        />
                        <View className="absolute inset-x-0 bottom-0 p-3">
                          <Text
                            numberOfLines={1}
                            className="text-sm font-bold"
                            style={{ color: TONE_LIGHT }}
                          >
                            {collection.title}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}

        {/* ---- Products section ---- */}
        <SectionHeader title="Products" />

        {/* Search input */}
        <View className="mb-3 px-4">
          <View className="relative">
            <View className="absolute left-3 top-0 bottom-0 z-10 justify-center">
              <Search size={16} className="text-muted-foreground" />
            </View>
            <Input
              value={searchInput}
              onChangeText={onChangeSearch}
              placeholder={`Search ${store.name}…`}
              className="h-11 rounded-full bg-secondary pl-9"
              returnKeyType="search"
            />
          </View>
        </View>

        {/* Filter bar: Sort dropdown + In-stock toggle */}
        <View className="mb-4 flex-row flex-wrap items-center gap-3 px-4">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sort products"
                className="h-10 flex-row items-center gap-2 rounded-full border border-border bg-secondary px-4"
              >
                <SlidersHorizontal size={15} className="text-foreground" />
                <Text className="text-sm font-medium text-foreground">{activeSortLabel}</Text>
                <ChevronDown size={16} className="text-muted-foreground" />
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {SORT_OPTIONS.map((option) => (
                <DropdownMenu.CheckboxItem
                  key={option.value}
                  value={sort === option.value ? "on" : "off"}
                  onValueChange={() => onSelectSort(option.value)}
                >
                  <DropdownMenu.ItemIndicator />
                  <DropdownMenu.ItemTitle>{option.label}</DropdownMenu.ItemTitle>
                </DropdownMenu.CheckboxItem>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <View className="h-10 flex-row items-center gap-2 rounded-full border border-border bg-secondary px-4">
            <Text className="text-sm font-medium text-foreground">In stock</Text>
            <Switch value={inStockOnly} onValueChange={onToggleInStock} />
          </View>
        </View>

        {/* Products grid */}
        {isLoading && !data ? <GridSkeleton /> : null}

        {isError && !data ? (
          <View className="items-center px-8 py-16">
            <Text className="text-center text-base text-muted-foreground">
              Couldn&apos;t load products. Pull to refresh or try again.
            </Text>
          </View>
        ) : null}

        {!isLoading && products.length === 0 && !isError ? (
          <View className="items-center px-8 py-16">
            <Text className="text-center text-base text-muted-foreground">
              No products match your filters.
            </Text>
          </View>
        ) : null}

        {products.length > 0 ? (
          <View className="flex-row flex-wrap px-2">
            {products.map((product) => (
              <View key={product.id} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
                <ProductCard product={product} onPress={onPressProduct} />
              </View>
            ))}
          </View>
        ) : null}

        {/* Load more */}
        {hasNextPage ? (
          <View className="items-center px-4 py-6">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Load more products"
              onPress={() => setPage((p) => p + 1)}
              className="rounded-full border border-border bg-secondary px-6 py-3 web:shadow-sm"
            >
              <Text className="text-sm font-semibold text-foreground">Load more</Text>
            </Pressable>
          </View>
        ) : null}

        <View className="h-24" />
      </View>

      {/* Store-menu side-sheet (Shopify-style), opened from the hero chip. */}
      <StoreMenuSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        store={store}
        collections={publishedCollections}
        onSelectCollection={(id) => {
          selectCollection(id);
          setMenuOpen(false);
        }}
        followed={followed}
        onToggleFollow={() => setFollowed((f) => !f)}
      />
    </View>
  );
}

export default function StoreScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const { data, isLoading, isError } = useStore(handle ?? "");

  const head = (
    <Head>
      <title>{data?.store.name ? `${data.store.name} — Mercaria` : "Mercaria"}</title>
    </Head>
  );

  // Loading / error states render inside the shell on the default `bg-card`
  // surface (they predate brand color). The loaded body paints its own
  // brand-colored full-height surface, so its shell surface is transparent.
  if (isLoading && !data) {
    return (
      <ScreenShell>
        {head}
        <View className="w-full bg-muted" style={{ height: HERO_HEIGHT }} />
        <View className="pt-5">
          <GridSkeleton />
        </View>
      </ScreenShell>
    );
  }

  if (isError || !data) {
    return (
      <ScreenShell>
        {head}
        <View className="items-center justify-center px-8 py-16 web:min-h-screen">
          <Text className="text-center text-base text-muted-foreground">
            Couldn&apos;t load this store. Try again later.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell
      surfaceClassName="bg-transparent"
      surfaceStyle={{ backgroundColor: data.store.brandColor }}
    >
      {head}
      <StoreBody handle={handle ?? ""} store={data.store} />
    </ScreenShell>
  );
}
