import { View } from "react-native";
import { Text } from "../ui/text";

export interface DemandPillProps {
  /** Static social-proof copy (e.g. "100K+ bought in past month"). */
  label: string;
}

/**
 * A small static "social proof" demand chip shown under the product title
 * (e.g. "100K+ bought in past month"). Decorative — no real demand data behind
 * it; the label is supplied by the caller.
 */
export function DemandPill({ label }: DemandPillProps) {
  return (
    <View className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6">
      <Text className="text-captionBold text-text">{label}</Text>
    </View>
  );
}
