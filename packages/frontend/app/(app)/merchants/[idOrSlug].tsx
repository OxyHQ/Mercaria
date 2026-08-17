import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import type {
  MerchantCatalogEmptyReason,
  MerchantOfferMixBucket,
  MerchantPage,
} from "@mercaria/shared-types";
import { ReviewStars, SectionHeader, Text, formatReviewCount } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { MerchantBrandStandings } from "@/components/merchant/MerchantBrandStandings";
import { MerchantChannelPicker } from "@/components/merchant/MerchantChannelPicker";
import { MerchantProductCard } from "@/components/merchant/MerchantProductCard";
import { MerchantStandingBanner } from "@/components/merchant/MerchantStandingBanner";
import { useTranslation } from "@/lib/i18n";
import { REVIEW_SCOPE_HEADING_KEYS } from "@/lib/hooks/use-reviews";
import { useMerchantCatalog, useMerchantPage } from "@/lib/hooks/use-merchant-page";

/**
 * The merchant page (#73).
 *
 * ## Four things, and this screen keeps them apart
 *
 * The MERCHANT is the header and the standing. A STOREFRONT is a chip in the
 * channel picker, which names its operator when that is somebody else. A native
 * Mercaria STORE is a LINK — never an embedded store experience and never a
 * follow control, because the follow identity lives on the store route and a
 * second one for the same shop is unrepairable (#73 native-store rules 2 and
 * 3). A BRAND is a relationship state with three possible answers, rendered by
 * its own component.
 *
 * ## One rating, under its own scope label
 *
 * `merchant` and nothing else. A merchant page can reach four rating
 * aggregates — the merchant's, a linked store's, each product's and each
 * seller's — and they answer four different questions. The catalogue cards
 * carry no rating at all, which is why they are `MerchantProductCard` and not
 * `ProductCard` (#73 trust rule 5).
 *
 * ## What it never renders
 *
 * No claim evidence, no operator note, no address, no physical location and no
 * store member list. None of them is on the response — the server's projection
 * names every field and a gate walks a real emitted page for the forbidden
 * ones — so there is nothing here to leave out by accident.
 */

/** Loading-grid placeholder count. */
const SKELETON_TILE_COUNT = 8;

/**
 * What an empty catalogue means, in words a shopper can act on.
 *
 * KEYS rather than sentences: this is module scope, so a `t()` here would run
 * before the locale store rehydrates and freeze whichever language loaded
 * first. Each key is a literal so the i18n guard can see it is referenced. The
 * honest stale-source state — a statement about Mercaria's information rather
 * than about the shop's shelves (#73 catalogue-browse rule 6) — keeps its own
 * leaf for that reason.
 */
const EMPTY_COPY_KEYS: Readonly<Record<MerchantCatalogEmptyReason, string>> = {
  no_offers: "merchants.catalog.empty.noOffers",
  stale_sources: "merchants.catalog.empty.staleSources",
  filtered_out: "merchants.catalog.empty.filteredOut",
};
Object.freeze(EMPTY_COPY_KEYS);

/** Loading placeholder grid matching the products grid rhythm. */
function GridSkeleton() {
  const { t } = useTranslation();

  return (
    <View className="flex-row flex-wrap" accessibilityLabel={t("merchants.catalog.loadingLabel")}>
      {Array.from({ length: SKELETON_TILE_COUNT }).map((_, index) => (
        <View key={index} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
          <View className="gap-2">
            <View className="aspect-square w-full rounded-2xl bg-muted" />
            <View className="h-3 w-1/2 rounded bg-muted" />
            <View className="h-3 w-3/4 rounded bg-muted" />
          </View>
        </View>
      ))}
    </View>
  );
}

/** One counted chip from the offer mix. */
function MixChip({ label, count }: { label: string; count: number }) {
  return (
    <View className="rounded-full bg-muted px-3 py-1">
      <Text className="text-xs text-muted-foreground">{`${label} · ${String(count)}`}</Text>
    </View>
  );
}

/**
 * The offer mix (#73 merchant requirement 7).
 *
 * `staleOfferCount` gets its own sentence rather than a chip: it is not a
 * category of what this merchant sells, it is a statement about how current
 * Mercaria's picture of it is, and filing it beside "New · 12" would read as a
 * twelfth kind of product.
 */
function OfferMix({ page }: { page: MerchantPage }) {
  const { t } = useTranslation();
  const mix = page.offerMix;
  const chips = useMemo(() => {
    const named: { label: string; count: number }[] = [];
    for (const bucket of mix.byKind) named.push({ label: bucket.key, count: bucket.count });
    for (const bucket of mix.byCondition) named.push({ label: bucket.key, count: bucket.count });
    for (const bucket of mix.byMarket as readonly MerchantOfferMixBucket<string | null>[]) {
      named.push({
        // A market-less offer is available everywhere; calling it "Unknown"
        // would misreport an explicit fact as a gap.
        label: bucket.key ?? t("merchants.offerMix.allMarkets"),
        count: bucket.count,
      });
    }
    return named;
    // `t` changes identity with the locale, so it belongs here: without it the
    // fallback above would keep the language that was current when this page
    // first rendered.
  }, [mix, t]);

  if (mix.activeOfferCount === 0) return null;

  return (
    <View className="gap-2 px-4 pt-6">
      <Text className="text-xs uppercase text-muted-foreground">
        {t("merchants.offerMix.title")}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {chips.map((chip) => (
          <MixChip key={`${chip.label}-${String(chip.count)}`} label={chip.label} count={chip.count} />
        ))}
      </View>
      {mix.staleOfferCount > 0 ? (
        <Text className="text-xs text-muted-foreground">
          {t("merchants.offerMix.staleNotice", { count: mix.staleOfferCount })}
        </Text>
      ) : null}
    </View>
  );
}

export default function MerchantScreen() {
  const { idOrSlug } = useLocalSearchParams<{ idOrSlug: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const [storefrontId, setStorefrontId] = useState<string | undefined>(undefined);

  const { data: page, isLoading, isError } = useMerchantPage(idOrSlug);
  const browseParams = useMemo(
    () => (storefrontId === undefined ? {} : { storefrontId }),
    [storefrontId],
  );
  const {
    data: pages,
    isLoading: catalogLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useMerchantCatalog(idOrSlug, browseParams, Boolean(page));

  const entries = useMemo(() => (pages ?? []).flatMap((catalog) => catalog.entries), [pages]);
  const emptyReason = (pages ?? [])[0]?.emptyReason;

  /**
   * Every channel worth offering as a scope: the ones this merchant OPERATES
   * (requirement 4, "current storefronts by market or channel") and the ones it
   * SELLS THROUGH (requirement 3, which for a marketplace seller is somebody
   * else's channel).
   *
   * The union rather than either list alone. A first-party retailer's German
   * site with nothing current on it still belongs here — selecting it answers
   * "we know about this channel and have nothing from it right now", which is a
   * fact, and dropping it would make an operated channel invisible. The
   * `sellingChannels` entry wins a collision because it is the one the server
   * counted this merchant's own offers into.
   */
  const channels = useMemo(() => {
    const byId = new Map((page?.operatedChannels ?? []).map((c) => [c.storefront.id, c]));
    for (const channel of page?.sellingChannels ?? []) byId.set(channel.storefront.id, channel);
    return [...byId.values()];
  }, [page]);

  const head = (
    <Head>
      <title>
        {page
          ? t("merchants.meta.title", { name: page.merchant.name })
          : t("merchants.meta.fallbackTitle")}
      </title>
    </Head>
  );

  if (isLoading && !page) {
    return (
      <ScreenShell>
        {head}
        <View className="px-4 pt-6">
          <View className="h-8 w-2/3 rounded bg-muted" />
        </View>
        <View className="pt-6">
          <GridSkeleton />
        </View>
      </ScreenShell>
    );
  }

  if (isError || !page) {
    // A suppressed merchant and one that never existed are answered
    // identically by the server, so this one state is the honest rendering of
    // both.
    return (
      <ScreenShell>
        {head}
        <View className="items-center justify-center px-8 py-16 web:min-h-screen">
          <Text className="text-center text-base text-muted-foreground">
            {t("merchants.unavailable")}
          </Text>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      {head}

      <View className="gap-2 px-4 pt-6">
        <Text className="text-2xl font-bold text-foreground">{page.merchant.name}</Text>
        {page.aliases.length > 0 ? (
          <Text numberOfLines={2} className="text-sm text-muted-foreground">
            {t("merchants.alsoKnownAs", {
              names: page.aliases.map((alias) => alias.alias).join(", "),
            })}
          </Text>
        ) : null}
        {/* The operating legal entity, shown only when a verified relationship
            covers this instant AND it says something the merchant's own name
            does not. Absent is the normal state. */}
        {page.organization ? (
          <Text className="text-sm text-muted-foreground">
            {t("merchants.operatedBy", {
              organization: page.organization.legalName ?? page.organization.name,
            })}
          </Text>
        ) : null}
      </View>

      <MerchantStandingBanner
        standing={page.standing}
        onClaim={() =>
          router.push(
            `/settings/general?claimMerchant=${encodeURIComponent(
              page.merchant.id,
            )}`,
          )
        }
      />

      {page.reviews ? (
        <View className="gap-1 px-4 pt-6">
          <View className="flex-row items-center gap-2">
            <ReviewStars
              rating={page.reviews.rating}
              count={page.reviews.reviewCount}
              size={16}
              scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.merchant)}
            />
            <Text className="text-sm font-semibold text-foreground">
              {page.reviews.reviewCount > 0
                ? `${String(page.reviews.rating)} (${formatReviewCount(page.reviews.reviewCount)})`
                : t("merchants.reviews.none")}
            </Text>
          </View>
          {/* The scope, spelled out. A page can carry several ratings and a
              reader must never have to guess which question one answers. */}
          <Text className="text-xs text-muted-foreground">{t(REVIEW_SCOPE_HEADING_KEYS.merchant)}</Text>
        </View>
      ) : null}

      {/* The native store is a LINK. No follow control, no embedded store
          experience, no policies rendered here — those belong to the store
          route and to the store APIs that own them (#73 native-store rules 2
          and 4). */}
      {page.nativeStore ? (
        <View className="px-4 pt-6">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t("merchants.nativeStore.openLabel", {
              store: page.nativeStore.name,
            })}
            onPress={() =>
              router.push(
                `/stores/${encodeURIComponent(
                  page.nativeStore?.handle ?? "",
                )}`,
              )
            }
            className="rounded-2xl border border-border p-4"
          >
            <Text className="text-sm font-semibold text-foreground">
              {t("merchants.nativeStore.title", { store: page.nativeStore.name })}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t("merchants.nativeStore.note")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <OfferMix page={page} />

      <MerchantChannelPicker
        channels={channels}
        selectedStorefrontId={storefrontId}
        onSelect={setStorefrontId}
      />

      <MerchantBrandStandings standings={page.brandStandings} />

      <View className="pt-8">
        <SectionHeader title={t("merchants.catalog.title")} />

        {catalogLoading && entries.length === 0 ? <GridSkeleton /> : null}

        {!catalogLoading && entries.length === 0 ? (
          <View className="items-center px-8 py-16">
            <Text className="text-center text-base text-muted-foreground">
              {t(emptyReason ? EMPTY_COPY_KEYS[emptyReason] : EMPTY_COPY_KEYS.no_offers)}
            </Text>
          </View>
        ) : null}

        {entries.length > 0 ? (
          <View className="flex-row flex-wrap px-2">
            {entries.map((entry) => (
              <View key={entry.canonicalProductId} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
                <MerchantProductCard
                  entry={entry}
                  onPress={(canonicalProductId) =>
                    router.push(`/products/${canonicalProductId}`)
                  }
                />
              </View>
            ))}
          </View>
        ) : null}

        {hasNextPage ? (
          <View className="items-center px-4 py-6">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("merchants.catalog.loadMoreLabel")}
              disabled={isFetchingNextPage}
              onPress={() => void fetchNextPage()}
              className="rounded-full border border-border bg-secondary px-6 py-3 web:shadow-sm"
            >
              <Text className="text-sm font-semibold text-foreground">
                {isFetchingNextPage
                  ? t("merchants.catalog.loadingMore")
                  : t("merchants.catalog.loadMore")}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View className="h-24" />
    </ScreenShell>
  );
}
