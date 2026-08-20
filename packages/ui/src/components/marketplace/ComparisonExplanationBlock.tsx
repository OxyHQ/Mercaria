import { View } from "react-native";
import type { ComparisonExplanation } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  COMPARISON_NO_SUMMARY_KEY,
} from "../../lib/marketplace-labels";
import {
  COMPARISON_EXPLANATION_FALLBACK_NOTICE_KEY,
  COMPARISON_PROVENANCE_KEYS,
} from "../../lib/comparison-labels";

export interface ComparisonExplanationBlockProps {
  explanation: ComparisonExplanation;
  /** Whether to show the provenance line (#96 explanation rule 10). */
  showProvenance?: boolean;
}

/**
 * The narrative that sits ABOVE nothing (#96 UX rule 3, explanation rule 10).
 *
 * The deterministic table is rendered by its own component and does not depend
 * on this one — the page puts the table FIRST and this block after it, so a
 * missing narrative is a missing paragraph rather than a missing comparison.
 *
 * ## Every state is rendered, including the one where nothing was generated
 *
 * `unavailable` is not an empty render: a shopper looking for the summary they
 * saw last time needs to be told it is not here, and an operator needs the
 * reason to be visible somewhere other than a log. `template` renders exactly
 * like `generated` and says which it is, because "a machine wrote the
 * sentences" and "our own rules wrote them" is a distinction people care about
 * and neither is embarrassing.
 *
 * ## Provenance is a line, not a tooltip
 *
 * "Let users inspect why a recommendation was made" is answered by the
 * provenance line plus the table beneath it. There is deliberately no
 * "explain more" affordance that would fetch a second, differently-grounded
 * narrative.
 */
export function ComparisonExplanationBlock({
  explanation,
  showProvenance = true,
}: ComparisonExplanationBlockProps) {
  // Before the early return: a hook may not sit behind a branch.
  const t = useSharedUiTranslation();

  if (explanation.state === "unavailable") {
    return (
      <View className="gap-space-4 rounded-radius-12 bg-bg-fill-secondary p-space-12">
        <Text className="text-caption text-text-secondary">
          {t(COMPARISON_NO_SUMMARY_KEY)}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-space-8 rounded-radius-12 bg-bg-fill-secondary p-space-12">
      <View className="gap-space-4">
        {explanation.summary.map((sentence) => (
          <Text key={sentence.text} className="text-body text-text">
            {sentence.text}
          </Text>
        ))}
      </View>

      {explanation.points.length === 0 ? null : (
        <View className="gap-space-2">
          {explanation.points.map((point) => (
            <Text key={`${point.subjectRef}-${point.text}`} className="text-caption text-text">
              · {point.text}
            </Text>
          ))}
        </View>
      )}

      {explanation.state === "template" ? (
        <Text className="text-caption text-text-secondary">
          {t(COMPARISON_EXPLANATION_FALLBACK_NOTICE_KEY)}
        </Text>
      ) : null}

      {showProvenance ? (
        <Text className="text-caption text-text-secondary">
          {t(COMPARISON_PROVENANCE_KEYS[explanation.state], {
            policy: explanation.provenance.comparisonPolicyVersion,
          })}
        </Text>
      ) : null}
    </View>
  );
}
