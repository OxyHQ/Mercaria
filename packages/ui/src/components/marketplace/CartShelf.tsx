import { View } from 'react-native';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';
import type { CartGroup, CartVendor } from '@mercaria/shared-types';
import { MerchantCartCard } from './MerchantCartCard';
import { SectionHeader } from './SectionHeader';
import { useSharedUiTranslation } from '../../i18n/ui-translation';
import { CART_SHELF_TITLE_KEY } from '../../lib/marketplace-labels';
import { uniqueByKey, useShelfCarouselProps } from '../../lib/shelf-carousel';

/** Merchant cart-card slot width (px). */
const CART_SLOT_WIDTH = 330;

export interface CartShelfProps {
  /** Heading; defaults to the translated "In your cart". */
  title?: string;
  groups: CartGroup[];
  onPressVendor: (vendor: CartVendor) => void;
  onCheckout: (group: CartGroup) => void;
  onPressCart: () => void;
}

/**
 * Horizontally scrollable shelf of merchant-grouped cart cards on Bloom's
 * `Carousel`. Returns `null` when the cart is empty or groups are unavailable —
 * safe to render always.
 */
export function CartShelf({
  title,
  groups,
  onPressVendor,
  onCheckout,
  onPressCart,
}: CartShelfProps) {
  const t = useSharedUiTranslation();
  const shelf = useShelfCarouselProps();
  const rows = uniqueByKey(groups, (group) => group.sellerKey);
  if (rows.length === 0) return null;

  const heading = title ?? t(CART_SHELF_TITLE_KEY);

  return (
    <View className="mb-3 md:mb-6" testID="cart-shelf">
      <Carousel
        {...shelf}
        accessibilityLabel={heading}
        showArrows={false}
        style={{ gap: 16 }}
        header={
          <SectionHeader
            title={heading}
            inset={false}
            showChevron
            onPress={onPressCart}
            chevronPosition="after-title"
          />
        }
      >
        {rows.map((group) => (
          <CarouselItem key={group.sellerKey} width={CART_SLOT_WIDTH}>
            <MerchantCartCard group={group} onPressVendor={onPressVendor} onCheckout={onCheckout} />
          </CarouselItem>
        ))}
      </Carousel>
    </View>
  );
}
