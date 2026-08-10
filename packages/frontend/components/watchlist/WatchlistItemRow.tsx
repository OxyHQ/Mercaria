import { Pressable, View } from "react-native";
import { formatMoney, Text } from "@mercaria/ui";
import type {
  WatchlistBasketLine,
  WatchlistItemUnresolvedReason,
} from "@mercaria/shared-types";
import { hasKnownDelivery } from "@mercaria/shared-types";

/**
 * One row of a watchlist basket (#81 UX rules 3 and 5).
 *
 * ## An item that could not be priced still gets a row
 *
 * That is the whole of #81 item rule 7 at the surface: a total that quietly
 * excluded items would leave a buyer with a smaller number and one fewer line
 * than they added, and nothing saying which. Every reason maps to a sentence a
 * person can act on, and the exhaustive `Record` below fails `tsc` when a reason
 * is added without one — so a new state can never render as a blank row.
 */
const UNRESOLVED_COPY: Readonly<Record<WatchlistItemUnresolvedReason, string>> = {
  ambiguous_after_split: "This product was split in two. Choose which one you meant.",
  preferred_variant_retired:
    "The exact configuration you pinned is no longer listed. Pick another one.",
  product_merged_into_existing_item:
    "This product was merged into another entry on this list. Remove this one.",
  product_unavailable: "This product is no longer available in the catalogue.",
  no_offers_recorded: "Nobody is selling this yet.",
  all_offers_retired: "Every offer for this has expired. We will pick it up when one returns.",
  no_eligible_offer: "No offer matches your filters for this item. Try widening them.",
  price_not_convertible: "We cannot show this price in your list's currency.",
  evaluation_failed: "We could not price this item just now.",
};

export interface WatchlistItemRowProps {
  readonly line: WatchlistBasketLine;
  readonly onOpen: (canonicalProductId: string) => void;
  readonly onRemove: (itemId: string) => void;
}

export function WatchlistItemRow({ line, onOpen, onRemove }: WatchlistItemRowProps) {
  const { item, evaluation, priceChange, target } = line;

  return (
    <View className="gap-space-8 rounded-radius-lg border border-border-secondary p-space-16">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open this product"
        onPress={() => onOpen(item.canonicalProductId)}
      >
        <Text className="text-base font-semibold text-foreground">
          {item.quantity > 1 ? `${item.quantity} × ` : ""}
          {item.canonicalProductId}
        </Text>
      </Pressable>

      {evaluation.state === "unresolved" ? (
        <Text className="text-sm text-text-secondary">
          {UNRESOLVED_COPY[evaluation.reason]}
        </Text>
      ) : (
        <View className="gap-space-4">
          <Text className="text-base text-foreground">
            {formatMoney(evaluation.selection.unitItemPrice)} each ·{" "}
            {formatMoney(evaluation.selection.lineItemPrice)} for {item.quantity}
          </Text>
          <Text className="text-sm text-text-secondary">
            {hasKnownDelivery(evaluation.selection.delivery)
              ? `Delivery ${formatMoney(evaluation.selection.delivery.line)}`
              : "Delivery not published by this seller"}
          </Text>
          {priceChange.known ? (
            <Text className="text-sm text-text-secondary">
              {priceChange.direction === "unchanged"
                ? "Unchanged since your last saved measurement"
                : `${priceChange.direction === "down" ? "Down" : "Up"} ${formatMoney({
                    amount: Math.abs(priceChange.deltaMinor),
                    currency: priceChange.currency,
                  })} since your last saved measurement`}
            </Text>
          ) : null}
          {target.state === "reached" ? (
            <Text className="text-sm text-foreground">
              At or below your target of {formatMoney(target.target)}
            </Text>
          ) : null}
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Remove this item from the watchlist"
        onPress={() => onRemove(item.id)}
      >
        <Text className="text-sm text-text-secondary">Remove</Text>
      </Pressable>
    </View>
  );
}
