import { useState } from "react";
import { Pressable, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import type { Money } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";

/** Faux-select chevron icon size (px). */
const SELECT_ICON_SIZE = 20;

/** Purchase mode the buyer can toggle between; only `one_time` is functional. */
type PurchaseType = "one_time" | "subscribe";

/** Static subscribe delivery-frequency options (decorative — never wired to checkout). */
const SUBSCRIBE_FREQUENCIES = [
  "Delivers every month",
  "Delivers every 2 months",
  "Delivers every 3 months",
  "Delivers every 4 months",
  "Delivers every 6 months",
] as const;

export interface PurchaseOptionsProps {
  /** Active price (selected variant's price, or the listing "from" price). */
  price: Money;
  /** Whether the active selection can be added to the cart / bought. */
  canBuy: boolean;
  /** Whether an add-to-cart / buy-now mutation is in flight (disables actions). */
  isPending: boolean;
  /** Add the active selection to the cart. */
  onAddToCart: () => void;
  /** Add the active selection and proceed to checkout. */
  onBuyNow: () => void;
}

/**
 * The purchase-options block: a "One time purchase" card with an inline Buy now
 * (dark `bg-foreground`) + Add to cart (`bg-primary`) row, and a "Subscribe" row
 * with a frequency faux-select and a disabled Subscribe button. Only the
 * one-time path is functional; subscribe is decorative (never wired to
 * checkout). The radio header and the action content are SIBLINGS — never a
 * pressable nested inside a pressable.
 */
export function PurchaseOptions({
  price,
  canBuy,
  isPending,
  onAddToCart,
  onBuyNow,
}: PurchaseOptionsProps) {
  const [purchaseType, setPurchaseType] = useState<PurchaseType>("one_time");

  const actionsDisabled = !canBuy || isPending;

  return (
    <View className="overflow-hidden rounded-radius-20 border border-border-secondary">
      {/* Row A — One time purchase (default). */}
      <View className={purchaseType === "one_time" ? "bg-bg-fill-secondary" : "bg-bg-fill"}>
        <Pressable
          accessibilityRole="radio"
          accessibilityLabel="One time purchase"
          accessibilityState={{ selected: purchaseType === "one_time" }}
          onPress={() => setPurchaseType("one_time")}
          className="flex-row items-center gap-space-12 px-space-16 pt-space-16"
        >
          <View
            className={`size-space-20 items-center justify-center rounded-radius-max border-2 ${
              purchaseType === "one_time" ? "border-bg-fill-brand" : "border-border-secondary"
            }`}
          >
            {purchaseType === "one_time" ? (
              <View className="size-space-10 rounded-radius-max bg-bg-fill-brand" />
            ) : null}
          </View>
          <Text className="flex-1 text-bodyTitleSmall text-text">One time purchase</Text>
          <PriceDisplay price={price} primaryClassName="text-bodyTitleSmall" />
        </Pressable>
        {purchaseType === "one_time" ? (
          <View className="flex-row-reverse gap-space-8 p-space-16">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to cart"
              disabled={actionsDisabled}
              onPress={onAddToCart}
              className={`flex-1 items-center rounded-radius-max bg-bg-fill-brand p-space-16 web:active:scale-[0.99] ${
                actionsDisabled ? "opacity-50" : ""
              }`}
            >
              <Text className="text-buttonLarge text-primary-foreground">
                {canBuy ? "Add to cart" : "Select options"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Buy now"
              disabled={actionsDisabled}
              onPress={onBuyNow}
              className={`flex-1 items-center rounded-radius-max bg-bg-fill-inverse p-space-16 ${
                actionsDisabled ? "opacity-50" : ""
              }`}
            >
              <Text className="text-buttonLarge text-text-inverse">Buy now</Text>
            </Pressable>
          </View>
        ) : (
          <View className="h-space-16" />
        )}
      </View>

      <View className="h-px bg-border-image" />

      {/* Row B — Subscribe (decorative, never wired to checkout). */}
      <View className={purchaseType === "subscribe" ? "bg-bg-fill-secondary" : "bg-bg-fill"}>
        <Pressable
          accessibilityRole="radio"
          accessibilityLabel="Subscribe"
          accessibilityState={{ selected: purchaseType === "subscribe" }}
          onPress={() => setPurchaseType("subscribe")}
          className="flex-row items-center gap-space-12 px-space-16 pt-space-16"
        >
          <View
            className={`size-space-20 items-center justify-center rounded-radius-max border-2 ${
              purchaseType === "subscribe" ? "border-bg-fill-brand" : "border-border-secondary"
            }`}
          >
            {purchaseType === "subscribe" ? (
              <View className="size-space-10 rounded-radius-max bg-bg-fill-brand" />
            ) : null}
          </View>
          <Text className="flex-1 text-bodyTitleSmall text-text">Subscribe</Text>
          <PriceDisplay price={price} primaryClassName="text-bodyTitleSmall" />
        </Pressable>
        {purchaseType === "subscribe" ? (
          <View className="gap-space-8 p-space-16">
            {/* Static faux-select for delivery frequency. */}
            <View className="flex-row items-center justify-between rounded-radius-max border border-border-secondary bg-bg-fill px-space-16 py-space-12">
              <Text className="text-bodySmall text-text">{SUBSCRIBE_FREQUENCIES[0]}</Text>
              <ChevronDown size={SELECT_ICON_SIZE} className="text-text-tertiary" />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Subscribe now"
              disabled
              className="items-center rounded-radius-max bg-bg-fill-inverse p-space-16 opacity-50"
            >
              <Text className="text-buttonLarge text-text-inverse">Subscribe now</Text>
            </Pressable>
          </View>
        ) : (
          <View className="h-space-16" />
        )}
      </View>
    </View>
  );
}
