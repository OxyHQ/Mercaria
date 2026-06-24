import { View } from "react-native";
import { Carousel } from "./Carousel";
import { MerchantCard } from "./MerchantCard";
import { SectionHeader } from "./SectionHeader";
import type { MerchantSummary } from "@mercaria/shared-types";

/** Fixed merchant-card slot width via Tailwind class (no JS measuring). The
 *  inter-card gap is owned by the Carousel's content container. */
const MERCHANT_SLOT_CLASS = "w-[330px]";

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
      <SectionHeader title={title} />
      <Carousel
        items={merchants}
        keyExtractor={(merchant) => merchant.id}
        slotClassName={MERCHANT_SLOT_CLASS}
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
