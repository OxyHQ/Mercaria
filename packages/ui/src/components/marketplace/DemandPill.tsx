import { View } from "react-native";
import { Badge } from "@oxy.so/bloom/badge";

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
    <View className="self-start">
      <Badge size="label-medium" variant="subtle" color="default" content={label} />
    </View>
  );
}
