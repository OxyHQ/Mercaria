import { View } from "react-native";
import { Text } from "@mercaria/ui";
import type { SellerFieldOrigin } from "@mercaria/shared-types";

/**
 * One fact on the sell form, labelled with WHOSE it is (#91 UX rule 3).
 *
 * This component exists because the distinction is the issue's whole safety
 * argument, and a distinction that lives only in a designer's head is one the
 * next screen forgets. A `canonical` value is INHERITED — shown so the seller
 * does not retype it, never presented as something they said — and it renders
 * with the label "From the product", muted, and never inside the block a seller
 * is asked to confirm.
 *
 * The prop is the server's own `origin`, not a boolean the screen computes: the
 * server is the only thing that knows whether the seller has touched a field,
 * and a client that decided for itself would eventually decide that a prefilled
 * value the person scrolled past counts as confirmed.
 */
export interface InheritedFactProps {
  label: string;
  value: string;
  origin: SellerFieldOrigin;
  confirmed: boolean;
}

export function InheritedFact({ label, value, origin, confirmed }: InheritedFactProps) {
  const inherited = origin === "canonical";
  return (
    <View className="gap-1 py-2">
      <Text className="text-xs uppercase text-muted-foreground">{label}</Text>
      <Text className={inherited ? "text-base text-muted-foreground" : "text-base"}>{value}</Text>
      <Text className="text-xs text-muted-foreground">
        {inherited
          ? "From the product — not a statement about your item"
          : confirmed
            ? "Your answer"
            : "Your answer, not confirmed yet"}
      </Text>
    </View>
  );
}
