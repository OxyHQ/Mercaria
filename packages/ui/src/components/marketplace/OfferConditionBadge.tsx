import { View } from "react-native";
import type { OfferConditionDTO } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { conditionExplanation, conditionLabel } from "../../lib/condition";

export interface OfferConditionBadgeProps {
  /** An OFFER's condition (#90) — the taxonomy plus an honest `unknown`. */
  condition: OfferConditionDTO;
  /** Whether to render the plain-language explanation (#90 policy rule 1). */
  showExplanation?: boolean;
}

/**
 * An OFFER's condition, as text.
 *
 * ## Why this is not `ConditionBadge`
 *
 * A LISTING's condition is one of nine taxonomy keys — a seller always knows
 * what they are selling. An OFFER's may be `unknown`, because most external
 * feeds publish no condition at all, and that value has no label, no
 * explanation and no group. `ItemConditionDTO` and `OfferConditionDTO` are
 * different types for that reason, and one component serving both would need a
 * fallback for the unknown key — which is exactly where "New" gets rendered for
 * an item nobody described.
 *
 * So the unknown branch is a DIFFERENT sentence rather than a missing one: it
 * says the seller did not state a condition, which is a fact about the listing
 * and not about the item.
 *
 * Neutral chrome, never colour alone — `ConditionBadge`'s reasoning, verbatim.
 */
export function OfferConditionBadge({
  condition,
  showExplanation = false,
}: OfferConditionBadgeProps) {
  // Narrowed by the KEY rather than by a boolean beside it: `conditionLabel`
  // takes a taxonomy key and `unknown` is not one, so the compiler is what
  // stops an unknown condition being handed to a function that has no answer
  // for it.
  const key = condition.key;
  const label = key === "unknown" ? "Condition not stated" : conditionLabel(key);

  return (
    <View className="gap-space-4">
      <View
        className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
        accessibilityRole="text"
        accessibilityLabel={key === "unknown" ? label : `Condition: ${label}`}
      >
        <Text className="text-captionBold text-text">{label}</Text>
      </View>
      {showExplanation && key !== "unknown" ? (
        <Text className="text-caption text-text-secondary">{conditionExplanation(key)}</Text>
      ) : null}
      {condition.sourceLabel ? (
        // The source's own wording beside the normalized key (#90 UI rule 4):
        // what lets a shopper judge the mapping rather than trust it, and what
        // makes an operator's later correction of the RULE visible as a
        // correction rather than as a silent change of fact.
        <Text className="text-caption text-text-secondary">
          The seller describes it as “{condition.sourceLabel}”.
        </Text>
      ) : null}
    </View>
  );
}
