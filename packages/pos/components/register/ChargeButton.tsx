import React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import type { Money } from "@mercaria/shared-types";
import { Text, Button, PriceDisplay } from "@mercaria/ui";

interface ChargeButtonProps {
  /** Cart total shown in the label (formatted via PriceDisplay — never by hand). */
  total: Money;
  /** Disabled when the cart is empty. */
  disabled: boolean;
  /** Tailwind height/spacing classes for the button (callers size it per slot). */
  className?: string;
}

/**
 * The single charge affordance reused by both the wide right-pane footer and the
 * narrow bottom bar. Renders "Charge" next to the total (the ⊜ figure always
 * goes through `PriceDisplay`) and navigates to the tender step (`/charge`).
 */
export function ChargeButton({ total, disabled, className }: ChargeButtonProps) {
  const router = useRouter();
  return (
    <Button onPress={() => router.push("/charge")} disabled={disabled} className={className}>
      <View className="flex-row items-center gap-2">
        <Text className="text-base font-semibold text-primary-foreground">Charge</Text>
        <PriceDisplay
          price={total}
          primaryClassName="text-base font-bold text-primary-foreground"
        />
      </View>
    </Button>
  );
}
