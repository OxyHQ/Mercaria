import React from "react";
import { View, Pressable, ScrollView } from "react-native";
import type { Listing, ProductVariantDTO } from "@mercaria/shared-types";
import {
  Text,
  PriceDisplay,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

interface VariantPickerSheetProps {
  /** The listing whose variants are being picked, or `null` when closed. */
  listing: Listing | null;
  onClose: () => void;
  onPick: (listing: Listing, variant: ProductVariantDTO) => void;
}

/**
 * Trailing-edge sheet that lets the operator pick one of a listing's variants
 * when the listing has more than one in-stock SKU. Out-of-stock variants are
 * dimmed and non-interactive. Opens when `listing` is non-null.
 *
 * `side="end"` is logical, so the sheet enters from the right in a
 * left-to-right till and from the left in a mirrored one (#429).
 */
export function VariantPickerSheet({ listing, onClose, onPick }: VariantPickerSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet open={listing !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="end">
        <SheetHeader>
          <SheetTitle>{listing?.title ?? t("catalog.chooseVariant")}</SheetTitle>
        </SheetHeader>
        {listing ? (
          <ScrollView contentContainerClassName="gap-3 py-2">
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
                      ? "min-h-[64px] rounded-2xl border border-border bg-secondary p-4 opacity-50"
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
          </ScrollView>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
