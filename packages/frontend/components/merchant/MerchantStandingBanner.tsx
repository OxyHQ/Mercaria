import { Pressable, View } from "react-native";
import type {
  MerchantPageStanding,
  MerchantPublicStanding,
} from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";

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
 */
const STANDING_LABEL: Readonly<Record<MerchantPublicStanding, string>> = Object.freeze({
  unclaimed: "Unclaimed",
  claim_in_progress: "Claim in progress",
  claimed: "Claimed",
  selling_on_mercaria: "Sells on Mercaria",
});

const STANDING_EXPLANATION: Readonly<Record<MerchantPublicStanding, string>> = Object.freeze({
  unclaimed:
    "Nobody has proved they operate this merchant. Its products are listed here from public sources.",
  claim_in_progress: "Somebody is proving they operate this merchant.",
  claimed: "An operator has proved they run this merchant.",
  selling_on_mercaria: "This merchant is connected to a Mercaria store and sells here directly.",
});

export function MerchantStandingBanner({
  standing,
  onClaim,
}: {
  standing: MerchantPageStanding;
  onClaim: () => void;
}) {
  const label = STANDING_LABEL[standing.standing];

  return (
    <View className="gap-2 px-4 pt-4">
      <View className="flex-row flex-wrap items-center gap-2">
        <View className="rounded-full bg-secondary px-3 py-1">
          <Text
            className="text-xs font-semibold text-secondary-foreground"
            accessibilityRole="text"
            accessibilityLabel={`Merchant status: ${label}`}
          >
            {label}
          </Text>
        </View>
        {standing.eligibility.claimable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Claim this merchant"
            accessibilityHint="Prove that you operate this merchant to manage its page"
            onPress={onClaim}
            className="rounded-full border border-border px-4 py-2"
          >
            <Text className="text-sm font-medium text-foreground">Claim this merchant</Text>
          </Pressable>
        ) : null}
      </View>
      <Text className="text-xs text-muted-foreground">
        {STANDING_EXPLANATION[standing.standing]}
      </Text>
    </View>
  );
}
