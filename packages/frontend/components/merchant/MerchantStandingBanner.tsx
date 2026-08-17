import { Pressable, View } from "react-native";
import type {
  MerchantPageStanding,
  MerchantPublicStanding,
} from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/**
 * The merchant's standing and the `Claim this merchant` action
 * (#73 merchant requirements 2 and 11, acceptance 4 and 7).
 *
 * ## Safe public language, from a closed vocabulary
 *
 * The server derives one of four labels from two published facts and the copy
 * for each lives here. Nothing on this surface says a claim was REJECTED, that
 * an operator is reviewing EVIDENCE, or how many people are claiming — each is
 * a statement about a person's dealings with Mercaria, and this page is one
 * anybody can load. `claimInProgress` is a boolean signal precisely so it can
 * be rendered without naming anybody (#83).
 *
 * ## The claim action is offered, never asserted
 *
 * The button appears exactly when the server says `claimable`, and pressing it
 * hands over to #40/#83's claiming flow. It is not shown for a claimed merchant
 * and it is not hidden merely because somebody else has a claim open — a first
 * mover must not be able to lock the real operator out by squatting, which is
 * #83's own rule and the reason `claimInProgress` is a signal rather than a
 * refusal.
 *
 * Both maps hold KEYS rather than sentences: they are module scope, so a `t()`
 * here would resolve before the locale store rehydrates and freeze whichever
 * language loaded first. The keys are literals so the i18n guard can see each
 * one is referenced.
 */
const STANDING_LABEL_KEYS: Readonly<Record<MerchantPublicStanding, string>> = {
  unclaimed: "merchants.standing.label.unclaimed",
  claim_in_progress: "merchants.standing.label.claimInProgress",
  claimed: "merchants.standing.label.claimed",
  selling_on_mercaria: "merchants.standing.label.sellingOnMercaria",
};
Object.freeze(STANDING_LABEL_KEYS);

const STANDING_EXPLANATION_KEYS: Readonly<Record<MerchantPublicStanding, string>> = {
  unclaimed: "merchants.standing.explanation.unclaimed",
  claim_in_progress: "merchants.standing.explanation.claimInProgress",
  claimed: "merchants.standing.explanation.claimed",
  selling_on_mercaria: "merchants.standing.explanation.sellingOnMercaria",
};
Object.freeze(STANDING_EXPLANATION_KEYS);

export function MerchantStandingBanner({
  standing,
  onClaim,
}: {
  standing: MerchantPageStanding;
  onClaim: () => void;
}) {
  const { t } = useTranslation();
  const label = t(STANDING_LABEL_KEYS[standing.standing]);

  return (
    <View className="gap-2 px-4 pt-4">
      <View className="flex-row flex-wrap items-center gap-2">
        <View className="rounded-full bg-secondary px-3 py-1">
          <Text
            className="text-xs font-semibold text-secondary-foreground"
            accessibilityRole="text"
            accessibilityLabel={t("merchants.standing.a11yLabel", { status: label })}
          >
            {label}
          </Text>
        </View>
        {standing.eligibility.claimable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("merchants.standing.claim")}
            accessibilityHint={t("merchants.standing.claimHint")}
            onPress={onClaim}
            className="rounded-full border border-border px-4 py-2"
          >
            <Text className="text-sm font-medium text-foreground">
              {t("merchants.standing.claim")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text className="text-xs text-muted-foreground">
        {t(STANDING_EXPLANATION_KEYS[standing.standing])}
      </Text>
    </View>
  );
}
