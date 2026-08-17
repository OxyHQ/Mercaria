import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import type {
  Listing,
  ProductSummary,
  PublicSellerProfile,
} from "@mercaria/shared-types";
import {
  ProductCard,
  ReviewStars,
  SectionHeader,
  Text,
  useFormatters,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { SellerFollowButton } from "@/components/seller/SellerFollowButton";
import { ReportSellerDialog } from "@/components/seller/ReportSellerDialog";
import { useTranslation } from "@/lib/i18n";
import { REVIEW_SCOPE_HEADING_KEYS } from "@/lib/hooks/use-reviews";
import { useSellerListings, useSellerProfile } from "@/lib/hooks/use-seller";

/** Avatar edge length (px) in the profile header. */
const AVATAR_SIZE = 88;
/** Loading-grid placeholder count. */
const SKELETON_TILE_COUNT = 8;

/**
 * What this seller's headline rating is ABOUT (#76 UI rule 6, #92 acceptance 6).
 *
 * `p2p_seller` — "Seller reputation" — and nothing else appears on this page as
 * a star rating. A product rating and an item-condition rating answer different
 * questions about different targets, and showing either here under this
 * person's name would attribute a manufacturer's defect or one copy's scuff to
 * them. Oxy Trust's tier is rendered separately and never as stars, because it
 * is not a review score and is not Mercaria's to average with one.
 */
/** KEY, not the sentence: resolved with `t()` at each render site. */
const SELLER_RATING_LABEL_KEY = REVIEW_SCOPE_HEADING_KEYS.p2p_seller;

/**
 * Human wording for Oxy Trust's tiers. Descriptive, never a Mercaria verdict.
 *
 * KEYS rather than sentences: this is module scope, so a `t()` here would run
 * before the locale store rehydrates and freeze whichever language loaded
 * first. Each key is a literal so the i18n guard can see it is referenced.
 */
const TRUST_TIER_LABEL_KEYS: Readonly<Record<string, string>> = {
  restricted: "sellers.trust.tier.restricted",
  new: "sellers.trust.tier.new",
  trusted: "sellers.trust.tier.trusted",
  high_trust: "sellers.trust.tier.highTrust",
  verified: "sellers.trust.tier.verified",
};
Object.freeze(TRUST_TIER_LABEL_KEYS);

/** Project a catalog `Listing` into the `ProductSummary` shape `ProductCard` consumes. */
function toProductSummary(listing: Listing, sellerName: string): ProductSummary {
  const firstImage = listing.images[0];
  return {
    id: listing.id,
    title: listing.title,
    brand: sellerName,
    imageUrl: firstImage?.fileId ?? "",
    // A LISTING's own rating, not the seller's. Zero here means "this page does
    // not carry per-item ratings", which is honest: the seller's reputation is
    // rendered once, above, under its own scope label.
    rating: 0,
    reviewCount: 0,
    price: listing.price,
    compareAtPrice: listing.compareAtPrice,
    saved: listing.saved,
  };
}

/** Loading placeholder grid matching the products grid rhythm. */
function GridSkeleton() {
  const { t } = useTranslation();

  return (
    <View className="flex-row flex-wrap" accessibilityLabel={t("sellers.listings.loadingLabel")}>
      {Array.from({ length: SKELETON_TILE_COUNT }).map((_, i) => (
        <View key={i} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
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

/** One labelled marketplace figure. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-24">
      <Text className="text-lg font-bold text-foreground">{value}</Text>
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}

/**
 * The identity block: avatar, name, handle, follow, report.
 *
 * Rendered for a `visible` AND a `restricted` profile. A buyer holding an order
 * from a restricted seller still needs to see who they dealt with and still
 * needs a way to report them; what a restriction withholds is the SELLING
 * surface below, not the person's name.
 */
function SellerHeader({ profile }: { profile: PublicSellerProfile }) {
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const [reportOpen, setReportOpen] = useState(false);
  const identity = profile.identity;

  if (!identity) return null;

  const avatarUrl = identity.avatar
    ? oxyServices.getFileDownloadUrl(identity.avatar, "thumb")
    : null;

  return (
    <View className="gap-4 px-4 pt-6">
      <View className="flex-row items-center gap-4">
        <View
          className="items-center justify-center overflow-hidden rounded-full bg-muted"
          style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
        >
          {avatarUrl ? (
            <Image
              source={{ uri: avatarUrl }}
              contentFit="cover"
              style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
              transition={150}
            />
          ) : (
            <Text className="text-3xl font-bold text-muted-foreground">
              {identity.displayName.slice(0, 1).toUpperCase()}
            </Text>
          )}
        </View>

        <View className="flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text numberOfLines={1} className="text-2xl font-bold text-foreground">
              {identity.displayName}
            </Text>
            {profile.marketplace?.isVerified ? (
              <View className="rounded-full bg-secondary px-2 py-0.5">
                <Text className="text-xs font-semibold text-secondary-foreground">
                  {t("sellers.verifiedBadge")}
                </Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} className="text-sm text-muted-foreground">
            {`@${identity.handle}`}
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap items-center gap-3">
        {/* The follow control. Its state, its counts and its optimistic UI all
            belong to Oxy's graph — nothing on this page holds a copy, which is
            why the profile and the product-page seller card always agree. */}
        <SellerFollowButton
          oxyUserId={identity.oxyUserId}
          displayName={identity.displayName}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("sellers.report.title", { name: identity.displayName })}
          onPress={() => setReportOpen(true)}
          className="rounded-full border border-border px-4 py-2"
        >
          <Text className="text-sm font-medium text-foreground">
            {t("sellers.report.action")}
          </Text>
        </Pressable>
      </View>

      <ReportSellerDialog
        oxyUserId={identity.oxyUserId}
        displayName={identity.displayName}
        open={reportOpen}
        onOpenChange={setReportOpen}
      />
    </View>
  );
}

/** Marketplace activity, the #76 seller aggregate and Oxy Trust — three labelled blocks. */
function SellerSignals({ profile }: { profile: PublicSellerProfile }) {
  const { t } = useTranslation();
  const { formatReviewCount } = useFormatters();
  const marketplace = profile.marketplace;
  const reviews = profile.transactionReviews;

  return (
    <View className="gap-5 px-4 pt-6">
      {marketplace ? (
        <View className="flex-row flex-wrap gap-6">
          <Stat
            label={t("sellers.stats.activeListings")}
            value={String(marketplace.activeListingCount)}
          />
          <Stat label={t("sellers.stats.itemsSold")} value={String(marketplace.salesCount)} />
          {marketplace.sellerSince ? (
            <Stat
              label={t("sellers.stats.sellingSince")}
              value={new Date(marketplace.sellerSince).getFullYear().toString()}
            />
          ) : null}
        </View>
      ) : null}

      {reviews ? (
        <View className="gap-1">
          <View className="flex-row items-center gap-2">
            <ReviewStars
              rating={reviews.rating}
              count={reviews.reviewCount}
              size={16}
              scopeLabel={t(SELLER_RATING_LABEL_KEY)}
            />
            <Text className="text-sm font-semibold text-foreground">
              {reviews.reviewCount > 0
                ? `${reviews.rating} (${formatReviewCount(reviews.reviewCount)})`
                : t("sellers.reviews.none")}
            </Text>
          </View>
          {/* The scope, spelled out. A page can carry several ratings and a
              reader must never have to guess which question one answers. */}
          <Text className="text-xs text-muted-foreground">{t(SELLER_RATING_LABEL_KEY)}</Text>
        </View>
      ) : null}

      {profile.trust ? (
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">
            {profile.trust.tier in TRUST_TIER_LABEL_KEYS
              ? t(TRUST_TIER_LABEL_KEYS[profile.trust.tier])
              : profile.trust.tier}
          </Text>
          {/* Named as Oxy's, because it IS Oxy's. Mercaria computes no trust
              score and this figure is passed through, never blended with the
              review rating above or with any activity count. */}
          <Text className="text-xs text-muted-foreground">{t("sellers.trust.source")}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The state a withheld profile renders instead of a marketplace surface. */
function WithheldNotice({ profile }: { profile: PublicSellerProfile }) {
  const { t } = useTranslation();
  const message =
    profile.withheldReason === "oxy_profile_private"
      ? t("sellers.withheld.privateProfile")
      : t("sellers.withheld.unavailable");

  return (
    <View className="items-center px-8 py-16">
      <Text className="text-center text-base text-muted-foreground">{message}</Text>
    </View>
  );
}

export default function SellerScreen() {
  const { oxyUserId } = useLocalSearchParams<{ oxyUserId: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { data: profile, isLoading, isError } = useSellerProfile(oxyUserId);

  const isVisible = profile?.visibility === "visible";
  const {
    data: pages,
    isLoading: listingsLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useSellerListings(oxyUserId, isVisible);

  const sellerName = profile?.identity?.displayName ?? t("sellers.fallbackName");
  const products = useMemo(
    () => (pages ?? []).flatMap((page) => page.listings.map((l) => toProductSummary(l, sellerName))),
    [pages, sellerName],
  );

  const head = (
    <Head>
      <title>
        {profile?.identity
          ? t("sellers.meta.title", { name: sellerName })
          : t("sellers.meta.fallbackTitle")}
      </title>
      {/* Indexability is the SERVER's derivation (#92 privacy rule 7): fully
          visible, and carrying at least one active listing. A thin page about a
          named person does not belong in an index, and a client deciding for
          itself would be a second policy that could drift from the first. Until
          the profile resolves, `noindex` is the safe default. */}
      {profile?.indexable ? null : <meta name="robots" content="noindex" />}
    </Head>
  );

  if (isLoading && !profile) {
    return (
      <ScreenShell>
        {head}
        <View className="px-4 pt-6">
          <View className="h-24 w-24 rounded-full bg-muted" />
        </View>
        <View className="pt-6">
          <GridSkeleton />
        </View>
      </ScreenShell>
    );
  }

  if (isError || !profile) {
    // Deleted, blocked, never existed, or hidden from this viewer — the server
    // answers all four identically on purpose, so this one state is the honest
    // rendering of every one of them.
    return (
      <ScreenShell>
        {head}
        <View className="items-center justify-center px-8 py-16 web:min-h-screen">
          <Text className="text-center text-base text-muted-foreground">
            {t("sellers.unavailable")}
          </Text>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      {head}
      <SellerHeader profile={profile} />

      {isVisible ? (
        <>
          <SellerSignals profile={profile} />

          <View className="pt-8">
            <SectionHeader title={t("sellers.listings.title")} />

            {listingsLoading && products.length === 0 ? <GridSkeleton /> : null}

            {!listingsLoading && products.length === 0 ? (
              <View className="items-center px-8 py-16">
                <Text className="text-center text-base text-muted-foreground">
                  {t("sellers.listings.empty", { name: sellerName })}
                </Text>
              </View>
            ) : null}

            {products.length > 0 ? (
              <View className="flex-row flex-wrap px-2">
                {products.map((product) => (
                  <View key={product.id} className="w-1/2 p-2 md:w-1/3 lg:w-1/4">
                    <ProductCard
                      product={product}
                      onPress={(id) =>
                        router.push(`/products/${id}`)
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
                  accessibilityLabel={t("sellers.listings.loadMoreLabel")}
                  disabled={isFetchingNextPage}
                  onPress={() => void fetchNextPage()}
                  className="rounded-full border border-border bg-secondary px-6 py-3 web:shadow-sm"
                >
                  <Text className="text-sm font-semibold text-foreground">
                    {isFetchingNextPage
                      ? t("sellers.listings.loadingMore")
                      : t("sellers.listings.loadMore")}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </>
      ) : (
        <WithheldNotice profile={profile} />
      )}

      <View className="h-24" />
    </ScreenShell>
  );
}
