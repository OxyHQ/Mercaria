import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { ALL_CURRENCY_CODES } from "@mercaria/shared-types";
import type {
  CatalogProductCard,
  CatalogPriceConditionScope,
  CurrencyCode,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { ReviewStars } from "./ReviewStars";
import { formatMoney, formatReviewCount } from "../../lib/format";
import { cn } from "../../lib/cn";

/**
 * One canonical PRODUCT in a grid (#72 product-browse rules 1–4).
 *
 * A different component from `ProductCard`, which renders a LISTING — one
 * seller's copy of one thing, with its own price and its own save state. This
 * one renders a product the marketplace as a whole sells, so it carries a
 * representative price and an offer COUNT instead of a price and a heart, and
 * it has no save affordance at all: saving a canonical product is #80's and
 * goes through a different endpoint with a different meaning.
 *
 * ## The three things this card refuses to render
 *
 * 1. **A price with no condition context.** `conditionScope` is printed beside
 *    every figure. "From 320 €" over a headline about the new model, when the
 *    320 is a scratched used unit, is the most misleading thing a catalogue
 *    grid does.
 * 2. **A zero rating.** `rating` is ABSENT rather than zero when nothing has
 *    been rated, and an absent rating draws no stars — an empty star row reads
 *    as a bad product rather than as an unrated one.
 * 3. **A price that is not there.** A product with no current offer shows its
 *    identity and says so; it does not show "0 €" and does not disappear (#72
 *    product-browse rule 4).
 */

/** What each condition coverage SAYS above a price. */
const CONDITION_SCOPE_TEXT: Readonly<Record<CatalogPriceConditionScope, string>> = Object.freeze({
  new: "New",
  used: "Pre-owned",
  mixed: "New & pre-owned",
  unknown: "Condition not stated",
});

export interface CanonicalProductCardProps {
  product: CatalogProductCard;
  /**
   * Resolve an Oxy media file id to a URL. The card holds a bare `fileId`
   * because that is what the API serves; the app supplies the resolver, which
   * is the ecosystem's one media chokepoint.
   */
  resolveImage?: (fileId: string) => string | undefined;
  /**
   * Whether the PAGE computed offers at all. `false` (the `withdrawn` state)
   * makes the card say prices are unavailable instead of "no offers" — those
   * are different facts and a shopper must not read an incident as an empty
   * catalogue.
   */
  offersIncluded?: boolean;
  onPress?: (canonicalProductId: string) => void;
  className?: string;
}

export function CanonicalProductCard({
  product,
  resolveImage,
  offersIncluded = true,
  onPress,
  className,
}: CanonicalProductCardProps) {
  const asset = product.image;
  const imageUrl =
    asset?.state === "displayable" && resolveImage ? resolveImage(asset.fileId) : undefined;
  const offers = product.offers;
  const lowestPrice = offers?.summary.lowestPrice;

  return (
    <View className={cn("group flex flex-col gap-2", className)}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={product.name}
        onPress={() => onPress?.(product.canonicalProductId)}
        className="relative aspect-square overflow-hidden rounded-[20px] bg-card web:shadow-sm"
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            contentFit="cover"
            className="h-full w-full web:transition-transform web:duration-300 web:group-hover:scale-105"
          />
        ) : (
          // A withheld asset and an absent one both land here. The card does
          // NOT explain which: a shopper has no action to take either way, and
          // the rights state belongs in the operator surface, not on a tile.
          <View className="h-full w-full items-center justify-center bg-muted">
            <Text className="text-xs text-muted-foreground">No image</Text>
          </View>
        )}
      </Pressable>

      <Pressable
        accessibilityRole="link"
        onPress={() => onPress?.(product.canonicalProductId)}
        className="flex flex-col gap-1"
      >
        <Text numberOfLines={2} className="text-sm font-medium">
          {product.name}
        </Text>

        {product.modelYear === undefined ? null : (
          <Text className="text-xs text-muted-foreground">{product.modelYear}</Text>
        )}

        {product.rating === undefined ? null : (
          <View className="flex-row items-center gap-1">
            <ReviewStars rating={product.rating.value} size={12} />
            <Text className="text-xs text-muted-foreground">
              {formatReviewCount(product.rating.count)}
            </Text>
          </View>
        )}

        {!offersIncluded ? (
          <Text className="text-xs text-muted-foreground">Prices unavailable right now</Text>
        ) : offers === undefined || lowestPrice === undefined ? (
          <Text className="text-xs text-muted-foreground">No current offers</Text>
        ) : (
          <View className="flex flex-col">
            <Text className="text-sm font-semibold">
              {/*
                An offer's currency is the SOURCE's own code, shape-checked and
                deliberately not enumerated (#57) — a Romanian retailer's RON
                price is a real offer even where Mercaria cannot present in RON.
                So a code outside the presentment set is rendered plainly rather
                than through `formatMoney`, which would look up a symbol that
                does not exist and print `undefined` in front of the number.
              */}
              From{" "}
              {(ALL_CURRENCY_CODES as readonly string[]).includes(lowestPrice.currency)
                ? formatMoney({
                    amount: lowestPrice.amount,
                    currency: lowestPrice.currency as CurrencyCode,
                  })
                : `${lowestPrice.amount} ${lowestPrice.currency}`}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {CONDITION_SCOPE_TEXT[offers.conditionScope]} ·{" "}
              {offers.summary.currentOfferCount === 1
                ? "1 offer"
                : `${offers.summary.currentOfferCount} offers`}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}
