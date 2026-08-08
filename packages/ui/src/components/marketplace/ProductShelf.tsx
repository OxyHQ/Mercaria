import { View } from "react-native";
import { ProductCarousel } from "./ProductCarousel";
import { SectionHeader } from "./SectionHeader";
import type { ProductSummary } from "../../lib/format";

export interface ProductShelfProps {
  title: string;
  items: ProductSummary[];
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
  onPressItem,
  onToggleSaveItem,
}: ProductShelfProps) {
  if (!items || items.length === 0) return null;

  return (
    <View className="mb-6">
      <SectionHeader title={title} />
      <ProductCarousel
        items={items}
        onPressItem={onPressItem}
        onToggleSaveItem={onToggleSaveItem}
      />
    </View>
  );
}
