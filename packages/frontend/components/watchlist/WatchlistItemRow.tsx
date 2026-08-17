import { Pressable, View } from "react-native";
import { formatMoney, Text } from "@mercaria/ui";
import type {
  WatchlistBasketLine,
  WatchlistItemUnresolvedReason,
} from "@mercaria/shared-types";
import { hasKnownDelivery } from "@mercaria/shared-types";
import { useTranslation } from "@/lib/i18n";

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
 *
 * The map holds KEYS rather than sentences: a `const` evaluated at import cannot
 * call `t()`, so English here would freeze whichever locale loaded first. The
 * keys are literals so the i18n guard can see each leaf is referenced.
 */
const UNRESOLVED_COPY_KEYS: Readonly<Record<WatchlistItemUnresolvedReason, string>> = {
  ambiguous_after_split: "watchlists.item.unresolved.ambiguousAfterSplit",
  preferred_variant_retired: "watchlists.item.unresolved.preferredVariantRetired",
  product_merged_into_existing_item: "watchlists.item.unresolved.productMergedIntoExistingItem",
  product_unavailable: "watchlists.item.unresolved.productUnavailable",
  no_offers_recorded: "watchlists.item.unresolved.noOffersRecorded",
  all_offers_retired: "watchlists.item.unresolved.allOffersRetired",
  no_eligible_offer: "watchlists.item.unresolved.noEligibleOffer",
  price_not_convertible: "watchlists.item.unresolved.priceNotConvertible",
  evaluation_failed: "watchlists.item.unresolved.evaluationFailed",
};

export interface WatchlistItemRowProps {
  readonly line: WatchlistBasketLine;
  readonly onOpen: (canonicalProductId: string) => void;
  readonly onRemove: (itemId: string) => void;
}

export function WatchlistItemRow({ line, onOpen, onRemove }: WatchlistItemRowProps) {
  const { t } = useTranslation();
  const { item, evaluation, priceChange, target } = line;

  return (
    <View className="gap-space-8 rounded-radius-lg border border-border-secondary p-space-16">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("watchlists.item.openProduct")}
        onPress={() => onOpen(item.canonicalProductId)}
      >
        <Text className="text-base font-semibold text-foreground">
          {item.quantity > 1 ? `${item.quantity} × ` : ""}
          {item.canonicalProductId}
        </Text>
      </Pressable>

      {evaluation.state === "unresolved" ? (
        <Text className="text-sm text-text-secondary">
          {t(UNRESOLVED_COPY_KEYS[evaluation.reason])}
        </Text>
      ) : (
        <View className="gap-space-4">
          <Text className="text-base text-foreground">
            {t("watchlists.item.priceLine", {
              unitPrice: formatMoney(evaluation.selection.unitItemPrice),
              lineTotal: formatMoney(evaluation.selection.lineItemPrice),
              quantity: item.quantity,
            })}
          </Text>
          <Text className="text-sm text-text-secondary">
            {hasKnownDelivery(evaluation.selection.delivery)
              ? t("watchlists.item.delivery", {
                  amount: formatMoney(evaluation.selection.delivery.line),
                })
              : t("watchlists.item.deliveryUnknown")}
          </Text>
          {priceChange.known ? (
            <Text className="text-sm text-text-secondary">
              {/*
                Two whole sentences rather than a direction word glued to a
                frame: "Down" and "Up" carry gender and word order in most of
                the twelve locales, and neither is a slot a translator can
                move. Each `t()` names its key as a LITERAL, so the guard can
                see both leaves are referenced.
              */}
              {priceChange.direction === "unchanged"
                ? t("watchlists.item.changeUnchanged")
                : priceChange.direction === "down"
                  ? t("watchlists.item.changeDown", {
                      amount: formatMoney({
                        amount: Math.abs(priceChange.deltaMinor),
                        currency: priceChange.currency,
                      }),
                    })
                  : t("watchlists.item.changeUp", {
                      amount: formatMoney({
                        amount: Math.abs(priceChange.deltaMinor),
                        currency: priceChange.currency,
                      }),
                    })}
            </Text>
          ) : null}
          {target.state === "reached" ? (
            <Text className="text-sm text-foreground">
              {t("watchlists.item.targetReached", { amount: formatMoney(target.target) })}
            </Text>
          ) : null}
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("watchlists.item.removeA11y")}
        onPress={() => onRemove(item.id)}
      >
        <Text className="text-sm text-text-secondary">{t("watchlists.item.remove")}</Text>
      </Pressable>
    </View>
  );
}
