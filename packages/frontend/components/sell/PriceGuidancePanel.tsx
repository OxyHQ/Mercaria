import { View } from "react-native";
import { Text } from "@mercaria/ui";
import type { SellerPriceGuidance, SellerPriceGuidanceSegment } from "@mercaria/shared-types";
import { formatDate, useFormatters } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/**
 * Price guidance, rendered so it cannot read as a price (#91 price guidance
 * 1–5).
 *
 * ## There is nothing here to tap
 *
 * No "use this price" button, no prefill, no default. That is not restraint on
 * this screen's part — the server sends no number to submit, and the segment
 * type's `insufficient_data` branch has no figure at all, so the omission is
 * enforced one layer down and this component could not offer one if it tried.
 *
 * ## Every segment says what it is about
 *
 * The market, the currency and the window are on the panel, and each segment
 * carries its own label and sample size, because "the used range is 180–260" is
 * a claim that can only be checked if it also says where, in what currency, over
 * what period and from how many observations (#78's rule, one domain over).
 *
 * ## `insufficient_data` is rendered, not hidden
 *
 * A segment with too little behind it says so. Dropping it would leave a seller
 * looking at three bars and concluding the fourth question has no answer, when
 * the true answer is "not enough data yet" — and those are different things.
 */
export interface PriceGuidancePanelProps {
  guidance: SellerPriceGuidance;
}

const SEGMENT_LABEL_KEYS: Record<SellerPriceGuidanceSegment["kind"], string> = {
  current_same_condition: "sell.guidance.segment.currentSameCondition",
  current_new: "sell.guidance.segment.currentNew",
  current_refurbished: "sell.guidance.segment.currentRefurbished",
  recent_sold_native: "sell.guidance.segment.recentSoldNative",
};

const INSUFFICIENT_LABEL_KEYS: Record<string, string> = {
  no_observations: "sell.guidance.insufficient.noObservations",
  below_sample_floor: "sell.guidance.insufficient.belowSampleFloor",
  below_seller_floor: "sell.guidance.insufficient.belowSellerFloor",
};

const CONFIDENCE_LABEL_KEYS: Record<string, string> = {
  low: "sell.guidance.confidence.low",
  medium: "sell.guidance.confidence.medium",
  high: "sell.guidance.confidence.high",
};

export function PriceGuidancePanel({ guidance }: PriceGuidancePanelProps) {
  const { t, locale } = useTranslation();
  const { formatMoney } = useFormatters();
  const since = formatDate(guidance.from, locale);
  return (
    <View className="gap-3 rounded-2xl border border-border p-4">
      <Text className="text-base font-medium">{t("sell.guidance.heading")}</Text>
      {/* Both scope sentences NAME the date, and i18n-js renders a missing
          placeholder as the literal `[missing "%{since}" value]` — untranslated
          debug text, in every locale. So an unformattable `from` drops the whole
          line rather than printing a broken one; the segments below still
          carry the guidance this panel exists for. */}
      {since === null ? null : (
        <Text className="text-xs text-muted-foreground">
          {guidance.market
            ? t("sell.guidance.scopeWithMarket", {
                market: guidance.market,
                currency: guidance.currency,
                since,
              })
            : t("sell.guidance.scope", { currency: guidance.currency, since })}
        </Text>
      )}

      {guidance.segments.map((segment) => (
        <View key={segment.kind} className="gap-1">
          <Text className="text-sm font-medium">{t(SEGMENT_LABEL_KEYS[segment.kind])}</Text>
          {segment.state === "available" ? (
            <>
              <Text className="text-base">
                {formatMoney(segment.low)} – {formatMoney(segment.high)}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("sell.guidance.segmentStats", {
                  median: formatMoney(segment.median),
                  count: segment.sampleSize,
                  confidence: t(CONFIDENCE_LABEL_KEYS[segment.confidence]),
                })}
              </Text>
            </>
          ) : (
            <Text className="text-sm text-muted-foreground">
              {INSUFFICIENT_LABEL_KEYS[segment.reason]
                ? t(INSUFFICIENT_LABEL_KEYS[segment.reason])
                : t("sell.guidance.insufficient.fallback")}
            </Text>
          )}
        </View>
      ))}

      <Text className="text-xs text-muted-foreground">{t("sell.guidance.disclaimer")}</Text>
    </View>
  );
}
