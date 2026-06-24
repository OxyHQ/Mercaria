import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Heart, Minus, Plus, Share2, Star } from "lucide-react-native";
import {
  DemandPill,
  MerchantHeader,
  OfferCard,
  PriceDisplay,
  ProductCarousel,
  ProductGallery,
  PurchaseOptions,
  RatingLine,
  ReviewSummaryCard,
  Text,
  VariantSwatches,
  formatMoney,
  formatReviewCount,
  type RatingDistribution,
  type ProductSummary,
} from "@mercaria/ui";
import type {
  Listing,
  ListingOption,
  MerchantSummary,
  ProductVariantDTO,
  Review,
  Seller,
} from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { Footer } from "@/components/shell/Footer";
import { useProduct, useProductReviews } from "@/lib/hooks/use-product";
import { useListings } from "@/lib/hooks/use-listings";
import { useAddCartItem } from "@/lib/hooks/use-cart";

/** Gold star fill (mirrors ReviewStars / MerchantCard constant). */
const STAR_COLOR = "#FFB800";
/** Lines of the description shown before "View more" expands it. */
const DESCRIPTION_CLAMP_LINES = 6;
/** Number of "More from store" related items pulled for the shelf. */
const RELATED_LIMIT = 12;
/** Reviews fetched for the summary + carousel. */
const REVIEW_PAGE_LIMIT = 12;
/** Icon size for the quantity stepper + action-row icons (px). */
const ICON_SIZE = 20;

/** Static "social proof" demand chip copy shown under the title (decorative). */
const DEMAND_COPY = "100K+ bought in past month";

/** Project a catalog `Listing` into the `ProductSummary` shape the cards consume. */
function toProductSummary(listing: Listing, brand: string): ProductSummary {
  const firstImage = listing.images[0];
  const summary: ProductSummary = {
    id: listing.id,
    title: listing.title,
    brand,
    imageUrl: firstImage?.fileId ?? "",
    rating: 0,
    reviewCount: 0,
    price: listing.price,
    saved: listing.saved,
  };
  if (listing.compareAtPrice) {
    summary.compareAtPrice = listing.compareAtPrice;
  }
  return summary;
}

/** The brand/seller label shown above the title (store vendor or seller name). */
function brandLabel(listing: Listing): string {
  if (listing.store) return listing.store.name;
  if (listing.seller) return listing.seller.displayName;
  return listing.vendor ?? "";
}

/**
 * Find the single variant matching a full set of chosen option values. Returns
 * undefined until every option has a selection (multi-option products).
 */
function matchVariant(
  variants: ProductVariantDTO[],
  options: ListingOption[],
  selection: Record<string, string>,
): ProductVariantDTO | undefined {
  if (options.length === 0) {
    return variants[0];
  }
  if (Object.keys(selection).length < options.length) {
    return undefined;
  }
  return variants.find((variant) =>
    variant.optionValues.every((ov) => selection[ov.name] === ov.value),
  );
}

/**
 * Build the initial option selection so the PDP opens with a buyable variant
 * pre-selected (matching the Shopify original). Picks the first in-stock variant
 * — falling back to the first variant when none are in stock — and projects its
 * `optionValues` into the `{ [optionName]: value }` selection shape. Returns an
 * empty selection for products with no options (single-variant / P2P), where the
 * sole variant is already resolved by `matchVariant`.
 */
function defaultSelection(
  variants: ProductVariantDTO[],
  options: ListingOption[],
): Record<string, string> {
  if (options.length === 0) {
    return {};
  }
  const variant = variants.find((v) => v.inStock) ?? variants[0];
  if (!variant) {
    return {};
  }
  return variant.optionValues.reduce<Record<string, string>>((acc, ov) => {
    acc[ov.name] = ov.value;
    return acc;
  }, {});
}

interface MerchantIdentity {
  name: string;
  logoUrl?: string;
  rating?: number;
  reviewCount?: number;
}

/** Resolve the merchant identity (store-first, then seller) shown in the headers. */
function merchantIdentity(listing: Listing): MerchantIdentity {
  const store: MerchantSummary | undefined = listing.store;
  const seller: Seller | undefined = listing.seller;
  const identity: MerchantIdentity = { name: brandLabel(listing) };
  const logoUrl = store?.logoUrl ?? seller?.avatar ?? undefined;
  if (logoUrl) identity.logoUrl = logoUrl;
  const rating = store?.rating ?? seller?.rating;
  if (rating !== undefined) identity.rating = rating;
  const reviewCount = store?.reviewCount ?? seller?.reviewCount;
  if (reviewCount !== undefined) identity.reviewCount = reviewCount;
  return identity;
}

interface RatingSummary {
  average: number;
  total: number;
  /** Count per star bucket, keyed 5..1. */
  distribution: RatingDistribution;
}

/** Derive the rating summary (avg, total, 5→1 distribution) from a review page. */
function summarizeReviews(reviews: Review[]): RatingSummary {
  const distribution: RatingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;
  for (const review of reviews) {
    const bucket = Math.round(review.rating);
    if (bucket >= 1 && bucket <= 5) {
      distribution[bucket] += 1;
    }
    sum += review.rating;
  }
  const total = reviews.length;
  return {
    average: total > 0 ? sum / total : 0,
    total,
    distribution,
  };
}

/** Inline store-link card (brand-bg cover + wordmark + footer name/rating). */
function StoreLinkCard({ store, onPress }: { store: MerchantSummary; onPress: () => void }) {
  const toneColor = store.textTone === "light" ? "#FFFFFF" : "#111111";
  return (
    <View
      className="overflow-hidden rounded-radius-28 web:shadow-sm"
      style={{ backgroundColor: store.brandColor }}
    >
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Visit ${store.name}`}
        onPress={onPress}
        className="relative h-[120px] items-center justify-center"
      >
        {store.coverImageUrl ? (
          <Image
            source={{ uri: store.coverImageUrl }}
            contentFit="cover"
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <LinearGradient
          pointerEvents="none"
          colors={["transparent", store.brandColor]}
          locations={[0.2, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {store.logoUrl ? (
          <Image
            source={{ uri: store.logoUrl }}
            contentFit="contain"
            style={{ height: 48, width: "60%", maxWidth: 220 }}
          />
        ) : (
          <Text numberOfLines={1} className="text-2xl font-bold" style={{ color: toneColor }}>
            {store.name}
          </Text>
        )}
      </Pressable>
      <View className="flex-row items-center justify-between p-space-16">
        <View>
          <Text numberOfLines={1} className="text-sm font-bold" style={{ color: toneColor }}>
            {store.name}
          </Text>
          <View className="mt-space-2 flex-row items-center gap-space-4">
            <Star size={11} color={STAR_COLOR} fill={STAR_COLOR} />
            <Text className="text-caption" style={{ color: toneColor }}>
              {`${store.rating} (${formatReviewCount(store.reviewCount)})`}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Follow ${store.name}`}
          onPress={onPress}
          className="rounded-radius-max bg-overlay-inverse-04 px-space-16 py-space-10 web:backdrop-blur-md"
        >
          <Text className="text-buttonLarge" style={{ color: toneColor }}>
            Follow
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** "More from <store>" related shelf, sourced from the same store's listings. */
function RelatedFromStore({ store, excludeId }: { store: MerchantSummary; excludeId: string }) {
  const router = useRouter();
  const { data } = useListings({ storeId: store.id, limit: RELATED_LIMIT });

  const items = useMemo(
    () =>
      (data?.data ?? [])
        .filter((listing) => listing.id !== excludeId)
        .map((listing) => toProductSummary(listing, store.name)),
    [data, excludeId, store.name],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <ProductCarousel
      title={`More from ${store.name}`}
      items={items}
      onPressItem={(id) => router.push(`/products/${id}` as Parameters<typeof router.push>[0])}
    />
  );
}

interface ProductBodyProps {
  listing: Listing;
}

/** The two-column PDP body (gallery + buy column) plus the full-width shelves. */
function ProductBody({ listing }: ProductBodyProps) {
  const router = useRouter();
  const addToCart = useAddCartItem();

  // Lifted reviews — fetched ONCE here, fed to both the title rating row and the
  // ReviewSummaryCard so the rating shown under the title matches the summary.
  const reviewsQuery = useProductReviews(listing.id, 1, REVIEW_PAGE_LIMIT);
  const reviews = useMemo(() => reviewsQuery.data?.data ?? [], [reviewsQuery.data]);
  const reviewSummary = useMemo(() => summarizeReviews(reviews), [reviews]);
  const reviewTotal = reviewsQuery.data?.pagination.total ?? reviewSummary.total;
  const hasReviews = reviewTotal > 0;

  const options = listing.options ?? [];
  const [selection, setSelection] = useState<Record<string, string>>(() =>
    defaultSelection(listing.variants, options),
  );
  const [quantity, setQuantity] = useState(1);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [saved, setSaved] = useState(listing.saved ?? false);

  const selectedVariant = useMemo(
    () => matchVariant(listing.variants, options, selection),
    [listing.variants, options, selection],
  );

  const activePrice = selectedVariant?.price ?? listing.price;
  const activeCompareAt = selectedVariant?.compareAtPrice ?? listing.compareAtPrice;
  const onSale = activeCompareAt !== undefined && activeCompareAt.amount > activePrice.amount;
  const discountPercent = onSale
    ? Math.round((1 - activePrice.amount / activeCompareAt.amount) * 100)
    : 0;

  const maxQuantity = selectedVariant?.available;
  const canAddToCart = selectedVariant !== undefined && selectedVariant.inStock;

  const images = useMemo(
    () => listing.images.map((image) => ({ uri: image.fileId, alt: image.alt })),
    [listing.images],
  );

  const identity = useMemo(() => merchantIdentity(listing), [listing]);

  const selectOption = (name: string, value: string) => {
    setSelection((prev) => ({ ...prev, [name]: value }));
    setQuantity(1);
  };

  const onPressStore = () => {
    if (listing.store?.handle) {
      router.push(`/stores/${listing.store.handle}` as Parameters<typeof router.push>[0]);
    }
  };

  const onAddToCart = () => {
    if (!selectedVariant) return;
    addToCart.mutate({
      listingId: listing.id,
      variantId: selectedVariant.id,
      quantity,
    });
  };

  const onBuyNow = () => {
    if (!selectedVariant) return;
    addToCart.mutate(
      { listingId: listing.id, variantId: selectedVariant.id, quantity },
      { onSuccess: () => router.push("/cart" as Parameters<typeof router.push>[0]) },
    );
  };

  const onPressOffer = () => {
    router.push("/cart" as Parameters<typeof router.push>[0]);
  };

  return (
    <View className="web:mx-auto web:w-full web:max-w-[1600px] md:px-5">
      <View className="flex-col gap-space-32 md:gap-space-40">
        {/* Top two-column region: large gallery (flex-1) + fixed buy column. */}
        <View className="flex-col gap-space-16 md:flex-row">
          <ProductGallery images={images} title={listing.title} />

          {/* Buy column. */}
          <View className="gap-space-24 md:w-[29em]">
            {/* Mobile sticky merchant bar. */}
            <View className="z-10 -mx-space-16 border-b border-border-secondary bg-bg px-space-16 py-space-12 web:sticky web:top-0 lg:hidden md:-mx-5 md:px-5">
              <MerchantHeader
                name={identity.name}
                logoUrl={identity.logoUrl}
                rating={identity.rating}
                reviewCount={identity.reviewCount}
                onPress={onPressStore}
                size="large"
              />
            </View>

            {/* Desktop buy-column merchant header. */}
            <View className="hidden lg:flex">
              <MerchantHeader
                name={identity.name}
                logoUrl={identity.logoUrl}
                rating={identity.rating}
                reviewCount={identity.reviewCount}
                onPress={onPressStore}
                size="compact"
              />
            </View>

            <Text className="text-headerBold text-text" numberOfLines={3}>
              {listing.title}
            </Text>

            {/* Rating row under the title — sourced from the lifted reviews. */}
            {hasReviews ? (
              <RatingLine rating={reviewSummary.average} count={reviewTotal} />
            ) : null}

            {/* Demand pill (static social proof). */}
            <DemandPill label={DEMAND_COPY} />

            {/* Price block. */}
            <View className="gap-space-4">
              {onSale ? (
                <View className="flex-row items-center gap-space-8">
                  <PriceDisplay price={activePrice} primaryClassName="text-bodyTitleLarge" />
                  <Text className="text-bodySmall text-text-tertiary line-through">
                    {formatMoney(activeCompareAt)}
                  </Text>
                  <View className="rounded-radius-max bg-bg-fill-inverse px-space-8 py-space-2">
                    <Text className="text-badgeBold text-text-inverse">
                      {`${discountPercent}% off`}
                    </Text>
                  </View>
                </View>
              ) : (
                <PriceDisplay price={activePrice} primaryClassName="text-bodyTitleLarge" />
              )}
            </View>

            {/* Exclusive-offer teaser card (static). */}
            <OfferCard
              label="Unlock exclusive pricing"
              caption="Sign in to view your exclusive offer"
              onPress={onPressOffer}
            />

            {/* Option selectors (color swatches / size pills). */}
            {options.map((option) => (
              <VariantSwatches
                key={option.name}
                option={option}
                variants={listing.variants}
                images={images}
                selectedValue={selection[option.name]}
                onSelect={(value) => selectOption(option.name, value)}
              />
            ))}

            {/* Quantity selector. */}
            <View className="gap-space-8">
              <Text className="text-captionBold text-text">Quantity</Text>
              <View className="h-space-40 flex-row items-center self-start rounded-radius-max border border-border-secondary bg-bg-fill p-space-8">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Decrease quantity"
                  disabled={quantity <= 1}
                  onPress={() => setQuantity((q) => Math.max(1, q - 1))}
                  className={`items-center justify-center px-space-4 ${quantity <= 1 ? "opacity-40" : ""}`}
                >
                  <Minus size={ICON_SIZE} className="text-text" />
                </Pressable>
                <Text className="min-w-[28px] text-center text-bodyTitleSmall text-text">
                  {quantity}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Increase quantity"
                  disabled={maxQuantity !== undefined && quantity >= maxQuantity}
                  onPress={() =>
                    setQuantity((q) =>
                      maxQuantity !== undefined ? Math.min(maxQuantity, q + 1) : q + 1,
                    )
                  }
                  className={`items-center justify-center px-space-4 ${
                    maxQuantity !== undefined && quantity >= maxQuantity ? "opacity-40" : ""
                  }`}
                >
                  <Plus size={ICON_SIZE} className="text-text" />
                </Pressable>
              </View>
            </View>

            {/* Purchase-type cards: one-time (real actions) + subscribe (decorative). */}
            <PurchaseOptions
              price={activePrice}
              canBuy={canAddToCart}
              isPending={addToCart.isPending}
              onAddToCart={onAddToCart}
              onBuyNow={onBuyNow}
            />

            {/* Save + Share. */}
            <View className="flex-row gap-space-8">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={saved ? "Remove from saved items" : "Save item"}
                onPress={() => setSaved((s) => !s)}
                className="flex-1 flex-row items-center justify-center gap-space-4 rounded-radius-max border border-border-secondary p-space-12"
              >
                <Heart
                  size={ICON_SIZE}
                  className="text-text"
                  fill={saved ? STAR_COLOR : "transparent"}
                />
                <Text className="text-buttonMedium text-text">
                  {saved ? "Saved" : "Save"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Share this product"
                className="flex-1 flex-row items-center justify-center gap-space-4 rounded-radius-max border border-border-secondary p-space-12"
              >
                <Share2 size={ICON_SIZE} className="text-text" />
                <Text className="text-buttonMedium text-text">Share</Text>
              </Pressable>
            </View>

            {/* Delivery & Returns (shipping hidden — Moovo not ready). */}
            <View className="gap-space-12 rounded-radius-28 border border-border-secondary bg-bg-fill p-space-20">
              <Text className="text-sectionTitle text-text">Delivery &amp; Returns</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View return policy"
                className="self-start rounded-radius-max bg-bg-fill-secondary px-space-16 py-space-8"
              >
                <Text className="text-buttonMedium text-text">Return policy</Text>
              </Pressable>
            </View>

            {/* Store link card. */}
            {listing.store ? (
              <StoreLinkCard store={listing.store} onPress={onPressStore} />
            ) : null}
          </View>
        </View>

        {/* Description + Reviews — full-width two-column block below the top region. */}
        <View className="flex-col gap-space-32 md:flex-row md:gap-[120px]">
          {/* Left column — description with the View more clamp. */}
          {listing.description ? (
            <View className="flex-1 gap-space-8">
              <Text className="text-sectionTitle text-text">Description</Text>
              <Text
                className="text-bodySmall text-text"
                numberOfLines={descriptionExpanded ? undefined : DESCRIPTION_CLAMP_LINES}
              >
                {listing.description}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={descriptionExpanded ? "View less" : "View more"}
                onPress={() => setDescriptionExpanded((e) => !e)}
                className="self-start"
              >
                <Text className="text-buttonMedium text-text-brand">
                  {descriptionExpanded ? "View less" : "View more"}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View className="flex-1" />
          )}

          {/* Right column — reviews (fed by the lifted query, no re-fetch). */}
          <View className="flex-1">
            <ReviewSummaryCard
              average={reviewSummary.average}
              total={reviewTotal}
              distribution={reviewSummary.distribution}
              reviews={reviews}
              isLoading={reviewsQuery.isLoading}
            />
          </View>
        </View>

        {/* Full-width related shelves. */}
        {listing.store ? (
          <RelatedFromStore store={listing.store} excludeId={listing.id} />
        ) : null}

        <Footer />
      </View>
    </View>
  );
}

/** Loading placeholder mirroring the two-column PDP rhythm. */
function ProductSkeleton() {
  return (
    <View
      className="web:mx-auto web:w-full web:max-w-[1600px] md:px-5"
      accessibilityLabel="Loading product"
    >
      <View className="flex-col gap-space-16 md:flex-row">
        <View className="aspect-square flex-1 rounded-radius-28 bg-bg-fill-hover" />
        <View className="gap-space-16 md:w-[29em]">
          <View className="h-8 w-40 rounded bg-bg-fill-hover" />
          <View className="h-7 w-3/4 rounded bg-bg-fill-hover" />
          <View className="h-6 w-28 rounded bg-bg-fill-hover" />
          <View className="h-12 w-full rounded-radius-max bg-bg-fill-hover" />
          <View className="h-12 w-full rounded-radius-max bg-bg-fill-hover" />
        </View>
      </View>
    </View>
  );
}

export default function ProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: listing, isLoading, isError } = useProduct(id ?? "");

  const head = (
    <Head>
      <title>{listing?.title ? `${listing.title} — Mercaria` : "Mercaria"}</title>
      {listing?.description ? (
        <meta name="description" content={listing.description.slice(0, 160)} />
      ) : null}
    </Head>
  );

  if (isLoading && !listing) {
    return (
      <ScreenShell>
        {head}
        <View className="pt-6">
          <ProductSkeleton />
        </View>
      </ScreenShell>
    );
  }

  if (isError || !listing) {
    return (
      <ScreenShell>
        {head}
        <View className="items-center justify-center px-8 py-16 web:min-h-screen">
          <Text className="text-center text-body text-text-tertiary">
            Couldn&apos;t load this product. Try again later.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell contentClassName="pt-6">
      {head}
      <ProductBody listing={listing} />
    </ScreenShell>
  );
}
