import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Heart, Minus, Plus, Share2, Star } from "lucide-react-native";
import {
  CommercialDisclosure,
  ConditionBadge,
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
  useFormatters,
  type RatingDistribution,
  type ProductSummary,
} from "@mercaria/ui";
import type {
  Listing,
  ListingOption,
  StoreSummary,
  ProductVariantDTO,
  Review,
  Seller,
} from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { Footer } from "@/components/shell/Footer";
import { StoreFollowButton } from "@/components/store/StoreFollowButton";
import { SellerLinkCard } from "@/components/seller/SellerLinkCard";
import { useProduct, useProductReviews } from "@/lib/hooks/use-product";
import { REVIEW_SCOPE_HEADING_KEYS, useProductScopeReviews } from "@/lib/hooks/use-reviews";
import { useListings } from "@/lib/hooks/use-listings";
import { useAddCartItem } from "@/lib/hooks/use-cart";
import {
  useListingSaveContext,
  useToggleListingSave,
  useToggleProductSave,
} from "@/lib/hooks/use-saves";
import { useTranslation } from "@/lib/i18n";

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

/**
 * Static "social proof" demand chip copy shown under the title (decorative).
 *
 * The KEY rather than the sentence: this module-scope constant is evaluated at
 * import, before the locale store has rehydrated, so holding the English here
 * would freeze whichever language happened to load first.
 */
const DEMAND_COPY_KEY = "product.demandCopy";

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
  const store: StoreSummary | undefined = listing.store;
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

/**
 * The 5→1 bucket counts of a review PAGE.
 *
 * Split out from {@link summarizeReviews} for the scoped surfaces, whose average
 * and total come from the server aggregate: the distribution bars describe the
 * reviews actually on screen, which is what a reader can scroll to, while the
 * headline figure describes every review there is. Mixing the two sources is
 * deliberate and stated rather than accidental.
 */
function distributionOf(reviews: Review[]): RatingDistribution {
  const distribution: RatingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const review of reviews) {
    const bucket = Math.round(review.rating);
    if (bucket >= 1 && bucket <= 5) {
      distribution[bucket] += 1;
    }
  }
  return distribution;
}

/** Inline store-link card (brand-bg cover + wordmark + footer name/rating). */
function StoreLinkCard({ store, onPress }: { store: StoreSummary; onPress: () => void }) {
  const { t } = useTranslation();
  const { formatReviewCount } = useFormatters();
  const toneColor = store.textTone === "light" ? "#FFFFFF" : "#111111";
  return (
    <View
      className="overflow-hidden rounded-radius-28 web:shadow-sm"
      style={{ backgroundColor: store.brandColor }}
    >
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t("product.visitA11y", { name: store.name })}
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
        <StoreFollowButton store={store} size="small" />
      </View>
    </View>
  );
}

/** "More from <store>" related shelf, sourced from the same store's listings. */
function RelatedFromStore({ store, excludeId }: { store: StoreSummary; excludeId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
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
      title={t("product.moreFromStore", { name: store.name })}
      items={items}
      onPressItem={(id) => router.push(`/products/${id}`)}
    />
  );
}

interface ProductBodyProps {
  listing: Listing;
}

/** The two-column PDP body (gallery + buy column) plus the full-width shelves. */
function ProductBody({ listing }: ProductBodyProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const addToCart = useAddCartItem();

  /**
   * TWO review surfaces, because they answer two different questions (#76).
   *
   *  - the PRODUCT reviews of the canonical product this listing resolves to,
   *    when it resolves to one. Their aggregate comes from the SERVER, not from
   *    the page: averaging the twelve reviews that happened to arrive is what
   *    this page did before #76, and page one of twelve is not the rating.
   *  - this LISTING's own feedback — condition and description accuracy — which
   *    is never presented as product quality (#76 UI rule 5).
   *
   * Neither is folded into the other, and neither is shown without a label
   * naming what it is about (rule 6).
   */
  const productReviewsQuery = useProductScopeReviews(
    listing.canonicalProductId,
    1,
    REVIEW_PAGE_LIMIT,
  );
  const productAggregate = productReviewsQuery.data?.aggregate;
  const productReviews = useMemo(
    () => productReviewsQuery.data?.data ?? [],
    [productReviewsQuery.data],
  );
  const productDistribution = useMemo(
    () => distributionOf(productReviews),
    [productReviews],
  );
  const hasProductReviews = (productAggregate?.reviewCount ?? 0) > 0;

  const listingReviewsQuery = useProductReviews(listing.id, 1, REVIEW_PAGE_LIMIT);
  const listingReviews = useMemo(
    () => listingReviewsQuery.data?.data ?? [],
    [listingReviewsQuery.data],
  );
  const listingSummary = useMemo(() => summarizeReviews(listingReviews), [listingReviews]);
  const listingReviewTotal = listingReviewsQuery.data?.pagination.total ?? listingSummary.total;
  const hasListingReviews = listingReviewTotal > 0;

  const options = listing.options ?? [];
  const [selection, setSelection] = useState<Record<string, string>>(() =>
    defaultSelection(listing.variants, options),
  );
  const [quantity, setQuantity] = useState(1);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  /**
   * The two save controls (#80 listing rules).
   *
   * The state is SERVER state, not `useState`: a save is stored under the Oxy
   * account and is visible from every device, so a local boolean seeded from the
   * listing DTO would disagree with the saved list the moment either changed.
   * The context read also answers whether this listing HAS a canonical product,
   * which decides whether there is one button here or two.
   */
  const saveContext = useListingSaveContext(listing.id);
  const toggleProductSave = useToggleProductSave();
  const toggleListingSave = useToggleListingSave();
  const canonicalProductId = saveContext.data?.canonicalProductId;
  const productSaved = saveContext.data?.productSaved ?? false;
  const listingSaved = saveContext.data?.listingSaved ?? false;

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
      router.push(`/stores/${listing.store.handle}`);
    }
  };

  // Keyed on the OXY ACCOUNT ID, never on the handle: a handle can change and a
  // renamed seller's every inbound link would 404, while the account id never
  // moves. Same reasoning as the follow target's URI.
  const onPressSeller = () => {
    if (listing.seller?.oxyUserId) {
      router.push(`/sellers/${encodeURIComponent(listing.seller.oxyUserId)}`);
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
      { onSuccess: () => router.push("/cart") },
    );
  };

  const onPressOffer = () => {
    router.push("/cart");
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

            {/*
              The rating row under the title is the PRODUCT rating, and it says
              so. It appears only when this listing resolves to a canonical
              product with reviews — a listing's own condition feedback belongs
              further down under its own heading, and putting it here would make
              "arrived scratched" read as the model's quality score.
            */}
            {hasProductReviews && productAggregate ? (
              <RatingLine
                rating={productAggregate.rating}
                count={productAggregate.reviewCount}
                scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.product)}
              />
            ) : null}

            {/*
              The item's condition (#90), directly under the title and above the
              price — a shopper deciding whether 40 € is a good price needs to
              know whether they are looking at a sealed unit or a for-parts
              shell, and finding that out after the price is finding it out too
              late. Text and neutral chrome, never colour alone (policy rule 3).
            */}
            <ConditionBadge condition={listing.itemCondition} showExplanation />

            {/*
              The way through to the CANONICAL product page (#71).

              Shown only when this listing resolves to a canonical product,
              because that page is about the MODEL and this one is about one
              seller's copy of it: a link offered on an unmatched P2P listing
              would lead to a page that does not exist for it. #75 owns the full
              public-route migration; this is the entry point that makes the
              comparison reachable in the meantime, and `/products/:id` keeps
              working exactly as it does (#71 acceptance 7).
            */}
            {listing.canonicalProductId ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={t("product.compareOffersA11y")}
                onPress={() =>
                  router.push(`/p/${encodeURIComponent(listing.canonicalProductId ?? '')}`)
                }
                className="self-start rounded-radius-max border border-border-secondary px-space-16 py-space-8"
              >
                <Text className="text-buttonMedium text-text">
                  {t("product.compareOffers")}
                </Text>
              </Pressable>
            ) : null}

            {/*
              WHO is selling this configuration (#129 acceptance 1), above the
              price and above every buy affordance — a shopper deciding whether
              to press Buy needs to know whether Mercaria, a merchant or another
              retailer is on the other side of it, and finding that out at
              checkout is finding it out too late.

              It hangs off the SELECTED VARIANT rather than the listing because
              that is where the fact lives: a retail binding is keyed on
              `product_variant_id`, so switching a swatch can legitimately
              change the seller. Nothing renders when the server did not answer
              — an unstated disclosure is a surface that has not resolved the
              question, and defaulting it to the catalogue owner is the
              mislabelling this component exists to prevent.
            */}
            {selectedVariant?.commercial ? (
              <CommercialDisclosure presentation={selectedVariant.commercial} showExplanations />
            ) : null}

            {/* Demand pill (static social proof). */}
            <DemandPill label={t(DEMAND_COPY_KEY)} />

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
                      {t("product.percentOff", { percent: discountPercent })}
                    </Text>
                  </View>
                </View>
              ) : (
                <PriceDisplay price={activePrice} primaryClassName="text-bodyTitleLarge" />
              )}
            </View>

            {/* Exclusive-offer teaser card (static). */}
            <OfferCard
              label={t("product.exclusiveOffer.label")}
              caption={t("product.exclusiveOffer.caption")}
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
              <Text className="text-captionBold text-text">{t("product.quantity")}</Text>
              <View className="h-space-40 flex-row items-center self-start rounded-radius-max border border-border-secondary bg-bg-fill p-space-8">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("product.decreaseQuantity")}
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
                  accessibilityLabel={t("product.increaseQuantity")}
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

            {/*
              Add-to-cart had NO error surface at all: signed out, the button was
              enabled, the request 401'd and the page said nothing (#104). The
              button now works for a guest too, so the remaining failures are real
              ones — out of stock, offline, guest carts switched off — and each of
              them has to reach the buyer rather than vanish.
            */}
            {addToCart.isError ? (
              <Text
                accessibilityRole="alert"
                className="mt-space-8 text-sm font-medium text-destructive"
              >
                {addToCart.error.message}
              </Text>
            ) : null}

            {/*
              Save + Share (#80).

              `Save product` and `Save this listing` are DIFFERENT controls and
              are never collapsed: the first follows the model across every
              seller, the second keeps this exact item — which is what a buyer
              means about a handmade piece or a used copy whose photographs are
              the reason they saved it. The product button appears only when
              this listing HAS a confident canonical mapping; an unmatched P2P
              listing shows the listing button alone, which is #80 listing rules
              1 and 2 rendered rather than described.
            */}
            <View className="gap-space-8">
              {canonicalProductId ? (
                <View className="flex-row gap-space-8">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      productSaved
                        ? t("product.save.removeProductA11y")
                        : t("product.save.productA11y")
                    }
                    onPress={() =>
                      toggleProductSave.mutate({
                        canonicalProductId,
                        saved: productSaved,
                        sourceContext: "listing_page",
                        listingId: listing.id,
                      })
                    }
                    className="flex-1 flex-row items-center justify-center gap-space-4 rounded-radius-max border border-border-secondary p-space-12"
                  >
                    <Heart
                      size={ICON_SIZE}
                      className="text-text"
                      fill={productSaved ? STAR_COLOR : "transparent"}
                    />
                    <Text className="text-buttonMedium text-text">
                      {productSaved ? t("product.save.productSaved") : t("product.save.product")}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      listingSaved
                        ? t("product.save.removeListingA11y")
                        : t("product.save.exactListingA11y")
                    }
                    onPress={() =>
                      toggleListingSave.mutate({
                        listingId: listing.id,
                        saved: listingSaved,
                        // A buyer choosing THIS control while the product
                        // button sits beside it has said the exact listing is
                        // what they mean — which is exactly what a pin records,
                        // and what the migration then leaves alone.
                        pin: true,
                      })
                    }
                    className="flex-1 flex-row items-center justify-center gap-space-4 rounded-radius-max border border-border-secondary p-space-12"
                  >
                    <Text className="text-buttonMedium text-text">
                      {listingSaved ? t("product.save.listingSaved") : t("product.save.listing")}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    listingSaved ? t("product.save.removeListingA11y") : t("product.save.listing")
                  }
                  onPress={() =>
                    toggleListingSave.mutate({ listingId: listing.id, saved: listingSaved })
                  }
                  className="flex-row items-center justify-center gap-space-4 rounded-radius-max border border-border-secondary p-space-12"
                >
                  <Heart
                    size={ICON_SIZE}
                    className="text-text"
                    fill={listingSaved ? STAR_COLOR : "transparent"}
                  />
                  <Text className="text-buttonMedium text-text">
                    {listingSaved ? t("product.save.saved") : t("product.save.save")}
                  </Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("product.shareA11y")}
                className="flex-row items-center justify-center gap-space-4 rounded-radius-max border border-border-secondary p-space-12"
              >
                <Share2 size={ICON_SIZE} className="text-text" />
                <Text className="text-buttonMedium text-text">{t("product.share")}</Text>
              </Pressable>
            </View>

            {/* Delivery & Returns (shipping hidden — Moovo not ready). */}
            <View className="gap-space-12 rounded-radius-28 border border-border-secondary bg-bg-fill p-space-20">
              <Text className="text-sectionTitle text-text">
                {t("product.deliveryAndReturns")}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("product.viewReturnPolicyA11y")}
                className="self-start rounded-radius-max bg-bg-fill-secondary px-space-16 py-space-8"
              >
                <Text className="text-buttonMedium text-text">{t("product.returnPolicy")}</Text>
              </Pressable>
            </View>

            {/* Store link card. */}
            {listing.store ? (
              <StoreLinkCard store={listing.store} onPress={onPressStore} />
            ) : null}

            {/* Seller link card (#92). Mutually exclusive with the store card
                by `listings_owner_exclusivity_check`, and deliberately a
                SEPARATE component rather than a generalised one: a store is
                followed as `mercaria.store` and a person as `oxy.user`, and one
                control serving both would be one edit from registering a human
                being under a marketplace's namespace (#26). */}
            {listing.seller ? (
              <SellerLinkCard seller={listing.seller} onPress={onPressSeller} />
            ) : null}
          </View>
        </View>

        {/* Description + Reviews — full-width two-column block below the top region. */}
        <View className="flex-col gap-space-32 md:flex-row md:gap-[120px]">
          {/* Left column — description with the View more clamp. */}
          {listing.description ? (
            <View className="flex-1 gap-space-8">
              <Text className="text-sectionTitle text-text">{t("product.description")}</Text>
              <Text
                className="text-bodySmall text-text"
                numberOfLines={descriptionExpanded ? undefined : DESCRIPTION_CLAMP_LINES}
              >
                {listing.description}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  descriptionExpanded ? t("product.viewLess") : t("product.viewMore")
                }
                onPress={() => setDescriptionExpanded((e) => !e)}
                className="self-start"
              >
                <Text className="text-buttonMedium text-text-brand">
                  {descriptionExpanded ? t("product.viewLess") : t("product.viewMore")}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View className="flex-1" />
          )}

          {/* Right column — the two review surfaces, stacked and each labelled. */}
          <View className="flex-1 gap-space-16">
            {listing.canonicalProductId ? (
              <ReviewSummaryCard
                scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.product)}
                average={productAggregate?.rating ?? 0}
                total={productAggregate?.reviewCount ?? 0}
                distribution={productDistribution}
                reviews={productReviews}
                isLoading={productReviewsQuery.isLoading}
                {...(productAggregate ? { unverified: productAggregate.unverified } : {})}
              />
            ) : null}

            {/*
              This listing's own feedback. The heading is `Item condition and
              description` for a used item — never "Product reviews" — because a
              scuff on one seller's copy is a fact about that copy (#76 UI rule
              5). A new item's listing feedback carries the same scope and the
              same heading, for the same reason: it describes THIS listing.
            */}
            {hasListingReviews || !listing.canonicalProductId ? (
              <ReviewSummaryCard
                scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.p2p_listing)}
                average={listingSummary.average}
                total={listingReviewTotal}
                distribution={listingSummary.distribution}
                reviews={listingReviews}
                isLoading={listingReviewsQuery.isLoading}
              />
            ) : null}
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
  const { t } = useTranslation();

  return (
    <View
      className="web:mx-auto web:w-full web:max-w-[1600px] md:px-5"
      accessibilityLabel={t("product.loadingA11y")}
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
  const { t } = useTranslation();
  const { data: listing, isLoading, isError } = useProduct(id ?? "");

  const head = (
    <Head>
      <title>{listing?.title ? t("product.documentTitle", { name: listing.title }) : t("product.appName")}</title>
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
            {t("product.loadError")}
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
