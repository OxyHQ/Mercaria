import React from "react";
import { View, Pressable } from "react-native";
import { Dialog, type DialogControlProps } from "@oxy.so/bloom/dialog";
import type { Listing, ProductVariantDTO } from "@mercaria/shared-types";
import { Text, PriceDisplay } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/** Side-sheet width (px) — the old sheet's desktop width. */
const SHEET_WIDTH = 400;

interface VariantPickerSheetProps {
  control: DialogControlProps;
  /** The listing whose variants are being picked; `null` before the first pick. */
  listing: Listing | null;
  onPick: (listing: Listing, variant: ProductVariantDTO) => void;
  /** Fires once the sheet has finished closing, however it closed. */
  onClosed: () => void;
}

/**
 * Trailing-edge sheet that lets the operator pick one of a listing's variants
 * when the listing has more than one in-stock SKU. Out-of-stock variants are
 * dimmed and non-interactive. Opened and closed through `control`.
 *
 * Bloom's `Dialog` owns the surface and resolves the LOGICAL `end` placement
 * itself from `useIsRtl()`: the sheet enters from the right in a left-to-right
 * till and from the left in a mirrored one (#429).
 */
export function VariantPickerSheet({ control, listing, onPick, onClosed }: VariantPickerSheetProps) {
  const { t } = useTranslation();
  const title = listing?.title ?? t("catalog.chooseVariant");
  return (
    <Dialog
      control={control}
      placement="end"
      width={SHEET_WIDTH}
      title={title}
      label={title}
      onClose={onClosed}
    >
      {listing ? (
        <View className="gap-3 py-2">
          {listing.variants.map((variant) => {
            const disabled = variant.available <= 0;
            return (
              <Pressable
                key={variant.id}
                onPress={() => !disabled && onPick(listing, variant)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={variant.title}
                accessibilityState={{ disabled }}
                className={
                  disabled
                    ? "min-h-[64px] rounded-2xl border border-border bg-muted p-4 opacity-50"
                    : "min-h-[64px] rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
                }
              >
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-base font-semibold text-foreground">{variant.title}</Text>
                    <Text className="text-xs text-muted-foreground">
                      {disabled
                        ? t("catalog.outOfStock")
                        : t("catalog.availableCount", { count: variant.available })}
                    </Text>
                  </View>
                  <PriceDisplay price={variant.price} />
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </Dialog>
  );
}
