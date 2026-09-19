import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Review } from '@mercaria/shared-types';
import {
  AssetLicenceSummary,
  AssetPreviewViewer,
  AssetTechnicalPanel,
  ReviewSummaryCard,
  Text,
  type RatingDistribution,
} from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { DigitalPackagePicker } from '@/components/digital/DigitalPackagePicker';
import { DigitalSurfaceNotice } from '@/components/digital/DigitalSurfaceNotice';
import { DigitalVersionHistory } from '@/components/digital/DigitalVersionHistory';
import { digitalCreatorHref } from '@/lib/digital/routes';
import { digitalAssetPageSource } from '@/lib/digital/source';
import { REVIEW_SCOPE_HEADING_KEYS, useProductScopeReviews } from '@/lib/hooks/use-reviews';
import { useTranslation } from '@/lib/i18n';

/**
 * `/3d/:slug` — one digital work's page (#1015 Workstream 5).
 *
 * ## The nine things this page owes a buyer, and where each comes from
 *
 * #1015 W5 asks a digital product page to make clear what the work is, who made
 * it, which packages exist, which formats are included, which licence the
 * SELECTED offer grants, whether updates are included, the technical metadata
 * WITH ITS PROVENANCE, the seller's guidance, the version history, the
 * interactive preview, and verified-purchase reviews. None of those is composed
 * here:
 *
 * | What | Who renders it | Why there |
 * |---|---|---|
 * | the preview | `AssetPreviewViewer` | its `source` prop takes only an admitted PUBLIC file — see below |
 * | packages and formats | `DigitalPackagePicker` | a package is a variant (ADR 0010 D2); a format is not (#1015 boundary 6) |
 * | the licence and updates | `AssetLicenceSummary` | renders the frozen `DigitalLicenceVersionTerms` a purchase pins (D3/D4) |
 * | measured vs claimed | `AssetTechnicalPanel` | two props of two types, because D12 makes them two tables |
 * | versions and changes | `DigitalVersionHistory` | the label is the creator's; nothing is derived from it |
 * | reviews | `ReviewSummaryCard` | a digital product is an ordinary canonical product, so #76's domain answers, `unverified` counted separately |
 *
 * This file holds ONE piece of logic, and it is the one ADR 0010 D2 puts here:
 * which PACKAGE is selected. Selecting one changes the price and the licence
 * together, because both belong to the option that variant is bound to.
 *
 * ## The viewer cannot be handed the paid files, and not because this file is careful
 *
 * `AssetPreviewViewer`'s `source` is an `AssetPreviewSource`, constructible only
 * by `@mercaria/ui`'s `admitAssetPreview` (the brand is a module-private symbol),
 * which refuses every role outside `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES`. So this
 * screen has no file list, no storage key and nothing it could filter wrongly —
 * passing a `mesh` would not type-check anywhere on the path. #1015 W4's closing
 * line is held by the type rather than by review.
 *
 * ## Today it renders a sentence
 *
 * There is no client-reachable asset read (`lib/digital/source.ts`,
 * `HANDOFF.md` §6), so `digitalAssetPageSource` answers `unavailable` and the
 * page says so. The composition below is what runs when the read lands.
 */

/** How many reviews the product scope fetches for the card's carousel. */
const REVIEW_PAGE_LIMIT = 12;

/**
 * Count per star bucket, for the distribution bars.
 *
 * Mirrors `products/[id].tsx`'s private helper deliberately rather than importing
 * it: that one is local to a screen this workstream does not own, and a shared
 * one belongs in `@mercaria/ui` beside `ReviewSummaryCard` — a move that would
 * touch #76's component and is not this change's to make.
 */
function distributionOf(reviews: readonly Review[]): RatingDistribution {
  const distribution: RatingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const review of reviews) {
    const bucket = Math.round(review.rating);
    if (bucket >= 1 && bucket <= 5) {
      distribution[bucket] += 1;
    }
  }
  return distribution;
}

export default function DigitalAssetScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ slug: string }>();
  const handle = params.slug ?? '';

  const source = digitalAssetPageSource(handle);
  const view = source.kind === 'ready' ? source.value : undefined;

  /**
   * Which package is selected, or `null` for "whatever the read lists first".
   *
   * `null` rather than the first id copied into state at mount: state seeded from
   * data is state that can disagree with it, and the selection has to survive the
   * read arriving.
   */
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const selectedPackage =
    view?.packages.find((offer) => offer.packageId === selectedPackageId) ?? view?.packages[0];

  /*
   * Reviews are #76's, keyed on the canonical product — `undefined` disables the
   * query, which is why this hook sits unconditionally at the top with no branch
   * around it.
   */
  const reviewsQuery = useProductScopeReviews(view?.canonicalProductId, 1, REVIEW_PAGE_LIMIT);
  const reviews = useMemo(() => reviewsQuery.data?.data ?? [], [reviewsQuery.data]);
  const aggregate = reviewsQuery.data?.aggregate;
  const distribution = useMemo(() => distributionOf(reviews), [reviews]);

  const title = view?.title ?? t('digital.asset.fallbackTitle');

  return (
    <ScreenShell contentClassName="pt-6">
      <Head>
        <title>{t('digital.documentTitle', { title })}</title>
        {view?.summary === undefined ? null : (
          <meta name="description" content={view.summary} />
        )}
      </Head>

      <View className="mb-space-32 gap-space-24 web:mx-auto web:w-full web:max-w-[1200px] md:px-5">
        {source.kind === 'unavailable' || view === undefined ? (
          <DigitalSurfaceNotice
            reason={source.kind === 'unavailable' ? source.reason : 'no_digital_read_surface'}
          />
        ) : (
          <>
            <View className="gap-space-4">
              <Text className="text-headerBold text-text" accessibilityRole="header">
                {view.title}
              </Text>
              {/* Who made it, as a link to their page — one of W5's four
                  surfaces, and the OBJECT form so a typo fails `tsc`. */}
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={t('digital.asset.viewCreator', { creator: view.creator.name })}
                onPress={() => router.push(digitalCreatorHref(view.creator.slug))}
              >
                <Text className="text-bodySmall text-text-brand">
                  {t('digital.asset.creatorLine', { creator: view.creator.name })}
                </Text>
              </Pressable>
              {view.summary === undefined ? null : (
                <Text className="text-body text-text-secondary">{view.summary}</Text>
              )}
            </View>

            <View className="gap-space-24 md:flex-row">
              <View className="flex-1 gap-space-8">
                <Text className="text-captionBold text-text" accessibilityRole="header">
                  {t('digital.asset.previewTitle')}
                </Text>
                {/*
                  No `renderer` is passed: no WebGL/three.js dependency is
                  installed in this app and #1015 W4 does not authorize adding
                  one, so the viewer takes its accessible static path. The prop is
                  the seam — see the component's note.
                */}
                <AssetPreviewViewer
                  title={view.title}
                  {...(view.preview === undefined ? {} : { source: view.preview })}
                  {...(view.previewRefusal === undefined
                    ? {}
                    : { unavailable: view.previewRefusal })}
                />
              </View>

              <View className="flex-1 gap-space-24">
                <View className="gap-space-8">
                  <Text className="text-captionBold text-text" accessibilityRole="header">
                    {t('digital.asset.packagesTitle')}
                  </Text>
                  <DigitalPackagePicker
                    packages={view.packages}
                    selectedPackageId={selectedPackage?.packageId ?? ''}
                    onSelect={(packageId) => setSelectedPackageId(packageId)}
                  />
                </View>

                {/* The licence of the SELECTED package, rendered once. */}
                {selectedPackage === undefined ? null : (
                  <AssetLicenceSummary
                    licenceName={selectedPackage.licenceName}
                    authorship={selectedPackage.licenceAuthorship}
                    terms={selectedPackage.licenceTerms}
                    updatePolicy={selectedPackage.updatePolicy}
                    {...(selectedPackage.licenceSummary === undefined
                      ? {}
                      : { summary: selectedPackage.licenceSummary })}
                  />
                )}
              </View>
            </View>

            <View className="gap-space-8">
              <Text className="text-captionBold text-text" accessibilityRole="header">
                {t('digital.asset.technicalTitle')}
              </Text>
              {/* Two props, two types. A mapping that mixed them has nowhere to
                  put the result (ADR 0010 D12). */}
              <AssetTechnicalPanel
                {...(view.measured === undefined ? {} : { measured: view.measured })}
                claims={view.claims}
              />
            </View>

            {view.sellerGuidance === undefined ? null : (
              <View className="gap-space-8">
                <Text className="text-captionBold text-text" accessibilityRole="header">
                  {t('digital.asset.guidanceTitle')}
                </Text>
                {/* The seller's own prose, verbatim. */}
                <Text className="text-bodySmall text-text-secondary">{view.sellerGuidance}</Text>
              </View>
            )}

            <View className="gap-space-8">
              <Text className="text-captionBold text-text" accessibilityRole="header">
                {t('digital.asset.versionsTitle')}
              </Text>
              <DigitalVersionHistory versions={view.versions} />
            </View>

            {/*
              Reviews of the canonical PRODUCT. `unverified` is passed through
              rather than folded into the total: #76 verification rule 5 counts
              reviews with no purchase behind them separately, which is the whole
              point of the split, and "verified-purchase reviews" is what remains
              in `total`.
            */}
            {view.canonicalProductId === undefined ? null : (
              <View className="gap-space-8">
                <Text className="text-captionBold text-text" accessibilityRole="header">
                  {t('digital.asset.reviewsTitle')}
                </Text>
                <ReviewSummaryCard
                  scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.product)}
                  average={aggregate?.rating ?? 0}
                  total={aggregate?.reviewCount ?? 0}
                  distribution={distribution}
                  reviews={reviews}
                  isLoading={reviewsQuery.isLoading}
                  {...(aggregate === undefined ? {} : { unverified: aggregate.unverified })}
                />
              </View>
            )}
          </>
        )}
      </View>

      <Footer />
    </ScreenShell>
  );
}
