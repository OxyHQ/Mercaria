import type { ReactElement } from 'react';
import { View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import type {
  CategoryTile,
  DiscoverySection,
  DiscoverySignal,
  HeroCard,
  ProductsSection,
} from '@mercaria/shared-types';
import {
  ActionHeroCard,
  Carousel,
  CategoryImageTile,
  CategorySampleTile,
  FeedActionPill,
  FeedGrid,
  MerchantCard,
  ProductCarousel,
  SectionCard,
  SectionHeader,
  StoreOfferHeader,
  StoreProductCard,
} from '@mercaria/ui';
import { categoryHref } from '@/lib/catalog/routes';
import { sectionTitleKey, sectionTitleParams } from '@/lib/discovery/section-title';
import { useTranslation } from '@/lib/i18n';

/**
 * Fixed, responsive `ActionHeroCard` slot width. The token appendix specs the
 * reference's own sizing as `--carousel-items` 1.3 → 2 (sm) → 3 (md+) — a
 * viewport-relative custom property with no React Native equivalent. Every
 * `Carousel` consumer in `@mercaria/ui` (`ProductCarousel`, `MerchantCarousel`,
 * `CategoryCarousel`) already sizes its slot with fixed breakpoint widths
 * instead, because `Carousel`'s slots render inside a horizontally scrolling
 * content container with no definite width for a percentage to resolve
 * against on native. These three widths are chosen to land at roughly 1.3/2/3
 * visible cards on common viewport widths, following that same convention.
 */
const HERO_SLOT_CLASS = 'w-[280px] sm:w-[320px] md:w-[380px]';

/**
 * `FeedActionPill` sizes itself to its own content (no width class on its
 * root) — the same reasoning `CategoryPills` documents for why IT skips
 * `Carousel` entirely. This slot is intentionally empty so each pill keeps its
 * natural width inside `Carousel`'s `shrink-0` wrapper.
 */
const PILLS_SLOT_CLASS = '';
/**
 * The token appendix's row: "Carousel gap: 4px, 8px from sm — tighter than
 * every other row." `web:sm:`, not `sm:` — the appendix was measured from a
 * web capture, so "from sm" is a web fact with no native evidence behind it,
 * and every other row in this component already draws that line on web only.
 */
const PILLS_GAP_CLASS = 'gap-1 web:sm:gap-2';

/** `MerchantCard`'s established carousel width, shared with `MerchantCarousel`. */
const STORES_LARGE_SLOT_CLASS = 'w-[330px]';

const CATEGORY_TILES_SLOT_CLASS = 'px-space-4 md:px-space-8 w-1/2 sm:w-1/3 md:w-1/4 lg:w-1/5';
const CATEGORY_IMAGES_SLOT_CLASS = 'px-space-4 md:px-space-8 w-1/2 md:w-1/3 lg:w-1/4';
const STORES_COMPACT_SLOT_CLASS = 'px-space-4 md:px-space-8 w-1/2 sm:w-1/3 md:w-1/4 lg:w-1/6';
const CARD_GROUP_SLOT_CLASS = 'px-space-4 md:px-space-8 w-full min-[1025px]:w-1/2';

/** `FeedGrid`'s own documented default shelf rhythm. */
const GRID_ROW_GAP_CLASS = 'gap-y-space-8 md:gap-y-space-16';
/** The `card-group` variant's wider row gap, per the token appendix. */
const CARD_GROUP_ROW_GAP_CLASS = 'gap-y-space-40';

/** Vertical rhythm between top-level feed sections. Not spec'd by either
 *  document — every section already carries its own internal padding, this is
 *  just the shelf-to-shelf gap. */
const SECTION_GAP_CLASS = 'gap-space-32';

export interface DiscoveryFeedProps {
  sections: DiscoverySection[];
}

interface ShelfHeading {
  title: string;
  href: Href;
}

function signalHref(handle: string, signal: DiscoverySignal): Href {
  return { pathname: '/categories/[handle]/s/[signal]', params: { handle, signal } };
}

/**
 * `DiscoverySection[]` in, components out — the only file that knows the
 * eight section kinds.
 *
 * ## Titles come from the client, never the server
 *
 * A section's heading is built from `sectionTitleKey(section.signal)` and
 * `section.categoryName` — `section.title` itself is never read. Plan A's
 * feed service is tested against never sending one for a signal section,
 * because a sentence assembled on the server cannot be translated.
 * `categoryName` travels alongside `signal` on every section that carries
 * one, so no lookup or caller-supplied fallback is needed here.
 *
 * ## Every dynamic destination is the OBJECT form
 *
 * `router.push({ pathname: '/categories/[handle]/s/[signal]', params })`,
 * never a template literal — `typedRoutes` checks a template literal only
 * when no dynamic route sits above the mistyped segment (#456), and
 * `/categories/[handle]` sits directly above `/s/[signal]`.
 */
export function DiscoveryFeed({ sections }: DiscoveryFeedProps) {
  const router = useRouter();
  const { t } = useTranslation();

  function shelfHeading(
    categoryHandle: string | undefined,
    signal: DiscoverySignal | undefined,
    categoryName: string | undefined,
  ): ShelfHeading | undefined {
    if (categoryHandle === undefined || signal === undefined || categoryName === undefined) {
      return undefined;
    }
    return {
      title: t(sectionTitleKey(signal), sectionTitleParams(categoryName)),
      href: signalHref(categoryHandle, signal),
    };
  }

  const onPressCategoryTile = (tile: CategoryTile) => router.push(categoryHref(tile.slug));

  const onPressHeroCard = (card: HeroCard) =>
    router.push(signalHref(card.categoryHandle, card.signal));

  const onPressProduct = (id: string) =>
    router.push({ pathname: '/products/[id]', params: { id } });

  const onPressStore = (handle: string) =>
    router.push({ pathname: '/stores/[handle]', params: { handle } });

  function renderProductsShelf(section: ProductsSection): ReactElement | null {
    if (section.products.length === 0) return null;
    const heading = shelfHeading(section.categoryHandle, section.signal, section.categoryName);
    return (
      <View key={section.id}>
        {heading ? (
          <SectionHeader
            title={heading.title}
            showChevron
            onPress={() => router.push(heading.href)}
          />
        ) : null}
        <ProductCarousel items={section.products} onPressItem={onPressProduct} />
      </View>
    );
  }

  /**
   * One switch, no `default` branch, explicit `ReactElement | null` return
   * type — a ninth `DiscoverySectionKind` added to the closed union leaves a
   * code path with no return, which `ReactElement | null` (unlike
   * `ReactNode`, which itself includes `undefined`) cannot satisfy. That is
   * what turns a missing case into a compile error here instead of a
   * silently blank section.
   */
  function renderSection(section: DiscoverySection): ReactElement | null {
    switch (section.kind) {
      case 'hero':
        return (
          <Carousel
            key={section.id}
            items={section.cards}
            keyExtractor={(card) => card.id}
            slotClassName={HERO_SLOT_CLASS}
            renderItem={(card) => <ActionHeroCard card={card} onPress={onPressHeroCard} />}
          />
        );

      case 'category-tiles':
        return (
          <FeedGrid
            key={section.id}
            items={section.tiles}
            keyExtractor={(tile) => tile.id}
            slotClassName={CATEGORY_TILES_SLOT_CLASS}
            rowGapClassName={GRID_ROW_GAP_CLASS}
            renderItem={(tile) => (
              <CategorySampleTile
                tile={tile}
                samples={tile.sampleImageUrls ?? []}
                onPress={onPressCategoryTile}
              />
            )}
          />
        );

      case 'category-images':
        return (
          <FeedGrid
            key={section.id}
            items={section.tiles}
            keyExtractor={(tile) => tile.id}
            slotClassName={CATEGORY_IMAGES_SLOT_CLASS}
            rowGapClassName={GRID_ROW_GAP_CLASS}
            renderItem={(tile) => <CategoryImageTile tile={tile} onPress={onPressCategoryTile} />}
          />
        );

      case 'pills':
        return (
          <Carousel
            key={section.id}
            items={section.tiles}
            keyExtractor={(tile) => tile.id}
            slotClassName={PILLS_SLOT_CLASS}
            gapClassName={PILLS_GAP_CLASS}
            renderItem={(tile) => <FeedActionPill tile={tile} onPress={onPressCategoryTile} />}
          />
        );

      case 'products':
        return renderProductsShelf(section);

      case 'stores': {
        if (section.stores.length === 0) return null;
        if (section.variant === 'large') {
          return (
            <Carousel
              key={section.id}
              items={section.stores}
              keyExtractor={(store) => store.id}
              slotClassName={STORES_LARGE_SLOT_CLASS}
              renderItem={(store) => (
                <MerchantCard
                  merchant={store}
                  onPressMerchant={onPressStore}
                  onPressProduct={onPressProduct}
                />
              )}
            />
          );
        }
        return (
          <FeedGrid
            key={section.id}
            items={section.stores}
            keyExtractor={(store) => store.id}
            slotClassName={STORES_COMPACT_SLOT_CLASS}
            rowGapClassName={GRID_ROW_GAP_CLASS}
            renderItem={(store) => (
              <StoreProductCard
                store={store}
                onPressStore={onPressStore}
                onPressProduct={onPressProduct}
              />
            )}
          />
        );
      }

      case 'store-offer': {
        if (section.products.length === 0) return null;
        return (
          <View key={section.id}>
            <StoreOfferHeader
              store={section.store}
              discount={section.discount}
              onPress={onPressStore}
            />
            <ProductCarousel items={section.products} onPressItem={onPressProduct} />
          </View>
        );
      }

      case 'card-group': {
        const cards = section.cards
          .filter((nested) => nested.products.length > 0)
          .map((nested) => ({
            nested,
            heading: shelfHeading(nested.categoryHandle, nested.signal, nested.categoryName),
          }))
          .filter(
            (entry): entry is { nested: ProductsSection; heading: ShelfHeading } =>
              entry.heading !== undefined,
          );

        return (
          <FeedGrid
            key={section.id}
            items={cards}
            keyExtractor={(entry) => entry.nested.id}
            slotClassName={CARD_GROUP_SLOT_CLASS}
            rowGapClassName={CARD_GROUP_ROW_GAP_CLASS}
            renderItem={({ nested, heading }) => (
              <SectionCard title={heading.title} onPress={() => router.push(heading.href)}>
                <ProductCarousel items={nested.products} onPressItem={onPressProduct} />
              </SectionCard>
            )}
          />
        );
      }
    }
  }

  return <View className={SECTION_GAP_CLASS}>{sections.map((section) => renderSection(section))}</View>;
}
