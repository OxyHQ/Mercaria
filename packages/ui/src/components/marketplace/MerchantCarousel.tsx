import { View } from "react-native";
import { Carousel, CarouselItem } from "@oxy.so/bloom/carousel";
import { MerchantCard } from "./MerchantCard";
import { SectionHeader } from "./SectionHeader";
import type { StoreSummary } from "@mercaria/shared-types";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { CAROUSEL_STORES_KEY } from "../../lib/marketplace-labels";
import { uniqueByKey, useShelfCarouselProps } from "../../lib/shelf-carousel";

/** Merchant-card slot width (px). */
const MERCHANT_SLOT_WIDTH = 330;

export interface MerchantCarouselProps {
  /**
   * Optional, exactly as `ProductCarousel`'s is: a caller with no heading to
   * show renders the row headless rather than composing a sentence to fill the
   * slot. Absent, no `SectionHeader` is drawn at all.
   */
  title?: string;
  merchants: StoreSummary[];
  onPressMerchant?: (handle: string) => void;
  onPressProduct?: (id: string) => void;
}

/**
 * A merchant (shop) section: an optional bold heading above a horizontally
 * scrollable row of large `MerchantCard`s on Bloom's `Carousel`. Returns `null`
 * when there are no merchants or they are unavailable, so the heading never
 * appears over an empty row — safe to render always.
 */
export function MerchantCarousel({
  title,
  merchants,
  onPressMerchant,
  onPressProduct,
}: MerchantCarouselProps) {
  const t = useSharedUiTranslation();
  const shelf = useShelfCarouselProps();
  const rows = uniqueByKey(merchants, (merchant) => merchant.id);
  if (rows.length === 0) return null;

  return (
    <View className="mb-6">
      {title ? <SectionHeader title={title} /> : null}
      <Carousel {...shelf} accessibilityLabel={title ?? t(CAROUSEL_STORES_KEY)}>
        {rows.map((merchant) => (
          <CarouselItem key={merchant.id} width={MERCHANT_SLOT_WIDTH}>
            <MerchantCard
              merchant={merchant}
              onPressMerchant={onPressMerchant}
              onPressProduct={onPressProduct}
            />
          </CarouselItem>
        ))}
      </Carousel>
    </View>
  );
}
