import { View, useWindowDimensions } from "react-native";
import { Text } from "../ui/text";
import { cn } from "../../lib/cn";

export interface ProductSpecification {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** Shop's public PDP layout: short facts fit two columns, medium facts stack
 * below 768px, and long facts always stack. Values and ordering are catalog-owned.
 */
export function ProductSpecificationGrid({ entries }: { entries: readonly ProductSpecification[] }) {
  const { width } = useWindowDimensions();
  const longest = Math.max(0, ...entries.flatMap(({ label, value }) => [label.length, value.length]));
  const layout = longest <= 19 ? "grid" : longest <= 32 ? "responsive" : "list";
  const columns = layout === "grid" || (layout === "responsive" && width >= 768) ? 2 : 1;

  if (entries.length === 0) return null;

  return (
    <View testID="pdp-specifications-grid" className="flex-row flex-wrap">
      {entries.map((entry, index) => (
        <View
          key={entry.key}
          testID="pdp-specification-cell"
          style={{ width: columns === 1 || (index === entries.length - 1 && entries.length % 2 === 1) ? "100%" : "50%" }}
          className={cn(
            "min-w-0 gap-space-2 py-space-8",
            index >= columns && "border-t border-border-secondary",
            columns === 2 && (index % 2 === 0 ? "pe-space-6" : "ps-space-6"),
          )}
        >
          <Text className="text-shop-caption text-text-tertiary web:[overflow-wrap:anywhere]">{entry.label}</Text>
          <Text className="text-shop-bodySmall text-text web:[overflow-wrap:anywhere]">{entry.value}</Text>
        </View>
      ))}
    </View>
  );
}
