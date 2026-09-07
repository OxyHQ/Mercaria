import { useState } from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Star } from "lucide-react-native";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  CAROUSEL_NEXT_KEY,
  CAROUSEL_PREVIOUS_KEY,
  MARKETPLACE_VISIT_MERCHANT_KEY,
} from "../../lib/marketplace-labels";
import { useFormatters } from "../../lib/use-formatters";
import { cn } from "../../lib/cn";
import { IncentiveHalo } from "./IncentiveHalo";
import { DiscountBadge } from "./DiscountBadge";
import type { DiscountSummary, StoreSummary } from "@mercaria/shared-types";

/** Rating star size (px). */
const RATING_STAR_SIZE = 11;
/** Fixed gold star fill (documented allowed constant, matches `MerchantCard`). */
const STAR_COLOR = "#FFB800";

export interface StoreProductCardProps {
  store: StoreSummary;
  discount?: DiscountSummary;
  onPressStore?: (handle: string) => void;
  onPressProduct?: (id: string) => void;
}

/**
 * The square cross-fading product carousel over a store row — the reference's
 * `product-focused-merchant-card`, and the one genuinely new card in this kit.
 *
 * ## The carousel index and React Compiler
 *
 * The active slide lives in `useState`, read only during render — never from a
 * ref read inside a memoized position, which is the shape React Compiler can
 * silently serve stale. `goPrev`/`goNext` are plain functional updates.
 *
 * ## Where the reference's web `inert` goes
 *
 * The reference keeps every slide always mounted as an `<a>` and marks the
 * inactive ones `inert` so they cannot be focused or clicked despite
 * `opacity-0`. React Native has no `inert` — and checked against the
 * installed `react-native-web`, a bare `View` would not forward it anyway
 * (`View`'s `pickProps` only forwards its own fixed `forwardedProps`
 * allowlist, and `inert` is not on it). Both platforms get the same
 * "unreachable by pointer or keyboard" guarantee a different way here: only
 * the ACTIVE product is ever wrapped in a `Pressable` at all, so there is no
 * always-mounted interactive element left over for `inert` to disable — a
 * hidden-but-pressable slide was never constructible on either platform to
 * begin with, which is a stronger guarantee than the reference's own.
 *
 * ## No nested interactives
 *
 * The store row (logo + name + rating) is ONE Pressable link, and the active
 * product slide is a SEPARATE, sibling Pressable link in the image area above
 * it — the same rule `MerchantCard` documents: web renders no `<a>` inside
 * another `<a>`, and the inner one stops working.
 */
export function StoreProductCard({
  store,
  discount,
  onPressStore,
  onPressProduct,
}: StoreProductCardProps) {
  const t = useSharedUiTranslation();
  const { formatRating } = useFormatters();
  const [index, setIndex] = useState(0);

  const products = store.products ?? [];
  const hasProducts = products.length > 0;
  const hasMany = products.length > 1;
  const activeProduct = hasProducts ? products[index] : undefined;

  const goPrev = () => setIndex((i) => (i - 1 + products.length) % products.length);
  const goNext = () => setIndex((i) => (i + 1) % products.length);

  const logoBox = (
    <View className="relative h-space-32 w-space-32 items-center justify-center overflow-hidden rounded-radius-max bg-bg-fill-tertiary">
      {store.logoUrl ? (
        <Image source={{ uri: store.logoUrl }} contentFit="cover" className="size-full" />
      ) : null}
    </View>
  );

  return (
    <View className="flex flex-col gap-space-8">
      {/* Image area — the cross-fading carousel. */}
      <View className="relative aspect-square w-full overflow-hidden rounded-radius-20 shadow-s">
        {hasProducts ? (
          <>
            {products.map((product, i) => {
              const isActive = i === index;
              return (
                <View
                  key={product.id}
                  pointerEvents="none"
                  className={cn(
                    "absolute inset-0 web:transition-opacity",
                    isActive ? "z-10 opacity-100" : "opacity-0",
                  )}
                >
                  {product.imageUrl ? (
                    <Image source={{ uri: product.imageUrl }} contentFit="cover" className="size-full" />
                  ) : (
                    <View className="size-full bg-bg-fill-tertiary" />
                  )}
                </View>
              );
            })}

            {/* The one interactive layer over the slides: the active
                product's own link. Rendered after the slides so it paints on
                top of them. */}
            {activeProduct ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={activeProduct.title}
                onPress={() => onPressProduct?.(activeProduct.id)}
                className="absolute inset-0"
              />
            ) : null}

            {/* Edge zones advance the carousel, as the reference does,
                without stealing the whole-image product link — rendered
                after it so they capture the press first. A quarter-width
                zone each side is CHOSEN, not measured: the capture's own
                edge zones are a mouse-hover affordance with no fixed size
                that translates to a touch target, so there is no figure in
                the appendix to copy. Leaves the wide middle band as the
                product link. */}
            {hasMany ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(CAROUSEL_PREVIOUS_KEY)}
                  onPress={goPrev}
                  className="absolute inset-y-0 start-0 w-1/4"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(CAROUSEL_NEXT_KEY)}
                  onPress={goNext}
                  className="absolute inset-y-0 end-0 w-1/4"
                />
              </>
            ) : null}
          </>
        ) : (
          <View pointerEvents="none" className="absolute inset-0 bg-bg-fill-tertiary" />
        )}

        {discount ? <DiscountBadge discount={discount} /> : null}

        {hasMany ? (
          <View
            pointerEvents="none"
            className="absolute bottom-space-16 z-10 w-full flex-row justify-center"
          >
            <View className="flex-row gap-space-2">
              {products.map((product, i) => (
                <View
                  key={product.id}
                  className={cn(
                    "size-space-6 rounded-full",
                    i === index ? "bg-overlay-fixed-light-75" : "bg-overlay-fixed-light-40",
                  )}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-radius-20 border border-border-image"
        />
      </View>

      {/* Store row — ONE link, a SIBLING of the product link above, never its
          parent. */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t(MARKETPLACE_VISIT_MERCHANT_KEY, { name: store.name })}
        onPress={() => onPressStore?.(store.handle)}
        className="flex-row items-start gap-space-8 px-space-4 lg:items-center"
      >
        {discount?.exclusive ? <IncentiveHalo>{logoBox}</IncentiveHalo> : logoBox}

        <View className="min-w-0 flex-1">
          <Text numberOfLines={2} className="font-bodyTitleSmall text-bodyTitleSmall max-lg:hidden">
            {store.name}
          </Text>
          <Text numberOfLines={2} className="font-captionBold text-captionBold lg:hidden">
            {store.name}
          </Text>
          <View className="flex-row items-center gap-space-2">
            <Text className="font-bodyTitleSmall text-bodyTitleSmall text-text">
              {formatRating(store.rating)}
            </Text>
            <Star size={RATING_STAR_SIZE} color={STAR_COLOR} fill={STAR_COLOR} />
          </View>
        </View>
      </Pressable>
    </View>
  );
}
