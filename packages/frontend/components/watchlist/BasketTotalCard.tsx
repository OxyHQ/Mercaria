import { View } from "react-native";
import { formatMoney, Text } from "@mercaria/ui";
import { hasKnownBasketTotal, type WatchlistBasket } from "@mercaria/shared-types";
import { useTranslation } from "@/lib/i18n";

/**
 * The basket total, with an honest completeness label (#81 UX rules 4 and 5,
 * acceptance 6).
 *
 * ## What this card may never say
 *
 * The sum is each item's cheapest eligible offer, chosen in ISOLATION. It is not
 * the cheapest way to buy the set — nothing traded one item's higher price
 * against another's lower delivery, and #42 owns the optimization that would.
 * `watchlist-isolation.test.ts` scans this file for the sentences that would
 * claim otherwise, in RAW source, because the risk here is COPY rather than
 * code.
 *
 * ## Three states, and none of them is a zero
 *
 * `complete` — every item contributed. `partial` — some did not, and the count
 * of those says how many. `unknown` — nothing could be priced, so there is no
 * figure at all rather than a `0` that reads as "free".
 *
 * ## The BASIS is part of the label, not a footnote
 *
 * "including delivery" and "before delivery" are different numbers, and a buyer
 * comparing this week's total against last week's needs to know which one they
 * are looking at — the server refuses to mix them, and this is where that
 * refusal becomes visible.
 *
 * Each basis is ONE whole key carrying the honest
 * `WATCHLIST_INDEPENDENT_MINIMA_LABEL` phrase with it, rather than a translated
 * half joined to an English constant: a line reading "vor Versand · independent
 * per-item minima" is the hedge failing in exactly the place it has to hold.
 */
export function BasketTotalCard({ basket }: { basket: WatchlistBasket }) {
  const { t } = useTranslation();
  const total = basket.total;

  if (!hasKnownBasketTotal(total)) {
    return (
      <View className="gap-space-4 rounded-radius-lg border border-border-secondary p-space-16">
        <Text className="text-sm text-text-secondary">{t("watchlists.basket.title")}</Text>
        <Text className="text-xl font-semibold text-foreground">
          {t("watchlists.basket.noPrice")}
        </Text>
        <Text className="text-sm text-text-secondary">
          {basket.unresolved.length === 0
            ? t("watchlists.basket.empty")
            : t("watchlists.basket.nonePriced", { count: basket.unresolved.length })}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-space-4 rounded-radius-lg border border-border-secondary p-space-16">
      <Text className="text-sm text-text-secondary">{t("watchlists.basket.title")}</Text>
      <Text className="text-2xl font-bold text-foreground">{formatMoney(total.amount)}</Text>
      <Text className="text-sm text-text-secondary">
        {total.basis === "delivered_total"
          ? t("watchlists.basket.basisDelivered")
          : t("watchlists.basket.basisItemPrice")}
      </Text>
      {total.completeness === "partial" ? (
        <Text className="text-sm text-text-secondary">
          {t("watchlists.basket.partial", {
            included: total.includedItems,
            total: total.includedItems + total.excludedItems,
            excluded: total.excludedItems,
          })}
        </Text>
      ) : (
        <Text className="text-sm text-text-secondary">
          {t("watchlists.basket.complete", { count: total.includedItems })}
        </Text>
      )}
    </View>
  );
}
