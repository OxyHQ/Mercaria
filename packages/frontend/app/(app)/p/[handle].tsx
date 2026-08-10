import { useEffect, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type {
  CanonicalProductPage,
  OfferComparisonIntent,
  ProductPageSeller,
} from '@mercaria/shared-types';
import { OfferLabelBadge, Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { BrandChannels } from '@/components/product/BrandChannels';
import { OfferGroups } from '@/components/product/OfferGroups';
import { PriceHistoryPanel } from '@/components/product/PriceHistoryPanel';
import { ProductIdentity } from '@/components/product/ProductIdentity';
import { VariantSelector } from '@/components/product/VariantSelector';
import { OFFER_INTENT_LABELS, useProductPage } from '@/lib/hooks/use-product-page';
import { useProductScopeReviews } from '@/lib/hooks/use-reviews';
import { useAddCartItem } from '@/lib/hooks/use-cart';
import { useToggleProductSave } from '@/lib/hooks/use-saves';

/**
 * The canonical product page (#71).
 *
 * ONE page for one product and every eligible way to acquire it: Mercaria's own
 * sellers, the brand's official store, ordinary retailers, refurbished units and
 * somebody's used copy — each under its own identity and none mistaken for
 * another.
 *
 * ## `/p/:handle`, and why it is a new route rather than a replacement
 *
 * `/products/:id` is the LISTING page and stays exactly as it is: #71
 * acceptance 7 keeps the existing detail routes working until #75 migrates the
 * public routing, and #75 owns the HTTP-level 301s, the `rel=canonical` tag and
 * the sitemap. The handle here is the product's SLUG or its id, both of which
 * the server resolves, and a merged product's old handle resolves to its winner
 * — which the page then states and replaces in the URL rather than silently
 * showing a different product under the address somebody clicked.
 *
 * ## What this page does NOT do
 *
 * It never orders offers (it renders #74's order), never picks a "cheapest"
 * (it renders #74's awards), never sends anybody to an external site (#37 owns
 * the redirect and the freshness re-check that must precede one) and never
 * writes anything except through a mutation another domain owns.
 * `product-page-isolation.test.ts` in the backend scans these files and fails
 * the build if any of that changes — the storefront has no test runner of its
 * own, so the gate lives where one exists (#92's precedent).
 */

export default function CanonicalProductPageScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ handle: string; variant?: string; intent?: string }>();
  const handle = params.handle ?? '';
  const selectedVariantId = params.variant;
  const intent = readIntent(params.intent);

  const pageQuery = useProductPage(handle, {
    ...(selectedVariantId === undefined ? {} : { canonicalVariantId: selectedVariantId }),
    ...(intent === undefined ? {} : { intent }),
  });
  const page = pageQuery.data;

  /**
   * A merged product's old handle answers with the winner, and the URL is
   * corrected to match.
   *
   * `replace`, never `push`: the requested handle was a redirect and putting it
   * in the history would let the back button walk into the same redirect again.
   * This is the client half of #71 route rule 2; the HTTP 301 that search
   * engines need is #75's.
   */
  useEffect(() => {
    if (page?.redirect === undefined) return;
    router.replace(
      buildHref(page.redirect.canonicalHandle, selectedVariantId, intent) as Parameters<
        typeof router.replace
      >[0],
    );
  }, [page?.redirect, router, selectedVariantId, intent]);

  const reviews = useProductScopeReviews(page?.product.id, 1, 1);
  const addToCart = useAddCartItem();
  const toggleProductSave = useToggleProductSave();

  const head = (
    <Head>
      <title>{page?.product.name ? `${page.product.name} — Mercaria` : 'Mercaria'}</title>
      {page?.product.description ? (
        <meta name="description" content={page.product.description.slice(0, 160)} />
      ) : null}
    </Head>
  );

  if (pageQuery.isLoading && page === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        {head}
        <ProductPageSkeleton />
      </ScreenShell>
    );
  }

  if (pageQuery.isError || page === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        {head}
        <View className="items-center justify-center px-8 py-16">
          <Text className="text-center text-body text-text-tertiary">
            We couldn&apos;t find this product.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell contentClassName="pt-6">
      {head}
      <View className="web:mx-auto web:w-full web:max-w-[1200px] gap-space-32 md:px-5">
        <ProductIdentity
          product={page.product}
          {...(reviews.data?.aggregate === undefined
            ? {}
            : {
                rating: {
                  rating: reviews.data.aggregate.rating,
                  reviewCount: reviews.data.aggregate.reviewCount,
                },
              })}
        />

        <VariantSelector
          variants={page.variants}
          {...(selectedVariantId === undefined ? {} : { selectedVariantId })}
          onSelect={(variantId) =>
            // `setParams` updates the URL WITHOUT pushing a history entry, so
            // changing configuration does not bury the page somebody arrived
            // from under a stack of swatch changes (#71 UX rule 6).
            router.setParams({ variant: variantId ?? '' })
          }
        />

        <Highlights page={page} />

        <IntentPicker
          intent={intent}
          onSelect={(next) => router.setParams({ intent: next ?? '' })}
        />

        <OfferGroups
          offers={page.offers}
          addToCartPending={addToCart.isPending}
          onAddToCart={(input) =>
            addToCart.mutate({
              listingId: input.listingId,
              variantId: input.productVariantId,
              quantity: 1,
            })
          }
        />

        {addToCart.isError ? (
          <Text accessibilityRole="alert" className="text-sm font-medium text-destructive">
            {addToCart.error.message}
          </Text>
        ) : null}

        <PriceHistoryPanel
          canonicalProductId={page.product.id}
          segment={historySegment(page)}
          currency={page.offers.available === true ? page.offers.comparisonCurrency : undefined}
        />

        <BrandChannels
          officialChannels={page.officialChannels}
          authorizedResellers={page.authorizedResellers}
        />

        <View className="flex-row flex-wrap gap-space-8">
          {/*
            Save (#80). A one-way SAVE rather than a toggle, and the reason is a
            gap stated rather than papered over: #80 publishes a save context
            for a LISTING (`/product-saves/listing/:id`) and none for a
            canonical product, so this page cannot know whether the product is
            already saved. A toggle built on an unknown current state would
            un-save on the first press for anybody who had saved it elsewhere.
            The write is idempotent (`ON CONFLICT DO NOTHING`), so pressing it
            twice creates nothing and changes nothing — including the saved
            list's ordering key. Whoever adds a per-product read to #80 turns
            this into a toggle and nothing else here changes.
          */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save this product"
            accessibilityState={{ disabled: toggleProductSave.isPending }}
            disabled={toggleProductSave.isPending}
            onPress={() =>
              toggleProductSave.mutate({
                canonicalProductId: page.product.id,
                saved: false,
                sourceContext: 'product_page',
              })
            }
            className="rounded-radius-max border border-border-secondary px-space-16 py-space-12"
          >
            <Text className="text-buttonMedium text-text">
              {toggleProductSave.isSuccess ? 'Saved' : 'Save product'}
            </Text>
          </Pressable>

          {/*
            Reporting the PRODUCT DATA goes to feedback, not to abuse reporting,
            and the vocabulary is why: `ABUSE_REPORTED_TYPES` is
            `listing | review | seller | store` and has no `product` member. A
            canonical product is Mercaria's OWN catalogue record — a wrong
            specification is a data correction (#59's queue), not somebody's
            content to be moderated. Reporting a LISTING is on that listing's own
            page, where the listing is the subject and `POST /reports` has a type
            for it.
          */}
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Report a problem with this product's information"
            onPress={() => router.push('/settings/feedback' as Parameters<typeof router.push>[0])}
            className="rounded-radius-max border border-border-secondary px-space-16 py-space-12"
          >
            <Text className="text-buttonMedium text-text">Report a problem</Text>
          </Pressable>
        </View>

        {/*
          "Sell yours" (#71 actions 4) and the price ALERT (#39/#79) are
          deliberately ABSENT rather than rendered as controls that do nothing.
          #41 owns the P2P sell flow from a canonical product and #79 owns
          alerts; a button that opens nothing is worse than no button, because a
          shopper reads it as a feature that is broken rather than one that does
          not exist yet.
        */}

        <Footer />
      </View>
    </ScreenShell>
  );
}

/**
 * The comparison's own highlights, above the groups.
 *
 * Each one POINTS at an offer rather than repeating its row — #71's "must not
 * duplicate the same offer in misleading ways" — and every one comes from a
 * label #74 awarded under the policy version the page names.
 */
function Highlights({ page }: { page: CanonicalProductPage }) {
  const offers = page.offers;
  if (offers.available === false || offers.highlights.length === 0) return null;

  const rowsById = new Map(offers.rows.map((row) => [row.offer.id, row]));

  return (
    <View className="gap-space-8">
      <Text className="text-sectionTitle text-text" accessibilityRole="header">
        Highlights
      </Text>
      {offers.highlights.map((highlight) => {
        const row = rowsById.get(highlight.offerId);
        if (row === undefined) return null;
        return (
          <View
            key={`${highlight.offerId}:${highlight.award.label}`}
            className="flex-row items-center gap-space-8"
          >
            <OfferLabelBadge award={highlight.award} />
            <Text className="text-caption text-text-secondary">{sellerName(row.seller)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** The intent control — a documented primary sort key, never a re-weighting (#74). */
function IntentPicker({
  intent,
  onSelect,
}: {
  intent: OfferComparisonIntent | undefined;
  onSelect: (intent: OfferComparisonIntent | undefined) => void;
}) {
  const options: OfferComparisonIntent[] = ['balanced', 'cheapest', 'fastest', 'official', 'used'];
  const current = intent ?? 'balanced';

  return (
    <View className="gap-space-8" accessibilityRole="radiogroup" accessibilityLabel="Sort offers by">
      <Text className="text-captionBold text-text">Sort offers by</Text>
      <View className="flex-row flex-wrap gap-space-8">
        {options.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: current === option }}
            accessibilityLabel={OFFER_INTENT_LABELS[option]}
            onPress={() => onSelect(option === 'balanced' ? undefined : option)}
            className={`rounded-radius-max border px-space-16 py-space-8 ${
              current === option ? 'border-text bg-bg-fill' : 'border-border-secondary'
            }`}
          >
            <Text className="text-buttonMedium text-text">{OFFER_INTENT_LABELS[option]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * A shopper-readable seller name for a highlight line.
 *
 * A `switch` over the union rather than a `seller.name ?? seller.displayName`
 * coalesce: the union has no common field on purpose (a person is an Oxy
 * account and a merchant is a canonical entity), and a coalesce is what would
 * eventually put one where the other belongs.
 */
function sellerName(seller: ProductPageSeller): string {
  switch (seller.kind) {
    case 'merchant':
      return seller.name;
    case 'native_store':
      return seller.name;
    case 'native_person':
      return seller.displayName;
    default:
      return 'Seller not identified';
  }
}

/**
 * Which segment the price chart shows.
 *
 * The segment of the FIRST group with offers in it, so a product sold only
 * second-hand charts its used history rather than an empty `new` series. It is
 * never a blend: #90's segments are different things and #78 refuses to mix
 * them.
 */
function historySegment(page: CanonicalProductPage) {
  if (page.offers.available === false) return undefined;
  for (const row of page.offers.rows) {
    if (row.offer.condition.group !== undefined) return row.offer.condition.group;
  }
  return undefined;
}

/** The URL for one product, configuration and intent. */
function buildHref(
  handle: string,
  variant: string | undefined,
  intent: OfferComparisonIntent | undefined,
): string {
  const query = new URLSearchParams();
  if (variant !== undefined && variant !== '') query.set('variant', variant);
  if (intent !== undefined) query.set('intent', intent);
  const suffix = query.toString();
  return `/p/${encodeURIComponent(handle)}${suffix === '' ? '' : `?${suffix}`}`;
}

/** A query parameter is a string; only a real intent survives it. */
function readIntent(value: string | undefined): OfferComparisonIntent | undefined {
  const intents: OfferComparisonIntent[] = ['balanced', 'cheapest', 'fastest', 'official', 'used'];
  return intents.find((intent) => intent === value);
}

/** Loading placeholder mirroring the page's own rhythm. */
function ProductPageSkeleton() {
  return (
    <View
      className="web:mx-auto web:w-full web:max-w-[1200px] gap-space-16 md:px-5"
      accessibilityLabel="Loading product"
    >
      <View className="h-[180px] w-full rounded-radius-28 bg-bg-fill-hover" />
      <View className="h-8 w-2/3 rounded bg-bg-fill-hover" />
      <View className="h-6 w-1/3 rounded bg-bg-fill-hover" />
      <View className="h-32 w-full rounded-radius-28 bg-bg-fill-hover" />
      <View className="h-32 w-full rounded-radius-28 bg-bg-fill-hover" />
    </View>
  );
}
