import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { ProductCarousel } from "./ProductCarousel";
import type { ProductSummary } from "./types";

export interface ProductShelfProps {
  title: string;
  items: ProductSummary[];
  onPressItem?: (id: string) => void;
  onToggleSaveItem?: (id: string, nextSaved: boolean) => void;
}

/**
 * A titled marketplace section: a bold heading above a horizontally scrollable
 * product carousel. The shelf owns the heading; the carousel renders the row.
 */
export function ProductShelf({
  title,
  items,
  onPressItem,
  onToggleSaveItem,
}: ProductShelfProps) {
  return (
    <View className="mb-6">
      <Text className="px-4 pb-3 text-lg font-bold text-foreground">{title}</Text>
      <ProductCarousel
        items={items}
        onPressItem={onPressItem}
        onToggleSaveItem={onToggleSaveItem}
      />
    </View>
  );
}
