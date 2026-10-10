import { useImageResolver } from "@oxy.so/bloom/image-resolver";
import { merchantImageSource } from "@mercaria/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useShoppingHistory,
  useShoppingHistoryOwner,
} from "@/lib/stores/shopping-history";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button } from "@oxy.so/bloom/button";
import { Rating } from "@oxy.so/bloom/rating";
import { openAccountDialog, useOxy } from "@oxy.so/services";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@oxy.so/bloom/accordion";
import { Stepper } from "@oxy.so/bloom/stepper";
import {
  BundleContents,
  BundleRecommendations,
  CommercialDisclosure,
  ConditionBadge,
  MerchantHeader,
  PriceDisplay,
  ProductCarousel,
  ProductGallery,
  PurchaseOptions,
  ShopDetailIcon,
  useRatingDisplay,
  ReviewSummaryCard,
  ReviewAccordionAccessory,
  Text,
  VariantSwatches,
  useFormatters,
  useColorScheme,
  useCartFlight,
  useShopControlClassName,
  type ProductGalleryHandle,
  type ProductSummary,
} from "@mercaria/ui";
import * as Skeleton from "@oxy.so/bloom/skeleton";
import type { Listing, StoreSummary, Seller } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { STOREFRONT_NAV_FROM } from "@/lib/layout";
import { ProductDescription } from "@/components/product/ProductDescription";
import { PurchasePlanPreview } from "@/components/listing/PurchasePlanPreview";
import { resolvePurchasePreview } from "@/lib/catalog/purchase-preview";
import { ProductReviewsDialog } from "@/components/product/ProductReviewsDialog";
import { Footer } from "@/components/shell/Footer";
import { ProductActionsMenu } from "@/components/product/ProductActionsMenu";
import { StoreFollowButton } from "@/components/store/StoreFollowButton";
import { SellerLinkCard } from "@/components/seller/SellerLinkCard";
import { useProduct, useProductReviews } from "@/lib/hooks/use-product";
import {
  REVIEW_SCOPE_HEADING_KEYS,
  useProductScopeReviews,
} from "@/lib/hooks/use-reviews";
import { useListings } from "@/lib/hooks/use-listings";
import { useAddCartItem } from "@/lib/hooks/use-cart";
import {
  useListingSaveContext,
  useToggleListingSave,
  useToggleProductSave,
} from "@/lib/hooks/use-saves";
import { useShareLink } from "@/lib/hooks/use-share-link";
import { useTranslation } from "@/lib/i18n";
import {
  chooseListingVariant,
  resolveListingVariant,
} from "@/lib/catalog/variant-selection";

/** Number of "More from store" related items pulled for the shelf. */
const RELATED_LIMIT = 12;
/** Reviews fetched for the summary + carousel. */
const REVIEW_PAGE_LIMIT = 12;
/** Icon size for the action-row icons (px). */
const ICON_SIZE = 20;

/** Project a catalog `Listing` into the `ProductSummary` shape the cards consume. */
function toProductSummary(listing: Listing, brand: string, resolveImage: ReturnType<typeof useImageResolver>): ProductSummary {
  const firstImage = listing.images[0];
  const summary: ProductSummary = {
    id: listing.id,
    title: listing.title,
    brand,
    imageUrl: firstImage ? resolveImage?.(firstImage.fileId, "thumb") : undefined,
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

/** Inline store-link card (brand-bg cover + wordmark + footer name/rating). */
function StoreLinkCard({
  store,
  onPress,
}: {
  store: StoreSummary;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const ratingDisplay = useRatingDisplay();
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
            source={merchantImageSource(store.coverImageUrl)}
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
            source={merchantImageSource(store.logoUrl)}
            contentFit="contain"
            style={{ height: 48, width: "60%", maxWidth: 220 }}
          />
        ) : (
          <Text
            numberOfLines={1}
            className="text-2xl font-bold"
            style={{ color: toneColor }}
          >
            {store.name}
          </Text>
        )}
      </Pressable>
      <View className="flex-row items-center justify-between p-space-16">
        <View>
          <Text
            numberOfLines={1}
            className="text-sm font-bold"
            style={{ color: toneColor }}
          >
            {store.name}
          </Text>
          <Rating
            {...ratingDisplay({
              rating: store.rating,
              reviews: store.reviewCount,
            })}
            size="small"
            color={toneColor}
            style={{ marginTop: 2 }}
          />
        </View>
        <StoreFollowButton store={store} size="sm" />
      </View>
    </View>
  );
}

/** "More from <store>" related shelf, sourced from the same store's listings. */
function RelatedFromStore({
  store,
  excludeId,
}: {
  store: StoreSummary;
  excludeId: string;
}) {
  const router = useRouter();
  const { t } = useTranslation();
  const { data } = useListings({ storeId: store.id, limit: RELATED_LIMIT });
  const resolveImage = useImageResolver();

  const items = useMemo(
    () =>
      (data?.data ?? [])
        .filter((listing) => listing.id !== excludeId)
        .map((listing) => toProductSummary(listing, store.name, resolveImage)),
    [data, excludeId, store.name, resolveImage],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <ProductCarousel
      title={t("product.moreFromStore", { name: store.name })}
      items={items}
      onPressItem={(id) =>
        router.push({ pathname: "/products/[id]", params: { id } })
      }
    />
  );
}

interface ProductBodyProps {
  listing: Listing;
}

/** The two-column PDP body (gallery + buy column) plus the full-width shelves. */
function ProductBody({ listing }: ProductBodyProps) {
  const { canUsePrivateApi } = useOxy();
  const resolveImage = useImageResolver();
  const controlClassName = useShopControlClassName();
  const { colors, isDarkColorScheme } = useColorScheme();
  const { width, height } = useWindowDimensions();
  const gallery = useRef<ProductGalleryHandle>(null);
  const { flyToCart } = useCartFlight();
  const desktopNavigation = width >= STOREFRONT_NAV_FROM;
  const router = useRouter();
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const ratingDisplay = useRatingDisplay();
  const addToCart = useAddCartItem();
  const addBundleToCart = useAddCartItem();
  useEffect(() => {
    if (!addToCart.isSuccess) return;
    const timer = setTimeout(addToCart.reset, 3000);
    return () => clearTimeout(timer);
  }, [addToCart.isSuccess, addToCart.reset]);

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
  const productDistribution =
    productReviewsQuery.data?.ratingSummary?.distribution;
  const hasProductReviews = (productAggregate?.reviewCount ?? 0) > 0;

  const listingReviewsQuery = useProductReviews(
    listing.id,
    1,
    REVIEW_PAGE_LIMIT,
  );
  const listingReviews = useMemo(
    () => listingReviewsQuery.data?.data ?? [],
    [listingReviewsQuery.data],
  );
  const listingSummary = listingReviewsQuery.data?.ratingSummary;
  const listingReviewTotal = listingSummary?.reviewCount ?? 0;
  const hasListingReviews = listingReviewTotal > 0;

  const options = listing.options ?? [];
  const { variantId, purchasePreview } = useLocalSearchParams<{ variantId?: string; purchasePreview?: string }>();
  const previewScenario = resolvePurchasePreview(purchasePreview, __DEV__);
  const selectedVariant = resolveListingVariant(listing.variants, variantId);
  const bundle = (
    <BundleContents
      contents={selectedVariant ? listing.bundleContentsByVariant?.[selectedVariant.id] : undefined}
      resolveImage={image => image.fileId ? resolveImage?.(image.fileId) : undefined}
      onPressComponent={component => router.push({
        pathname: "/p/[handle]",
        params: { handle: component.productSlug, variant: component.variantId },
      })}
    />
  );
  const selection = Object.fromEntries(
    selectedVariant?.optionValues.map((option) => [
      option.name,
      option.value,
    ]) ?? [],
  );
  const [quantity, setQuantity] = useState(1);
  const [reviewScope, setReviewScope] = useState<"product" | "p2p_listing">();
  const [initialReviewId, setInitialReviewId] = useState<string>();
  const [sections, setSections] = useState<string | string[] | undefined>([
    "description",
    "reviews",
  ]);

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
  const savePending = toggleProductSave.isPending || toggleListingSave.isPending ||
    (canUsePrivateApi && (saveContext.isPending || saveContext.isFetching));
  const saveStatusLabel = saveContext.isError ? t("common.tryAgain")
    : savePending ? t("common.loading") : undefined;

  function withSaveContext(action: () => void) {
    if (!canUsePrivateApi) {
      openAccountDialog();
    } else if (saveContext.isError) {
      void saveContext.refetch();
    } else if (saveContext.data && !savePending) {
      action();
    }
  }


  const shareLink = useShareLink(
    listing.title,
    `/products/${encodeURIComponent(listing.id)}${selectedVariant ? `?variantId=${encodeURIComponent(selectedVariant.id)}` : ""}`,
  );

  const activePrice = selectedVariant?.price ?? listing.price;
  const activeCompareAt = selectedVariant
    ? selectedVariant.compareAtPrice
    : listing.compareAtPrice;
  const onSale =
    activeCompareAt !== undefined &&
    activeCompareAt.amount > activePrice.amount;
  const discountPercent = onSale
    ? Math.round((1 - activePrice.amount / activeCompareAt.amount) * 100)
    : 0;

  const refundPolicy = selectedVariant?.commercial?.mode === "connected_marketplace" && selectedVariant.commercial.sellerKind === "store"
    ? listing.store?.refundPolicy : undefined;
  const maxQuantity = selectedVariant?.available;
  const canAddToCart = selectedVariant !== undefined && selectedVariant.inStock;
  const saveInPurchaseActions = !previewScenario && selectedVariant !== undefined && !selectedVariant.inStock;
  const primarySaved = canonicalProductId ? productSaved : listingSaved;
  const primarySaveLabel = saveStatusLabel ?? (canonicalProductId
    ? t(productSaved ? "product.save.productSaved" : "product.save.product")
    : t(listingSaved ? "product.save.saved" : "product.save.save"));
  const primarySaveA11y = saveStatusLabel ?? (canonicalProductId
    ? t(productSaved ? "product.save.removeProductA11y" : "product.save.productA11y")
    : t(listingSaved ? "product.save.removeListingA11y" : "product.save.listing"));
  const onPrimarySave = () => withSaveContext(() => {
    if (canonicalProductId) {
      toggleProductSave.mutate({ canonicalProductId, saved: productSaved, sourceContext: "listing_page", listingId: listing.id });
    } else {
      toggleListingSave.mutate({ listingId: listing.id, saved: listingSaved });
    }
  });

  const images = useMemo(
    () =>
      (selectedVariant?.images?.images ?? listing.images).flatMap((image) => {
        const uri = resolveImage?.(image.fileId);
        return uri ? [{ uri, alt: image.alt }] : [];
      }),
    [listing.images, selectedVariant?.images, resolveImage],
  );

  const identity = useMemo(() => merchantIdentity(listing), [listing]);

  const selectOption = (name: string, value: string) => {
    const next = chooseListingVariant(
      listing.variants,
      selectedVariant,
      name,
      value,
    );
    if (next) router.setParams({ variantId: next.id });
    setQuantity(1);
    addToCart.reset();
  };

  const onPressStore = () => {
    if (listing.store?.handle) {
      router.push({
        pathname: "/stores/[handle]",
        params: { handle: listing.store.handle },
      });
    }
  };

  // Keyed on the OXY ACCOUNT ID, never on the handle: a handle can change and a
  // renamed seller's every inbound link would 404, while the account id never
  // moves. Same reasoning as the follow target's URI.
  const onPressSeller = () => {
    if (listing.seller?.oxyUserId) {
      router.push({
        pathname: "/sellers/[oxyUserId]",
        params: { oxyUserId: listing.seller.oxyUserId },
      });
    }
  };

  const onAddToCart = () => {
    if (!selectedVariant) return;
    const image = gallery.current?.activeImage?.uri;
    const source = desktopNavigation
      ? gallery.current?.measureActiveImage()
      : Promise.resolve({ x: width / 2, y: height * 0.2, width: 0, height: 0 });
    addToCart.mutate({
      listingId: listing.id,
      variantId: selectedVariant.id,
      quantity,
    }, { onSuccess: async () => {
      const rect = await source;
      if (image && rect) void flyToCart(image, rect);
    } });
  };

  const onBuyNow = () => {
    if (!selectedVariant) return;
    addToCart.mutate(
      { listingId: listing.id, variantId: selectedVariant.id, quantity },
      {
        onSuccess: (cart) => {
          const group = cart.groups.find((candidate) =>
            candidate.items.some(
              (item) => item.variantId === selectedVariant.id,
            ),
          );
          router.push(
            !group || group.guestCheckout?.status === "blocked"
              ? "/cart"
              : { pathname: "/checkout", params: { seller: group.sellerKey } },
          );
        },
      },
    );
  };

  return (
    <View className="web:mx-auto web:w-full web:max-w-[1600px] md:px-5">
      <View className="flex-col">
        {/* Mobile sticky merchant bar. */}
        {!desktopNavigation ? <View className="px-space-16 py-space-12">
          <MerchantHeader
            name={identity.name}
            logoUrl={identity.logoUrl}
            rating={identity.rating}
            reviewCount={identity.reviewCount}
            onPress={onPressStore}
            size="large"
          />
        </View> : null}

        {/* Top two-column region: large gallery (flex-1) + fixed buy column. */}
        <View className="flex-col gap-space-16 md:mt-6 md:flex-row md:gap-space-40 md:px-4">
          <View className="min-w-0 md:flex-1 md:self-start web:md:sticky web:md:top-8">
            <ProductGallery
              className="md:w-full md:flex-none web:md:static web:md:top-auto"
              ref={gallery}
              images={images}
              title={listing.title}
            />
            {width >= 768 ? bundle : null}
          </View>

          {/* Buy column. */}
          <View
            className="min-w-0 gap-space-24 px-space-16 md:px-0 md:pt-2 md:w-[29em]"
            testID="product-buy-column"
          >
            {/* Desktop buy-column merchant header. */}
            <View className="gap-space-16" testID="product-summary">
              {desktopNavigation ? <View>
                <MerchantHeader
                  name={identity.name}
                  logoUrl={identity.logoUrl}
                  rating={identity.rating}
                  reviewCount={identity.reviewCount}
                  onPress={onPressStore}
                  moreAction={<ProductActionsMenu listingId={listing.id} title={listing.title} />}
                  size="compact"
                />
              </View> : null}

              <View className="flex-row items-start gap-space-4 md:items-center">
                <View className="min-w-0 flex-1 gap-space-4">
                  <Text
                    accessibilityRole="header"
                    numberOfLines={3}
                    className="text-shop-headerBold leading-[28px] text-text"
                  >
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
                    <View className="flex-row items-center gap-space-8">
                      <Rating
                        {...ratingDisplay({
                          rating: productAggregate.rating,
                          reviews: productAggregate.reviewCount,
                          subject: t(REVIEW_SCOPE_HEADING_KEYS.product),
                        })}
                      />
                      <Text className="text-shop-captionMedium text-text-tertiary">
                        {t(REVIEW_SCOPE_HEADING_KEYS.product)}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {!desktopNavigation ? (
                  <ProductActionsMenu listingId={listing.id} title={listing.title} outlined />
                ) : null}
              </View>

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
                    router.push({
                      pathname: "/p/[handle]",
                      params: { handle: listing.canonicalProductId ?? "" },
                    })
                  }
                  className="self-start rounded-radius-max border border-border-secondary px-space-16 py-space-8"
                >
                  <Text className="text-shop-buttonMedium text-text">
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
                <CommercialDisclosure
                  presentation={selectedVariant.commercial}
                  showExplanations
                />
              ) : null}

              {/* Price block. */}
              <View className="gap-space-4">
                {onSale ? (
                  <View className="flex-row items-center gap-space-8">
                    <PriceDisplay
                      price={activePrice}
                      primaryClassName="text-shop-bodyTitleLarge"
                    />
                    <Text className="text-shop-bodySmall text-text-tertiary line-through">
                      {formatMoney(activeCompareAt)}
                    </Text>
                    <View className="rounded-radius-max bg-bg-fill-inverse px-space-8 py-space-2">
                      <Text className="text-shop-badgeBold text-text-inverse">
                        {t("product.percentOff", { percent: discountPercent })}
                      </Text>
                    </View>
                  </View>
                ) : (
                  <PriceDisplay
                    price={activePrice}
                    primaryClassName="text-shop-bodyTitleLarge"
                  />
                )}
              </View>
            </View>

            {/* Option selectors (value pills). */}
            {options.map((option) => (
              <VariantSwatches
                key={option.name}
                option={option}
                variants={listing.variants}
                selectedValue={selection[option.name]}
                selectedVariant={selectedVariant}
                onSelect={(value) => selectOption(option.name, value)}
              />
            ))}

            {/* Quantity selector. */}
            <View className="gap-space-8">
              <Text className="text-shop-captionBold text-text">
                {t("product.quantity")}
              </Text>
              {/* Bloom's stepper, floored at 1 with no remove: nothing is in the
                  cart yet, so there is nothing for a trash button to take away.
                  `+` stops at what is in stock, as the cart line's does. */}
              <View className="self-start">
                <Stepper
                  appearance="outline"
                  style={{ backgroundColor: colors.card }}
                  value={quantity}
                  min={1}
                  max={
                    maxQuantity === undefined
                      ? undefined
                      : Math.max(1, maxQuantity)
                  }
                  onValueChange={setQuantity}
                  decrementLabel={t("product.decreaseQuantity")}
                  incrementLabel={t("product.increaseQuantity")}
                  accessibilityLabel={t("product.quantity")}
                />
              </View>
            </View>

            {/* Preview actions are isolated from the real commerce callbacks. */}
            {previewScenario ? <PurchasePlanPreview key={`${previewScenario}:${selectedVariant?.id ?? "unselected"}`} scenario={previewScenario} /> : <PurchaseOptions
              hasSelection={selectedVariant !== undefined}
              added={addToCart.isSuccess && addToCart.variables.variantId === selectedVariant?.id}
              canBuy={canAddToCart}
              isPending={addToCart.isPending}
              onAddToCart={onAddToCart}
              onBuyNow={onBuyNow}
              unavailableSaveAction={{
                saved: primarySaved,
                pending: savePending,
                label: primarySaveLabel,
                accessibilityLabel: primarySaveA11y,
                onPress: onPrimarySave,
              }}
            />}

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
            <View
              className={
                canonicalProductId ? "gap-space-8" : "flex-row gap-space-8"
              }
            >
              {canonicalProductId ? (
                <View className="flex-row gap-space-8">
                  {!saveInPurchaseActions ? <Button
                    material="flat"
                    accessibilityRole="button"
                    disabled={savePending}
                    pressed={primarySaved}
                    accessibilityLabel={primarySaveA11y}
                    onPress={onPrimarySave}
                    className={`${controlClassName("outline", savePending)} flex-1 gap-space-4`}
                    iconSize={ICON_SIZE}
                    renderLeadingIcon={({ size, color }) => (
                      <ShopDetailIcon name="heart" size={size} color={color} filled={primarySaved} />
                    )}
                  >
                    {primarySaveLabel}
                  </Button> : null}
                  <Button
                    material="flat"
                    accessibilityRole="button"
                    disabled={savePending}
                    pressed={listingSaved}
                    accessibilityLabel={
                      saveStatusLabel ??
                      (listingSaved
                        ? t("product.save.removeListingA11y")
                        : t("product.save.exactListingA11y"))
                    }
                    onPress={() =>
                      withSaveContext(() =>
                        toggleListingSave.mutate({
                          listingId: listing.id,
                          saved: listingSaved,
                          // A buyer choosing THIS control while the product
                          // button sits beside it has said the exact listing is
                          // what they mean — which is exactly what a pin records,
                          // and what the migration then leaves alone.
                          pin: true,
                        }),
                      )
                    }
                    className={`${controlClassName("outline", savePending)} flex-1 gap-space-4`}
                  >
                    {saveStatusLabel ??
                      (listingSaved
                        ? t("product.save.listingSaved")
                        : t("product.save.listing"))}
                  </Button>
                </View>
              ) : !saveInPurchaseActions ? (
                <Button
                  material="flat"
                  accessibilityRole="button"
                  disabled={savePending}
                  pressed={primarySaved}
                  accessibilityLabel={primarySaveA11y}
                  onPress={onPrimarySave}
                  className={`${controlClassName("outline", savePending)} flex-1 gap-space-4`}
                  iconSize={ICON_SIZE}
                  renderLeadingIcon={({ size, color }) => (
                    <ShopDetailIcon name="heart" size={size} color={color} filled={primarySaved} />
                  )}
                >
                  {primarySaveLabel}
                </Button>
              ) : null}
              <Button
                material="flat"
                accessibilityRole="button"
                accessibilityLabel={
                  shareLink.copied
                    ? t("common.linkCopied")
                    : t("product.shareA11y")
                }
                onPress={() => void shareLink.share()}
                className={`${controlClassName("outline")} flex-1 gap-space-4`}
                iconSize={ICON_SIZE}
                renderLeadingIcon={({ size, color }) => (
                  <ShopDetailIcon name="share" size={size} color={color} />
                )}
              >
                {shareLink.copied ? t("common.linkCopied") : t("product.share")}
              </Button>
            </View>

            {saveContext.isError || toggleProductSave.isError || toggleListingSave.isError ? (
              <Text accessibilityRole="alert" className="text-shop-caption text-destructive">
                {t(saveContext.isError ? "product.save.statusError" : "product.save.updateError")}
              </Text>
            ) : null}

            {shareLink.failed ? (
              <Text
                accessibilityRole="alert"
                className="text-shop-caption text-destructive"
              >
                {t("common.shareError")}
              </Text>
            ) : null}

            {width < 768 ? bundle : null}

            <Accordion
              type="multiple"
              transition={{ duration: 250, easing: [0.23, 1, 0.32, 1] }}
              value={sections}
              onValueChange={setSections}
              testID="product-sections"
            >
              {listing.description ? (
                <AccordionItem value="description" className={isDarkColorScheme ? "border-white/10" : "border-[#183b4e0f]"}>
                  <AccordionTrigger className="px-0 py-space-16">
                    <Text accessibilityRole="header" className="text-shop-subtitle text-text">
                      {t("product.description")}
                    </Text>
                  </AccordionTrigger>
                  <AccordionContent contentClassName="px-0 pb-space-16">
                    <ProductDescription description={listing.description} />
                  </AccordionContent>
                </AccordionItem>
              ) : null}
              <AccordionItem value="reviews" className={refundPolicy
                ? isDarkColorScheme ? "border-white/10" : "border-[#183b4e0f]"
                : "border-0"}>
                <AccordionTrigger className="px-0 py-space-16">
                  <View className="flex-row items-center">
                    <Text accessibilityRole="header" className="min-w-0 flex-1 text-shop-subtitle text-text">
                      {t("product.reviews")}
                    </Text>
                    <ReviewAccordionAccessory
                      expanded={Array.isArray(sections) ? sections.includes("reviews") : sections === "reviews"}
                      rating={listing.canonicalProductId ? productAggregate?.rating ?? 0 : listingSummary?.rating ?? 0}
                      reviews={listing.canonicalProductId ? productAggregate?.reviewCount ?? 0 : listingReviewTotal}
                      subject={t(REVIEW_SCOPE_HEADING_KEYS[listing.canonicalProductId ? "product" : "p2p_listing"])}
                    />
                  </View>
                </AccordionTrigger>
                <AccordionContent contentClassName="px-0 pb-space-16">
                  <View className="gap-space-16">
                    {listing.canonicalProductId ? (
                      <ReviewSummaryCard
                        scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.product)}
                        embedded
                        onReadMore={() => setReviewScope("product")}
                        onReviewPress={(id) => { setInitialReviewId(id); setReviewScope("product"); }}
                        average={productAggregate?.rating ?? 0}
                        total={productAggregate?.reviewCount ?? 0}
                        distribution={productDistribution}
                        reviews={productReviews}
                        isLoading={productReviewsQuery.isLoading}
                        {...(productAggregate
                          ? { unverified: productAggregate.unverified }
                          : {})}
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
                        embedded
                        onReadMore={() => setReviewScope("p2p_listing")}
                        onReviewPress={(id) => { setInitialReviewId(id); setReviewScope("p2p_listing"); }}
                        average={listingSummary?.rating ?? 0}
                        verifiedOnly={false}
                        total={listingReviewTotal}
                        distribution={listingSummary?.distribution}
                        reviews={listingReviews}
                        isLoading={listingReviewsQuery.isLoading}
                      />
                    ) : null}
                  </View>
                </AccordionContent>
              </AccordionItem>
              {refundPolicy ? (
                <AccordionItem value="returns" className="border-0">
                  <AccordionTrigger className="px-0 py-space-16">
                    <Text accessibilityRole="header" className="text-shop-subtitle text-text">
                      {t("product.returnPolicy")}
                    </Text>
                  </AccordionTrigger>
                  <AccordionContent contentClassName="px-0 pb-space-16">
                    <Text className="text-shop-bodySmall text-text">
                      {refundPolicy}
                    </Text>
                  </AccordionContent>
                </AccordionItem>
              ) : null}
            </Accordion>

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

        <BundleRecommendations
          bundles={selectedVariant ? listing.bundlesByVariant?.[selectedVariant.id] ?? [] : []}
          onView={bundle => router.push({ pathname: "/products/[id]", params: { id: bundle.listingId, variantId: bundle.variantId } })}
          onAddToCart={async bundle => {
            await addBundleToCart.mutateAsync({ listingId: bundle.listingId, variantId: bundle.variantId, quantity: 1 });
          }}
        />

        {/* Full-width related shelves. */}
        {listing.store ? (
          <RelatedFromStore store={listing.store} excludeId={listing.id} />
        ) : null}

        {reviewScope ? (
          <ProductReviewsDialog
            listingId={listing.id}
            canonicalProductId={listing.canonicalProductId}
            scope={reviewScope}
            initialReviewId={initialReviewId}
            onClose={() => { setReviewScope(undefined); setInitialReviewId(undefined); }}
          />
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
      aria-busy
    >
      <View className="flex-col gap-space-16 md:mt-6 md:flex-row md:gap-space-40 md:px-4">
        <View className="aspect-square flex-1">
          <Skeleton.Box width="100%" height="100%" borderRadius={28} />
        </View>
        <View className="gap-space-16 md:w-[29em]">
          <Skeleton.Box width={160} height={32} borderRadius={4} />
          <Skeleton.Box width="75%" height={28} borderRadius={4} />
          <Skeleton.Box width={112} height={24} borderRadius={4} />
          <Skeleton.Box width="100%" height={48} borderRadius={9999} />
          <Skeleton.Box width="100%" height={48} borderRadius={9999} />
        </View>
      </View>
    </View>
  );
}

export default function ProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { data: listing, isLoading, isError } = useProduct(id ?? "");
  const historyOwner = useShoppingHistoryOwner();
  const resolveImage = useImageResolver();
  const historyReady = useShoppingHistory((state) => state.hydrated);
  useEffect(() => {
    if (listing && historyReady)
      useShoppingHistory
        .getState()
        .viewProduct(
          historyOwner,
          toProductSummary(listing, brandLabel(listing), resolveImage),
        );
  }, [listing, historyOwner, historyReady, resolveImage]);

  const head = (
    <Head>
      <title>
        {listing?.title
          ? t("product.documentTitle", { name: listing.title })
          : t("product.appName")}
      </title>
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
          <Text className="text-center text-shop-body text-text-tertiary">
            {t("product.loadError")}
          </Text>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      {head}
      <ProductBody key={listing.id} listing={listing} />
    </ScreenShell>
  );
}
