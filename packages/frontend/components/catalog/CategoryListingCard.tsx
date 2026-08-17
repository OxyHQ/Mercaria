import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { useOxy } from '@oxyhq/services';
import type { Listing } from '@mercaria/shared-types';
import { ConditionBadge, PriceDisplay, Text } from '@mercaria/ui';

/**
 * One listing on a category landing page.
 *
 * ## It is NOT `ProductCard`, for the reason `MerchantProductCard` is not
 *
 * `@mercaria/ui`'s `ProductCard` takes a `ProductSummary`, whose `rating` and
 * `reviewCount` are REQUIRED. Two screens in this app already project a
 * `Listing` into one by writing `rating: 0, reviewCount: 0` — a figure nobody
 * measured, rendered as an empty star row that reads as "nobody liked this"
 * rather than as "nobody has said". #76 keeps a product's rating, a seller's and
 * an item's apart precisely so a page cannot imply one from another, and
 * inventing a zero implies the strongest of them.
 *
 * So this card takes a `Listing`, has no rating field at all, and says the four
 * things a category grid can honestly say: the item, its price, its condition
 * segment, and who is selling it.
 *
 * ## The condition is the #90 taxonomy, never the v1 binary
 *
 * `itemCondition` is authoritative and `condition` is its v1 projection.
 * `ConditionBadge` — the LISTING badge, not `OfferConditionBadge`, which exists
 * for the offer type whose key may be `unknown` — renders the taxonomy's own
 * label, so the words are the ones the catalogue publishes rather than a
 * mapping composed here.
 */

export interface CategoryListingCardProps {
  listing: Listing;
  onPress: (listingId: string) => void;
}

export function CategoryListingCard({ listing, onPress }: CategoryListingCardProps) {
  const { oxyServices } = useOxy();
  const fileId = listing.images[0]?.fileId ?? null;
  const imageUri = fileId === null ? null : oxyServices.getFileDownloadUrl(fileId, 'thumb');

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={listing.title}
      onPress={() => onPress(listing.id)}
      className="gap-space-8"
    >
      <View className="aspect-square w-full overflow-hidden rounded-2xl bg-muted">
        {imageUri === null ? null : (
          <Image
            source={{ uri: imageUri }}
            contentFit="cover"
            style={{ width: '100%', height: '100%' }}
            transition={150}
          />
        )}
      </View>

      <Text numberOfLines={2} className="text-sm font-medium text-foreground">
        {listing.title}
      </Text>

      <PriceDisplay price={listing.price} />

      <ConditionBadge condition={listing.itemCondition} />
    </Pressable>
  );
}
