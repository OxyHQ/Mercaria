import { View } from "react-native";
import { ProductCarousel } from "./ProductCarousel";
import { SectionHeader } from "./SectionHeader";
import type { ProductSummary } from "../../lib/format";

export interface ProductShelfProps {
  title: string;
  items: ProductSummary[];
  /**
   * Makes the heading a link to the shelf's "see all", with the trailing
   * chevron `SectionHeader` already draws for that mode. Omitted, the heading
   * is the plain text node it has always been — a shelf whose whole content is
   * already on screen has nowhere to send anyone.
   */
  onPressTitle?: () => void;
  onPressItem?: (id: string) => void;
  onToggleSaveItem?: (id: string, nextSaved: boolean) => void;
}

/**
 * A titled marketplace section: a bold heading above a horizontally scrollable
 * product carousel. The shelf owns the heading; the carousel renders the row.
 * Returns `null` when there are no items or they are unavailable, so the heading
 * never appears over an empty row — safe to render always.
 */
export function ProductShelf({
  title,
  items,
  onPressTitle,
  onPressItem,
  onToggleSaveItem,
}: ProductShelfProps) {
  if (!items || items.length === 0) return null;

  return (
    <View className="mb-6">
      <SectionHeader
        title={title}
        onPress={onPressTitle}
        showChevron={onPressTitle !== undefined}
      />
      <ProductCarousel
        items={items}
        onPressItem={onPressItem}
        onToggleSaveItem={onToggleSaveItem}
      />
    </View>
  );
}
