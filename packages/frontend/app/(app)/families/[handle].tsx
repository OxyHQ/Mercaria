import { useEffect } from "react";
import { View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SectionHeader, Skeleton, Text, formatMoney } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { CatalogProductGrid } from "@/components/brand/CatalogProductGrid";
import {
  useProductFamilyPage,
  useProductFamilyProducts,
} from "@/lib/hooks/use-catalog-pages";

/**
 * The PRODUCT-FAMILY page (#72).
 *
 * What this page adds over the brand's grid is the three facts that are true of
 * the family and not of any one generation: the attributes every member SHARES,
 * what the whole family currently costs, and an ordering that does or does not
 * imply a chronology.
 *
 * ## A thin family still answers
 *
 * A family with one member says exactly what that product's own page says. It
 * still renders — an old link must resolve, and a merge redirect depends on it —
 * and it carries `noindex`, so nothing puts it in a sitemap. Refusing to serve
 * it would break the redirect chain a merge produces.
 *
 * ## The ordering is STATED, never assumed
 *
 * `release_desc` appears only where every generation carries a release date, so
 * the page can say "newest first" truthfully. Where one does not, the ordering
 * is the catalogue's own and the page says nothing about chronology at all —
 * because whatever position an undated generation landed in would read as a
 * claim about when it came out.
 */

export default function ProductFamilyPageScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const router = useRouter();

  const { data: family, isLoading, isError } = useProductFamilyPage(handle);
  const products = useProductFamilyProducts(handle);

  // The SLUG travels, never `canonicalPath` — see the brand page for why the
  // API is not the authority on this app's route table. `canonicalPath` is
  // still the `rel=canonical` URL below, which is a different question.
  const redirectTo = family?.redirect === undefined ? undefined : family.slug;
  useEffect(() => {
    if (redirectTo !== undefined) {
      router.replace({ pathname: '/families/[handle]', params: { handle: redirectTo } });
    }
  }, [redirectTo, router]);

  if (isLoading) {
    return (
      <ScreenShell>
        <View className="flex flex-col gap-4 p-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </View>
      </ScreenShell>
    );
  }

  if (isError || !family) {
    return (
      <ScreenShell>
        <View className="flex flex-col gap-2 p-4">
          <Text className="text-lg font-semibold">Product family not found</Text>
          <Text className="text-sm text-muted-foreground">
            This family may have been merged into another, or the address may be wrong.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  const range = family.priceRange;
  const ordering = products.data?.[0]?.ordering;

  return (
    <>
      <Head>
        <title>{`${family.name} · Mercaria`}</title>
        <link rel="canonical" href={family.canonicalPath} />
        {family.indexability === "indexable" ? null : (
          <meta name="robots" content="noindex,follow" />
        )}
        {family.description.state === "displayable" ? (
          <meta name="description" content={family.description.text} />
        ) : null}
      </Head>
      <ScreenShell>
        <View className="flex flex-col gap-8 p-4">
          <View className="flex flex-col gap-1">
            {family.brand === undefined ? null : (
              <Text
                accessibilityRole="link"
                onPress={() => router.push(`/brands/${family.brand?.slug ?? ""}`)}
                className="text-sm text-muted-foreground"
              >
                {family.brand.name}
              </Text>
            )}
            <Text className="text-2xl font-semibold">{family.name}</Text>
            <Text className="text-xs text-muted-foreground">
              {family.productCount === 1
                ? "1 product in this family"
                : `${family.productCount} products in this family`}
            </Text>
          </View>

          {family.description.state === "displayable" ? (
            <Text className="text-sm">{family.description.text}</Text>
          ) : null}

          {family.offerContext === "withdrawn" ? (
            // The lever is off. Saying so is what keeps this distinguishable
            // from a family nobody currently sells (#72 brand rule 10).
            <Text className="text-sm text-muted-foreground">
              Prices are unavailable right now.
            </Text>
          ) : range === undefined ? (
            // Nothing in this family publishes a price at all. Since #464 that
            // is the ONLY thing absence means here — a family whose prices
            // exist but could not be converted takes the branch below instead
            // of this one, which used to claim it had no offers.
            <Text className="text-sm text-muted-foreground">
              No current offers for this family.
            </Text>
          ) : range.state === "unpriceable" ? (
            // There ARE current offers and not one of them could be converted.
            // Rendering "no current offers" for this was the silent exclusion
            // #464 removes: it told a shopper the family was unsold and left
            // the seller of those offers with no surface naming the reason.
            <Text className="text-sm text-muted-foreground">
              Current offers for this family are priced in{" "}
              {range.unconvertibleCurrencies.join(", ")}, which we cannot convert.
            </Text>
          ) : (
            <View className="flex flex-col gap-1">
              {/*
                `CatalogPriceRangeRanged.currency` is a `CurrencyCode`: the
                server converts every contributing offer into it and NAMES the
                ones it could not (`unconvertibleCurrencies`), so both ends go
                straight through `formatMoney` with nothing to narrow. Reaching
                this branch at all means `state === 'ranged'`, so `lowest` and
                `highest` are present by the TYPE rather than by a check (#464).

                The local `formatPrice` that used to stand here did a membership
                test on a `string` parameter it was never passed, and its dead
                else-branch rendered the amount RAW — integer MINOR units beside
                a code (#441). Taking the `CurrencyCode` directly deletes the
                narrowing and the unreachable render together; if the field is
                ever widened, these calls stop compiling rather than silently
                printing minor units.
              */}
              <Text className="text-lg font-semibold">
                {range.lowest.amount === range.highest.amount
                  ? formatMoney({ amount: range.lowest.amount, currency: range.currency })
                  : `${formatMoney({ amount: range.lowest.amount, currency: range.currency })} – ${formatMoney(
                      { amount: range.highest.amount, currency: range.currency },
                    )}`}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {CONDITION_SCOPE_TEXT[range.conditionScope]} · across{" "}
                {range.productCount === 1 ? "1 product" : `${range.productCount} products`}
              </Text>
              {range.unconvertibleCurrencies.length === 0 ? null : (
                // Named rather than silently dropped: an offer Mercaria cannot
                // convert is excluded from the range, and a reader is entitled
                // to know the range does not cover everything.
                <Text className="text-xs text-muted-foreground">
                  Excludes offers in {range.unconvertibleCurrencies.join(", ")}.
                </Text>
              )}
            </View>
          )}

          {family.sharedAttributes.length === 0 ? null : (
            <View className="flex flex-col gap-3">
              <SectionHeader title="Shared across this family" />
              <View className="flex flex-col gap-1">
                {family.sharedAttributes.map((attribute) => (
                  <Text key={attribute.key} className="text-sm text-muted-foreground">
                    {attribute.key}: {attribute.value}
                  </Text>
                ))}
              </View>
            </View>
          )}

          <View className="flex flex-col gap-3">
            <SectionHeader
              title={ordering === "release_desc" ? "Generations, newest first" : "Products"}
            />
            <CatalogProductGrid
              pages={products.data}
              isLoading={products.isLoading}
              hasNextPage={products.hasNextPage}
              isFetchingNextPage={products.isFetchingNextPage}
              onLoadMore={() => void products.fetchNextPage()}
              filtered={false}
            />
          </View>
        </View>
      </ScreenShell>
    </>
  );
}

/** What a range's condition coverage SAYS. */
const CONDITION_SCOPE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  new: "New",
  used: "Pre-owned",
  mixed: "New & pre-owned",
  unknown: "Condition not stated",
});

