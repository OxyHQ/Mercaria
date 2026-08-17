import { View } from "react-native";
import { Text } from "../ui/text";
import {
  COMMERCIAL_A11Y_DISCLOSURE_KEY,
  COMMERCIAL_A11Y_SELLER_KEY,
  COMMERCIAL_RIGHTS_KEY,
  commercialDisclosureExplanation,
  commercialDisclosureLabel,
  commercialSellerLabel,
} from "../../lib/commercial-copy";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import type { CommercialPresentation } from "@mercaria/shared-types";

export interface CommercialDisclosureProps {
  /** What the server said about who is selling this (#129). */
  presentation: CommercialPresentation;
  /**
   * Whether to render every disclosure's sentence under its chip.
   *
   * A product page, a checkout summary and an order page do; a cart row and a
   * grid card show the seller line and the chips alone. This is
   * `ConditionBadge`'s `showExplanation` decision, and it is the same trade:
   * the words are the accessible content, and a surface that cannot afford
   * three sentences must still afford the seller.
   */
  showExplanations?: boolean;
}

/**
 * Who is selling this, and what that means for the buyer (#129 §"Offer
 * presentation modes" and §"Content and legal copy").
 *
 * ## The seller line comes from a SWITCH, never from a field
 *
 * `CommercialPresentation` has no common `sellerLabel`, so
 * `commercialSellerLabel` must switch on the mode and there is no way to render
 * `Sold by Mercaria` over a merchant's sale by reading the wrong property —
 * acceptance 2, held by the compiler rather than by review. This component
 * likewise never inspects a price, a badge or a merchant logo to decide what to
 * say; it renders what the server derived from the offer kind and the live
 * retail binding.
 *
 * ## No colour scale, for `ConditionBadge`'s reasons plus one
 *
 * Every chip is the same neutral shape and the words carry the meaning. The
 * extra reason here is that the four modes are not a quality ranking — an
 * external referral is not a worse offer, it is a different contract — and a
 * green/amber treatment would turn a disclosure into a recommendation. #129
 * offer-detail rule 12 asks for accessibility labels that do not rely on badge
 * colour, and the simplest way to satisfy it is to have no colour to rely on.
 *
 * ## Nothing renders unless the server said it
 *
 * `presentation.disclosures` is composed once, server-side, by
 * `commercialDisclosureKeys`. This component adds none and drops none, which is
 * what "do not scatter legal role logic across individual components" means in
 * practice: an affiliate notice appears because the server decided the offer
 * needs one, not because a screen guessed from a destination URL.
 */
export function CommercialDisclosure({
  presentation,
  showExplanations = false,
}: CommercialDisclosureProps) {
  const t = useSharedUiTranslation();
  const seller = commercialSellerLabel(t, presentation);

  return (
    <View className="gap-space-8">
      <Text
        className="text-captionBold text-text"
        accessibilityRole="text"
        // The name alone would announce a company with no relation to the
        // purchase. Naming the ROLE is the `scopeLabel` convention this package
        // already uses for ratings and conditions, and here it is the whole
        // point of the component. The prefix is a KEY with a slot rather than an
        // English word glued onto a value: a screen-reader-only string is the
        // one an untranslated build never shows anybody, so nothing but a gate
        // would ever have caught it (#490).
        accessibilityLabel={t(COMMERCIAL_A11Y_SELLER_KEY, { label: seller })}
      >
        {seller}
      </Text>
      {presentation.disclosures.length > 0 ? (
        <View className="gap-space-8">
          {presentation.disclosures.map((key) => (
            <View key={key} className="gap-space-4">
              <View
                className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
                accessibilityRole="text"
                accessibilityLabel={t(COMMERCIAL_A11Y_DISCLOSURE_KEY, {
                  label: commercialDisclosureLabel(t, key),
                })}
              >
                <Text className="text-captionBold text-text">
                  {commercialDisclosureLabel(t, key)}
                </Text>
              </View>
              {showExplanations ? (
                <Text className="text-caption text-text-secondary">
                  {commercialDisclosureExplanation(t, key)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {presentation.mode === "mercaria_retail" && showExplanations ? (
        // The four consumer-rights windows, as NUMBERS from the presentation
        // rather than as a sentence written here. A placed order carries the
        // windows it was made under (#126's role snapshot), so a copy change
        // here can never restate what somebody already agreed to.
        <Text className="text-caption text-text-secondary">
          {t(COMMERCIAL_RIGHTS_KEY, {
            cancellationHours: presentation.rights.cancellationWindowHours,
            withdrawalDays: presentation.rights.withdrawalWindowDays,
            returnDays: presentation.rights.returnWindowDays,
            warrantyMonths: presentation.rights.warrantyMonths,
          })}
        </Text>
      ) : null}
    </View>
  );
}
