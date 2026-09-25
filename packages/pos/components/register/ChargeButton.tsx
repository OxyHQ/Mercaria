import React from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import type { Money } from "@mercaria/shared-types";
import { PriceDisplay } from "@mercaria/ui";
import { Button } from "@oxy.so/bloom/button";
import { useTranslation } from "@/lib/i18n";

interface ChargeButtonProps {
  /** Cart total shown in the label (formatted via PriceDisplay — never by hand). */
  total: Money;
  /** Disabled when the cart is empty. */
  disabled: boolean;
  /**
   * The button's box (callers size it per slot). A style rather than classes:
   * Bloom's Button sets its height inline, which a height class cannot beat.
   */
  style?: StyleProp<ViewStyle>;
}

/**
 * The single charge affordance reused by both the wide right-pane footer and the
 * narrow bottom bar. Renders "Charge" next to the total (the ⊜ figure always
 * goes through `PriceDisplay`) and navigates to the tender step (`/charge`).
 */
export function ChargeButton({ total, disabled, style }: ChargeButtonProps) {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <Button
      tone="accent"
      size="lg"
      onPress={() => router.push("/charge")}
      disabled={disabled}
      style={style}
      trailing={
        <PriceDisplay
          price={total}
          primaryClassName="text-base font-bold text-primary-foreground"
        />
      }
    >
      {t("charge.action")}
    </Button>
  );
}
