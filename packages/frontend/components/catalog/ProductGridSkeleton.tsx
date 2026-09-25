import { View } from "react-native";
import * as Skeleton from "@oxy.so/bloom/skeleton";

/** Placeholder tiles: two full rows at the widest (four-column) breakpoint. */
const TILE_COUNT = 8;

/**
 * Loading placeholder matching the products grid rhythm — the same 2 / 3 / 4
 * column tile widths and padding the real grid uses, so nothing jumps when
 * the listings arrive. The shimmer is Bloom's; the container is marked busy
 * and carries the screen's own "loading" sentence as its name.
 */
export function ProductGridSkeleton({ accessibilityLabel }: { accessibilityLabel: string }) {
  return (
    <View className="flex-row flex-wrap" accessibilityLabel={accessibilityLabel} aria-busy>
      {Array.from({ length: TILE_COUNT }, (_, index) => (
        <View key={index} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
          <View className="gap-2">
            <Skeleton.Box width="100%" borderRadius={16} style={{ aspectRatio: 1 }} />
            <Skeleton.Box width="50%" height={12} borderRadius={4} />
            <Skeleton.Box width="75%" height={12} borderRadius={4} />
          </View>
        </View>
      ))}
    </View>
  );
}
