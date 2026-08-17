import { View } from "react-native";
import { Text } from "../ui/text";
import {
  CONDITION_A11Y_LABEL_KEY,
  CONDITION_SELLER_WORDING_KEY,
  conditionExplanationKey,
  conditionLabelKey,
} from "../../lib/condition";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import type { ItemConditionDTO } from "@mercaria/shared-types";

export interface ConditionBadgeProps {
  /** The listing's authoritative condition (#90). */
  condition: ItemConditionDTO;
  /**
   * Whether to render the plain-language explanation under the label
   * (#90 policy rule 1). A product page does; a card in a grid does not.
   */
  showExplanation?: boolean;
}

/**
 * The item's condition, as TEXT (#90 policy rule 3).
 *
 * ## Why there is no colour scale here, and must not be one
 *
 * The obvious design is green→amber→red across the nine keys, and it fails two
 * ways at once. It is inaccessible — #90 policy rule 3 asks for accessible text,
 * not colour alone, and a red chip is unreadable to a shopper who cannot
 * distinguish it from the amber one. And it is a QUALITY VERDICT: a red
 * `for_parts` badge tells a shopper the listing is bad, when for-parts is a
 * legitimate, correctly-labelled thing to sell. So every badge is the same
 * neutral chip and the words carry the meaning.
 *
 * The `refined` flag is deliberately NOT rendered as a warning. A listing the
 * migration set to `used_good` is a real listing a buyer can buy (#90 acceptance
 * 1); the prompt to refine it belongs on the SELLER's own dashboard, not on a
 * shopper's product page, where it would read as a defect in the item rather
 * than an unfinished form.
 */
export function ConditionBadge({ condition, showExplanation = false }: ConditionBadgeProps) {
  const t = useSharedUiTranslation();
  const label = t(conditionLabelKey(condition.key));

  return (
    <View className="gap-space-4">
      <View
        className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
        accessibilityRole="text"
        // The label alone would announce "Good" with no subject. Naming what it
        // is ABOUT is the `ReviewStars` `scopeLabel` decision, one component
        // over and for the same reason: a page carries several chips and a
        // screen reader cannot tell them apart from the value alone.
        accessibilityLabel={t(CONDITION_A11Y_LABEL_KEY, { label })}
      >
        <Text className="text-captionBold text-text">{label}</Text>
      </View>
      {showExplanation ? (
        <Text className="text-caption text-text-secondary">
          {t(conditionExplanationKey(condition.key))}
        </Text>
      ) : null}
      {condition.sourceLabel ? (
        // #90 UI rule 4 and evidence rule 5: where a source's own wording
        // produced the key, showing both is what lets a shopper judge the
        // mapping rather than trust it. The seller's own words are NOT
        // translated — they are evidence, and translating evidence would defeat
        // the comparison this line exists for.
        <Text className="text-caption text-text-secondary">
          {t(CONDITION_SELLER_WORDING_KEY, { label: condition.sourceLabel })}
        </Text>
      ) : null}
    </View>
  );
}
