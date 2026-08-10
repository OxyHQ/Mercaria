import { Pressable, ScrollView, View } from "react-native";
import type { MerchantPageChannel } from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";

/**
 * Scoping the catalogue to a channel (#73 storefront-navigation rules 1, 3
 * and 5), and acceptance criterion 7's storefront-selection accessibility.
 *
 * ## The operator is named on the chip, not implied by it
 *
 * A channel this merchant OPERATES reads as its own; a channel it merely sells
 * THROUGH reads "on <operator>". That is the D8 comparison, already made by the
 * server and carried on `operatedByThisMerchant` — the chip does not recompute
 * it, and a page that printed every channel identically would tell a shopper
 * that a marketplace listing is a first-party one.
 *
 * ## Every control is reachable without sight
 *
 * `accessibilityRole="radio"` with `accessibilityState.selected` rather than a
 * plain button, because these are one exclusive choice rather than several
 * independent actions, and a screen reader announcing "button" for each would
 * leave a listener unable to tell which scope is active. The group carries
 * `accessibilityRole="radiogroup"` and a label naming what is being chosen.
 */
export function MerchantChannelPicker({
  channels,
  selectedStorefrontId,
  onSelect,
}: {
  channels: readonly MerchantPageChannel[];
  selectedStorefrontId: string | undefined;
  onSelect: (storefrontId: string | undefined) => void;
}) {
  if (channels.length === 0) return null;

  return (
    <View className="gap-2 px-4 pt-6">
      <Text className="text-xs uppercase text-muted-foreground">Channels</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="radiogroup"
        accessibilityLabel="Choose a sales channel to browse"
      >
        <View className="flex-row gap-2">
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: selectedStorefrontId === undefined }}
            accessibilityLabel="All channels"
            onPress={() => onSelect(undefined)}
            className={`rounded-full border px-4 py-2 ${
              selectedStorefrontId === undefined
                ? "border-foreground bg-secondary"
                : "border-border"
            }`}
          >
            <Text className="text-sm font-medium text-foreground">All channels</Text>
          </Pressable>

          {channels.map((channel) => {
            const label = channel.operatedByThisMerchant
              ? channel.storefront.name
              : `${channel.storefront.name} · on ${channel.operatorName ?? "another marketplace"}`;
            return (
              <Pressable
                key={channel.storefront.id}
                accessibilityRole="radio"
                accessibilityState={{
                  selected: selectedStorefrontId === channel.storefront.id,
                }}
                accessibilityLabel={`${label}, ${String(channel.currentOfferCount)} offers`}
                onPress={() => onSelect(channel.storefront.id)}
                className={`rounded-full border px-4 py-2 ${
                  selectedStorefrontId === channel.storefront.id
                    ? "border-foreground bg-secondary"
                    : "border-border"
                }`}
              >
                <Text className="text-sm font-medium text-foreground">{label}</Text>
                {/* Market, language and currency, exactly as the channel
                    publishes them — never inferred from the merchant's other
                    channels (#73 storefront rule 6). */}
                <Text className="text-xs text-muted-foreground">
                  {[
                    channel.storefront.country,
                    channel.storefront.currency,
                    channel.storefront.languages?.[0],
                  ]
                    .filter((part) => part !== null && part !== undefined)
                    .join(" · ")}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
