import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { useOxy } from "@oxyhq/services";
import type { Seller } from "@mercaria/shared-types";
import { ReviewStars, Text, useFormatters } from "@mercaria/ui";
import { SellerFollowButton } from "@/components/seller/SellerFollowButton";
import { useTranslation } from "@/lib/i18n";
import { REVIEW_SCOPE_HEADING_KEYS } from "@/lib/hooks/use-reviews";

/** Avatar edge length (px) on the card. */
const AVATAR_SIZE = 44;

/**
 * The seller card on a product page — the link from a P2P offer to the person
 * selling it (#92 acceptance 1, listing rule 1).
 *
 * ## Why this is a separate component from `StoreLinkCard`
 *
 * `products/[id].tsx` resolves a SINGLE `identity` store-first-then-seller and
 * feeds it to `MerchantHeader`. That is the trap #26 names: the obvious ticket
 * ("add a follow button to the merchant header") would push a shop and a person
 * through one code path, and a person followed under a shop's kind is a
 * permanent split of their followers with no repair short of a data migration.
 *
 * So each identity gets its own card, each renders under its own guard
 * (`listing.store ? …` / `listing.seller ? …`, which the schema makes mutually
 * exclusive), and neither follow control goes near `MerchantHeader`.
 *
 * ## The rating names its scope
 *
 * A `Seller.rating` is the #76 `p2p_seller` aggregate projected onto the seller
 * profile — "how was this seller to buy from". It is NOT the item's condition
 * rating and NOT the product's quality rating, both of which can appear
 * elsewhere on the same page, so the label travels with the stars.
 */
export function SellerLinkCard({
  seller,
  onPress,
}: {
  seller: Seller;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { formatReviewCount } = useFormatters();
  const { oxyServices } = useOxy();
  const avatarUrl = seller.avatar
    ? oxyServices.getFileDownloadUrl(seller.avatar, "thumb")
    : null;

  return (
    <View className="gap-space-12 rounded-radius-28 border border-border-secondary bg-bg-fill p-space-20">
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t("sellers.linkCard.viewProfile", { name: seller.displayName })}
        onPress={onPress}
        className="flex-row items-center gap-3"
      >
        <View
          className="items-center justify-center overflow-hidden rounded-full bg-muted"
          style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
        >
          {avatarUrl ? (
            <Image
              source={{ uri: avatarUrl }}
              contentFit="cover"
              style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
              transition={150}
            />
          ) : (
            <Text className="text-base font-bold text-muted-foreground">
              {seller.displayName.slice(0, 1).toUpperCase()}
            </Text>
          )}
        </View>

        <View className="flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-sectionTitle text-text">
            {seller.displayName}
          </Text>
          <Text numberOfLines={1} className="text-bodySmall text-text-secondary">
            {`@${seller.username}`}
          </Text>
        </View>
      </Pressable>

      {seller.rating !== undefined && seller.reviewCount !== undefined && seller.reviewCount > 0 ? (
        <View className="flex-row items-center gap-2">
          <ReviewStars
            rating={seller.rating}
            count={seller.reviewCount}
            size={14}
            scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.p2p_seller)}
          />
          <Text className="text-bodySmall text-text-secondary">
            {`${seller.rating} (${formatReviewCount(seller.reviewCount)}) · ${t(REVIEW_SCOPE_HEADING_KEYS.p2p_seller)}`}
          </Text>
        </View>
      ) : null}

      {/* The SAME control the profile page renders, reading the SAME Oxy graph
          — which is why the two always show the same state (#26 follow rule 5)
          rather than because anything here synchronises them. */}
      <View className="flex-row">
        <SellerFollowButton
          oxyUserId={seller.oxyUserId}
          displayName={seller.displayName}
          size="small"
        />
      </View>
    </View>
  );
}
