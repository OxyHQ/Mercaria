import { View } from "react-native";
import type { CartGroup, CartVendor } from "@mercaria/shared-types";
import { Carousel } from "./Carousel";
import { MerchantCartCard } from "./MerchantCartCard";
import { SectionHeader } from "./SectionHeader";

/** Default shelf heading when no `title` prop is provided. */
const DEFAULT_TITLE = "In your cart";

/** Fixed slot width class for each merchant cart card. */
const CART_SLOT_CLASS = "w-[330px] mr-3";

export interface CartShelfProps {
  title?: string;
  groups: CartGroup[];
  onPressVendor: (vendor: CartVendor) => void;
  onCheckout: (vendor: CartVendor) => void;
}

/**
 * Horizontally scrollable shelf of merchant-grouped cart cards. Returns `null`
 * when the cart is empty or groups are unavailable — safe to render always.
 */
export function CartShelf({ title, groups, onPressVendor, onCheckout }: CartShelfProps) {
  if (!groups || groups.length === 0) return null;

  return (
    <View className="mb-6">
      <SectionHeader title={title ?? DEFAULT_TITLE} />
      <Carousel
        items={groups}
        keyExtractor={(g) => g.vendor.id}
        slotClassName={CART_SLOT_CLASS}
        renderItem={(g) => (
          <MerchantCartCard
            group={g}
            onPressVendor={onPressVendor}
            onCheckout={onCheckout}
          />
        )}
      />
    </View>
  );
}
