import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import type {
  MerchantBrandStanding,
  MerchantBrandStandingKind,
} from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

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
 *
 * ## Both maps hold KEYS, and each of the six leaves is a WHOLE sentence
 *
 * Module scope, so a `t()` here would resolve before the locale store rehydrates
 * and freeze whichever language loaded first. The keys are literals so the i18n
 * guard can see each one is referenced.
 *
 * Each explanation is translated as a complete sentence rather than assembled
 * from shared fragments: the three states are three different legal claims, and
 * a shared clause is the mechanism by which two of them would come to read
 * alike in some language nobody on this team reviews.
 */
const STANDING_LABEL_KEYS: Readonly<Record<MerchantBrandStandingKind, string>> = {
  official_store: "merchants.brandStandings.label.officialStore",
  authorized_reseller: "merchants.brandStandings.label.authorizedReseller",
  no_verified_relationship: "merchants.brandStandings.label.noVerifiedRelationship",
};
Object.freeze(STANDING_LABEL_KEYS);

const STANDING_EXPLANATION_KEYS: Readonly<Record<MerchantBrandStandingKind, string>> = {
  official_store: "merchants.brandStandings.explanation.officialStore",
  authorized_reseller: "merchants.brandStandings.explanation.authorizedReseller",
  no_verified_relationship: "merchants.brandStandings.explanation.noVerifiedRelationship",
};
Object.freeze(STANDING_EXPLANATION_KEYS);

export function MerchantBrandStandings({
  standings,
}: {
  standings: readonly MerchantBrandStanding[];
}) {
  const { t } = useTranslation();
  const router = useRouter();

  if (standings.length === 0) return null;

  return (
    <View className="gap-3 px-4 pt-8">
      <Text className="text-xs uppercase text-muted-foreground">
        {t("merchants.brandStandings.title")}
      </Text>
      <View
        className="gap-3"
        accessibilityRole="list"
        accessibilityLabel={t("merchants.brandStandings.listLabel")}
      >
        {standings.map((standing) => (
          <View key={standing.brandId} className="gap-1">
            {/*
              The brand NAME is the link to #72's brand page, and this is the
              only inbound edge that page has from anywhere a shopper can
              reach — so deleting it strands `/brands/[handle]` and, through
              it, `/families/[handle]`.

              The OBJECT form, never an interpolated string: `handle` is a
              runtime value, and a computed `string` satisfies no route union,
              which is what every `as Parameters<typeof router.push>[0]` cast
              in this tree used to be saying (#330).

              `brandSlug` and not `brandId`: the route resolves either (the
              backend's `/catalog-pages/brands/:handle` takes an id, a slug or
              an alias), and the slug is the one a reader can recognise in an
              address bar.
            */}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t("merchants.brandStandings.a11yLabel", {
                brand: standing.brandName,
                standing: t(STANDING_LABEL_KEYS[standing.standing]),
                explanation: t(STANDING_EXPLANATION_KEYS[standing.standing]),
              })}
              onPress={() =>
                router.push({
                  pathname: "/brands/[handle]",
                  params: { handle: standing.brandSlug },
                })
              }
              className="flex-row flex-wrap items-center gap-2"
            >
              <Text className="text-sm font-semibold text-foreground underline">
                {standing.brandName}
              </Text>
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
                  {t(STANDING_LABEL_KEYS[standing.standing])}
                </Text>
              </View>
            </Pressable>
            <Text className="text-xs text-muted-foreground">
              {t(STANDING_EXPLANATION_KEYS[standing.standing])}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
