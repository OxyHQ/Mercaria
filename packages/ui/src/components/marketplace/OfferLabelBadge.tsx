import { View } from "react-native";
import type { OfferLabelAward } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { formatDistance, formatMoney } from "../../lib/format";
import {
  OFFER_LABEL_A11Y_WITH_BASIS_KEY,
  OFFER_LABEL_BADGE_WITH_BASIS_KEY,
  OFFER_LABEL_DAYS_KEY,
  offerLabelExplanationKey,
  offerLabelTextKey,
} from "../../lib/offer-labels";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import type { Translate } from "../../i18n/create-app-i18n";

export interface OfferLabelBadgeProps {
  /** ONE award. A badge never summarises several (#74 §"Labels"). */
  award: OfferLabelAward;
  /**
   * Whether to render the sentence explaining WHY the label was awarded
   * (#71 offer row 9). A comparison row does; a dense card does not.
   */
  showExplanation?: boolean;
}

/**
 * One #74 comparison label, as TEXT.
 *
 * ## No colour scale, for `ConditionBadge`'s reason and one more
 *
 * Every badge is the same neutral chip and the words carry the meaning. The
 * accessibility argument is the same one condition makes — colour alone is not
 * a label — and the second reason is specific to a comparison: a green
 * "cheapest" beside a grey "official store" reads as a recommendation ranking
 * the two, when #74 awards them INDEPENDENTLY and neither is a summary of the
 * other. #71 UX rule 4 states the price half of it outright: price and currency
 * are never conveyed through colour alone.
 *
 * ## The figure comes from the AWARD
 *
 * `basis` is whatever earned the label — a converted `Money`, a day count, a
 * distance — and it is rendered rather than recomputed, so what a shopper reads
 * is the number the server actually ranked on. A badge that recomputed it would
 * be a second answer to "how much", and the two would disagree the first time a
 * rate moved between the ranking and the render.
 */
export function OfferLabelBadge({ award, showExplanation = false }: OfferLabelBadgeProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();
  const label = t(offerLabelTextKey(award.label));
  const basis = basisText(award, t, locale);

  return (
    <View className="gap-space-4">
      <View
        className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
        accessibilityRole="text"
        // The label alone announces "Cheapest new" with no subject and no
        // figure. Naming both is the `ConditionBadge` decision: a row carries
        // several chips and a screen reader cannot tell them apart from the
        // words alone.
        accessibilityLabel={
          basis === undefined ? label : t(OFFER_LABEL_A11Y_WITH_BASIS_KEY, { label, basis })
        }
      >
        <Text className="text-captionBold text-text">
          {basis === undefined ? label : t(OFFER_LABEL_BADGE_WITH_BASIS_KEY, { label, basis })}
        </Text>
      </View>
      {showExplanation ? (
        <Text className="text-caption text-text-secondary">{t(offerLabelExplanationKey(award))}</Text>
      ) : null}
    </View>
  );
}

/**
 * The award's own figure, rendered.
 *
 * Returns nothing for a STANDING label, which has no figure and must not be
 * given one: "official direct store · 0" is a number that means nothing, and
 * inventing a basis for a label that states a fact rather than a comparison is
 * the shape of a UI claiming more than the server established.
 */
function basisText(award: OfferLabelAward, t: Translate, locale: string): string | undefined {
  if (award.amount !== undefined) return formatMoney(award.amount, locale);
  if (award.days !== undefined) {
    // A pluralised key rather than `=== 1`, which is the English plural rule
    // written into a component that renders in twelve languages.
    return t(OFFER_LABEL_DAYS_KEY, { count: award.days });
  }
  // Shared with #93's location surfaces since that issue's client half: one
  // metre count must not render two ways depending on which screen shows it.
  if (award.metres !== undefined) return formatDistance(award.metres, locale);
  return undefined;
}
