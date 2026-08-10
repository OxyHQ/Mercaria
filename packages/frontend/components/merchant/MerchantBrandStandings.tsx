import { View } from "react-native";
import type {
  MerchantBrandStanding,
  MerchantBrandStandingKind,
} from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";

/**
 * The three brand relationship states, with three different labels and three
 * different sentences (#73 relationship-display rules 1–3, acceptance 7).
 *
 * ## Three states, not a badge and its absence
 *
 * An ordinary retailer selling a brand holds no relationship row at all (ADR
 * 0002 D10), so silence is the NORMAL case — and a page that rendered silence
 * would leave a reader unable to tell "we checked and there is none" from "we
 * have not looked". The third state says which, in its own words.
 *
 * ## The copy is the enforcement
 *
 * `official_store` and `authorized_reseller` are different claims about
 * different arrangements, and #55 keeps them as separate kinds, separate badges
 * and separate lists precisely so a page cannot blur them into "verified". The
 * labels below never share a word that would let them read as the same thing.
 *
 * A claimed merchant cannot edit any of this: the page is a read, there is no
 * write route behind it, and the verification lives on a `commerce_relationships`
 * row an operator approved under four eyes.
 */
const STANDING_LABEL: Readonly<Record<MerchantBrandStandingKind, string>> = Object.freeze({
  official_store: "Brand’s own store",
  authorized_reseller: "Authorized reseller",
  no_verified_relationship: "No verified relationship",
});

const STANDING_EXPLANATION: Readonly<Record<MerchantBrandStandingKind, string>> = Object.freeze({
  official_store: "This merchant is the brand’s own sales channel, verified by Mercaria.",
  authorized_reseller: "The brand has authorized this merchant to resell it, verified by Mercaria.",
  no_verified_relationship:
    "This merchant sells products of this brand. Mercaria has verified no relationship between them.",
});

export function MerchantBrandStandings({
  standings,
}: {
  standings: readonly MerchantBrandStanding[];
}) {
  if (standings.length === 0) return null;

  return (
    <View className="gap-3 px-4 pt-8">
      <Text className="text-xs uppercase text-muted-foreground">Brands</Text>
      <View className="gap-3" accessibilityRole="list" accessibilityLabel="Brand relationships">
        {standings.map((standing) => (
          <View
            key={standing.brandId}
            className="gap-1"
            accessibilityRole="text"
            accessibilityLabel={`${standing.brandName}: ${STANDING_LABEL[standing.standing]}. ${
              STANDING_EXPLANATION[standing.standing]
            }`}
          >
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="text-sm font-semibold text-foreground">{standing.brandName}</Text>
              <View
                className={`rounded-full px-2 py-0.5 ${
                  standing.badge === null ? "bg-muted" : "bg-secondary"
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    standing.badge === null ? "text-muted-foreground" : "text-secondary-foreground"
                  }`}
                >
                  {STANDING_LABEL[standing.standing]}
                </Text>
              </View>
            </View>
            <Text className="text-xs text-muted-foreground">
              {STANDING_EXPLANATION[standing.standing]}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
