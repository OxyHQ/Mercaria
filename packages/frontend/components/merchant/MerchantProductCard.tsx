import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { useOxy } from "@oxyhq/services";
import { ALL_CURRENCY_CODES } from "@mercaria/shared-types";
import type { CurrencyCode, MerchantCatalogEntry, Money } from "@mercaria/shared-types";
import { PriceDisplay, Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/**
 * An offer's price, only when Mercaria can actually display it.
 *
 * `OfferMoney.currency` is an OPEN string on purpose (#57): a source platform
 * may publish a currency outside Mercaria's presentment set, and the offer
 * records what it said rather than refusing the observation. `PriceDisplay`
 * converts through `FxContext`, which is defined over `CurrencyCode` — so a
 * card either has a displayable price or it says so. A cast here would put an
 * unconvertible code into the FX layer, where the failure surfaces as a number
 * that quietly is not what it claims.
 */
function displayablePrice(price: { amount: number; currency: string } | undefined): Money | null {
  if (price === undefined) return null;
  const known = (ALL_CURRENCY_CODES as readonly string[]).includes(price.currency);
  return known ? { amount: price.amount, currency: price.currency as CurrencyCode } : null;
}

/**
 * One canonical-product card on a merchant page (#73 catalogue-browse rule 2).
 *
 * ## It is NOT `ProductCard`, deliberately
 *
 * `@mercaria/ui`'s `ProductCard` takes a `ProductSummary`, whose `rating` and
 * `reviewCount` are REQUIRED — so rendering one here would force this page to
 * supply a star figure for every card. A merchant page already carries one star
 * rating, the merchant's, under its own scope label, and a second one beside it
 * is read as the same measurement. That is #73 trust rule 5 ("merchant ratings
 * never become product ratings") and #76 UI rule 6. The card therefore takes a
 * `MerchantCatalogEntry`, which has no rating field at all, and a future
 * "let's just reuse ProductCard" would have to invent one in a diff somebody
 * reviews.
 *
 * ## What it says instead of a rating
 *
 * The facts a shopper needs to decide whether to look further, and each of them
 * is a fact this scope actually establishes: the cheapest current price THIS
 * merchant offers, how many of its channels carry it, the condition segments
 * present, and whether other sellers are in the picture — which is what stops a
 * marketplace operator's page implying it sells everything on its own channel
 * (storefront rule 5).
 */
export function MerchantProductCard({
  entry,
  onPress,
}: {
  entry: MerchantCatalogEntry;
  onPress: (canonicalProductId: string) => void;
}) {
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const fileId = entry.image?.fileId ?? null;
  const imageUri = fileId
    ? oxyServices.getFileDownloadUrl(fileId, "thumb")
    : (entry.image?.sourceUrl ?? null);
  const offerPrice = entry.representativeOffer?.price;
  const price = displayablePrice(offerPrice);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}${entry.brand ? `, ${entry.brand.name}` : ""}`}
      onPress={() => onPress(entry.canonicalProductId)}
      className="gap-2"
    >
      <View className="aspect-square w-full overflow-hidden rounded-2xl bg-muted">
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            contentFit="cover"
            style={{ width: "100%", height: "100%" }}
            transition={150}
          />
        ) : null}
      </View>

      {entry.brand ? (
        <Text numberOfLines={1} className="text-xs uppercase text-muted-foreground">
          {entry.brand.name}
        </Text>
      ) : null}
      <Text numberOfLines={2} className="text-sm font-medium text-foreground">
        {entry.name}
      </Text>

      {price ? <PriceDisplay price={price} /> : null}
      {price === null ? (
        // Two honest absences, told apart. A source may publish a product with
        // no price at all, and a source may publish one in a currency Mercaria
        // cannot convert — and neither is a zero.
        <Text className="text-sm text-muted-foreground">
          {offerPrice === undefined
            ? t("merchants.card.priceNotPublished")
            : t("merchants.card.priceUnconvertible", { currency: offerPrice.currency })}
        </Text>
      ) : null}

      <Text numberOfLines={1} className="text-xs text-muted-foreground">
        {entry.eligibleChannelCount > 1
          ? t("merchants.card.offersAcrossChannels", {
              count: entry.currentOfferCount,
              channels: entry.eligibleChannelCount,
            })
          : t("merchants.card.offerCount", { count: entry.currentOfferCount })}
        {entry.hasOtherSellers ? ` ${t("merchants.card.otherSellers")}` : ""}
      </Text>
    </Pressable>
  );
}
