import { View } from "react-native";
import { Text } from "@mercaria/ui";
import type { SellerPriceGuidance, SellerPriceGuidanceSegment } from "@mercaria/shared-types";
import { formatMoney } from "@mercaria/ui";

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

const SEGMENT_LABELS: Record<SellerPriceGuidanceSegment["kind"], string> = {
  current_same_condition: "Similar condition, on sale now",
  current_new: "New, on sale now",
  current_refurbished: "Refurbished, on sale now",
  recent_sold_native: "Recently sold on Mercaria",
};

const INSUFFICIENT_LABELS: Record<string, string> = {
  no_observations: "No comparable offers yet",
  below_sample_floor: "Not enough comparable offers yet",
  below_seller_floor: "Not enough different sellers to show a range",
};

export function PriceGuidancePanel({ guidance }: PriceGuidancePanelProps) {
  return (
    <View className="gap-3 rounded-2xl border border-border p-4">
      <Text className="text-base font-medium">Price guidance</Text>
      <Text className="text-xs text-muted-foreground">
        {guidance.market ? `${guidance.market} · ` : ""}
        {guidance.currency} · since {new Date(guidance.from).toLocaleDateString()}
      </Text>

      {guidance.segments.map((segment) => (
        <View key={segment.kind} className="gap-1">
          <Text className="text-sm font-medium">{SEGMENT_LABELS[segment.kind]}</Text>
          {segment.state === "available" ? (
            <>
              <Text className="text-base">
                {formatMoney(segment.low)} – {formatMoney(segment.high)}
              </Text>
              <Text className="text-xs text-muted-foreground">
                Typical {formatMoney(segment.median)} · {segment.sampleSize} offers ·{" "}
                {segment.confidence} confidence
              </Text>
            </>
          ) : (
            <Text className="text-sm text-muted-foreground">
              {INSUFFICIENT_LABELS[segment.reason] ?? "Not enough data yet"}
            </Text>
          )}
        </View>
      ))}

      <Text className="text-xs text-muted-foreground">
        Guidance never sets your price, does not guarantee a sale, and does not stop you
        listing at any price you choose.
      </Text>
    </View>
  );
}
