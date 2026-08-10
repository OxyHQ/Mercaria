import { useRouter } from "expo-router";
import { Pressable } from "react-native";
import { Text } from "@mercaria/ui";

/**
 * The `Sell yours` entry point (#91 entry paths 1 and 2).
 *
 * A component rather than a route so a canonical PRODUCT page (#71) and a
 * selected VARIANT can both drop it in without either of them learning the
 * flow's URL shape. It navigates and nothing else: it starts no draft, because a
 * draft is a WRITE and a page view must never create one (the `issueGuestActor`
 * rule, one domain over).
 *
 * The variant is passed through when there is one, which is the difference
 * between #91's two entry paths and is what makes the fast path fast: a seller
 * who arrived from a specific configuration should not be asked which one they
 * meant.
 */
export interface SellYoursButtonProps {
  canonicalProductId: string;
  canonicalVariantId?: string;
  /** The label a page wants. `Sell yours` on a product, `Sell this one` on a variant. */
  label?: string;
}

export function SellYoursButton({
  canonicalProductId,
  canonicalVariantId,
  label,
}: SellYoursButtonProps) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      className="items-center justify-center rounded-full border border-border px-5 py-3"
      onPress={() => {
        router.push({
          pathname: "/sell",
          params: {
            canonicalProductId,
            ...(canonicalVariantId ? { canonicalVariantId } : {}),
            entryPath: canonicalVariantId ? "canonical_variant" : "canonical_product",
          },
        });
      }}
    >
      <Text className="text-base font-medium">
        {label ?? (canonicalVariantId ? "Sell this one" : "Sell yours")}
      </Text>
    </Pressable>
  );
}
