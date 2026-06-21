import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Carousel } from "./Carousel";
import { MerchantCard } from "./MerchantCard";
import type { MerchantSummary } from "@mercaria/shared-types";

/** Fixed slot width (px) for each merchant card in the carousel. */
const MERCHANT_CARD_WIDTH = 330;

export interface MerchantCarouselProps {
  title: string;
  merchants: MerchantSummary[];
  onPressMerchant?: (handle: string) => void;
  onPressProduct?: (id: string) => void;
}

/**
 * A titled merchant (shop) section: a bold heading above a horizontally
 * scrollable row of large `MerchantCard`s. Reuses the generic `Carousel`, so
 * the scroll + web-arrow logic is shared, not duplicated.
 */
export function MerchantCarousel({
  title,
  merchants,
  onPressMerchant,
  onPressProduct,
}: MerchantCarouselProps) {
  return (
    <View className="mb-6">
      <Text className="px-4 pb-3 text-lg font-bold text-foreground">{title}</Text>
      <Carousel
        items={merchants}
        keyExtractor={(merchant) => merchant.id}
        itemWidth={MERCHANT_CARD_WIDTH}
        renderItem={(merchant) => (
          <MerchantCard
            merchant={merchant}
            onPressMerchant={onPressMerchant}
            onPressProduct={onPressProduct}
          />
        )}
      />
    </View>
  );
}
