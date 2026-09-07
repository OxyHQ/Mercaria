import type { ReactElement } from 'react';
import { View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import type {
  CategoryTile,
  DiscoverySection,
  DiscoverySignal,
  ProductsSection,
  StoresSection,
} from '@mercaria/shared-types';
import {
  CategoryPills,
  MerchantCarousel,
  MerchantHeader,
  ProductCarousel,
  ProductShelf,
} from '@mercaria/ui';
import { categoryHref } from '@/lib/catalog/routes';
import { sectionTitleKey, sectionTitleParams } from '@/lib/discovery/section-title';
import { useTranslation } from '@/lib/i18n';

/**
 * The heading padding every shelf in the app already uses — `SectionHeader`'s
 * own `px-4 pb-3 md:px-5`. `MerchantHeader` is the one heading here that is
 * not a `SectionHeader` (it is the PDP's merchant identity row), and it
 * carries no padding of its own because on the PDP it sits inside an already
 * padded column. This puts it on the same line as every other shelf heading.
 */
const STORE_OFFER_HEADING_CLASS = 'px-4 pb-3 md:px-5';

/**
 * The shelf-to-shelf rhythm every `@mercaria/ui` shelf owns for itself
 * (`ProductShelf`, `MerchantCarousel`, `CategoryPills` and `CategoryCarousel`
 * all end in `mb-6`). The `store-offer` section is assembled here from two
 * components rather than one, so this is the only place that has to spell it.
 */
const SHELF_RHYTHM_CLASS = 'mb-6';

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
 * ## Every section renders through a component the app already had
 *
 * Nothing here is bespoke to the discovery feed. The storefront was built from
 * one reference, so the components that render the home feed ARE that
 * reference already resolved into this app's own widths, card sizes and
 * heading scale: `ProductShelf` (the same call `app/(app)/index.tsx` makes),
 * `CategoryPills`, `MerchantCarousel`, `MerchantHeader` and `ProductCarousel`.
 * The capture decides WHICH sections appear and in what order; the app decides
 * what they look like. A section kind that cannot be carried by one of those
 * is a gap to report, not a licence to add a tenth card component — the last
 * attempt added nine and produced pages that matched no other screen.
 *
 * Because each of those components already owns its own `mb-6`, this file adds
 * no wrapper gap and no max-width: the feed bleeds the full scroll width
 * exactly as the home feed does, which is what lets a horizontal carousel
 * actually scroll instead of clipping inside a centred column.
 *
 * ## Titles come from the client, never the server
 *
 * A section's heading is built from `sectionTitleKey(section.signal)` and
 * `section.categoryName` — `section.title` itself is never read. Plan A's
 * feed service is tested against never sending one for a signal section,
 * because a sentence assembled on the server cannot be translated.
 * `categoryName` travels alongside `signal` on every section that carries
 * one, so no lookup or caller-supplied fallback is needed here. A section that
 * carries neither renders headless (`ProductCarousel` rather than
 * `ProductShelf`, an untitled `MerchantCarousel`) rather than falling back to
 * a server sentence or inventing one.
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

  const onPressCategoryTile = (id: string, slug: string) =>
    router.push(categoryHref(slug.length > 0 ? slug : id));

  const onPressProduct = (id: string) =>
    router.push({ pathname: '/products/[id]', params: { id } });

  const onPressStore = (handle: string) =>
    router.push({ pathname: '/stores/[handle]', params: { handle } });

  /**
   * One `products` shelf. Titled shelves are `ProductShelf` — the same call
   * the home screen makes — with the heading linking to the signal's "see
   * all"; that link is the ONLY route into `/categories/:handle/s/:signal`, so
   * dropping it would orphan the page. A section with no heading to build
   * renders the carousel `ProductShelf` would have rendered anyway, without
   * the header.
   */
  function renderProductsShelf(section: ProductsSection): ReactElement | null {
    if (section.products.length === 0) return null;
    const heading = shelfHeading(section.categoryHandle, section.signal, section.categoryName);
    if (heading === undefined) {
      return (
        <ProductCarousel key={section.id} items={section.products} onPressItem={onPressProduct} />
      );
    }
    return (
      <ProductShelf
        key={section.id}
        title={heading.title}
        onPressTitle={() => router.push(heading.href)}
        items={section.products}
        onPressItem={onPressProduct}
      />
    );
  }

  /**
   * A `stores` row. Its heading is its own — the shops ranked by sales in the
   * category, not the category's best-selling PRODUCTS — so it reads
   * `discovery.shelf.stores` rather than `sectionTitleKey('best-selling')`,
   * which the sibling product shelf on the same page already uses verbatim.
   *
   * `variant` is not read. It exists on the wire because the reference draws
   * the row two ways, and this app draws a shop exactly one way
   * (`MerchantCard`); rendering a second, smaller store card to honour it is
   * the bespoke-component mistake this file exists to undo.
   */
  function renderStoresShelf(section: StoresSection): ReactElement | null {
    if (section.stores.length === 0) return null;
    const title =
      section.categoryName === undefined
        ? undefined
        : t('discovery.shelf.stores', sectionTitleParams(section.categoryName));
    return (
      <MerchantCarousel
        key={section.id}
        title={title}
        merchants={section.stores}
        onPressMerchant={onPressStore}
        onPressProduct={onPressProduct}
      />
    );
  }

  /**
   * Category tiles, whatever the kind. `category-tiles` and `pills` both carry
   * the identical `CategoryTile[]` payload — id, name, slug and an optional
   * image — and `CategoryPills` is the app's own component for exactly that,
   * already rendering the home feed's category row.
   *
   * They are NOT rendered as `CategoryCarousel`/`CategoryCard`: that card is a
   * category above a 2×2 grid of its NAMED subcategories (`Category`), and the
   * discovery feed sends no subcategories — a `category-tiles` tile carries at
   * most two bare image URLs with no names or destinations behind them. See
   * the branch report for the server change that would let the richer card be
   * used here.
   */
  function renderCategoryTiles(id: string, tiles: CategoryTile[]): ReactElement | null {
    if (tiles.length === 0) return null;
    return <CategoryPills key={id} pills={tiles} onPressPill={onPressCategoryTile} />;
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
      /*
       * Deliberately nothing, and the case stays so the switch stays
       * exhaustive.
       *
       * The server no longer builds a `hero` section for the root scope (it
       * used to map the same top-level categories `buildCategoryTilesSection`
       * already turns into tiles, so explore drew all seven categories
       * twice). The KIND survives on the wire for the reference's real first
       * row — three EDITORIAL cards with their own copy ("Bar cart basics",
       * "The pocket perfumery", "Taco Tuesday favorites") — which Mercaria has
       * no content for yet. This branch is what renders that content once it
       * exists; until then a `hero` section should never arrive, and if one
       * ever does, dropping it is still correct rather than showing a
       * duplicate category row.
       */
      case 'hero':
        return null;

      case 'category-tiles':
      case 'pills':
        return renderCategoryTiles(section.id, section.tiles);

      case 'products':
        return renderProductsShelf(section);

      case 'stores':
        return renderStoresShelf(section);

      /*
       * A store's offer: the merchant identity row the PDP already uses, above
       * the products the discount covers.
       *
       * `section.discount` is not rendered. The app has no pre-existing
       * component that states a store-wide saving, and the per-product badge
       * `ProductCard` draws describes the item's own markdown, which is a
       * different claim. Reported as a gap rather than filled with a tenth
       * bespoke badge.
       */
      case 'store-offer': {
        if (section.products.length === 0) return null;
        return (
          <View key={section.id} className={SHELF_RHYTHM_CLASS}>
            <View className={STORE_OFFER_HEADING_CLASS}>
              <MerchantHeader
                name={section.store.name}
                logoUrl={section.store.logoUrl}
                rating={section.store.rating}
                reviewCount={section.store.reviewCount}
                onPress={() => onPressStore(section.store.handle)}
                size="large"
                discountPercent={section.discount.percentOff}
              />
            </View>
            <ProductCarousel items={section.products} onPressItem={onPressProduct} />
          </View>
        );
      }

      /*
       * Two ordinary shelves, stacked — not a grid of bordered cards. The
       * nested card was what clipped a product row mid-card: a carousel inside
       * a half-width cell has nowhere to scroll to. Each nested section is a
       * `products` section already, so it renders through the same path every
       * other shelf on the page does.
       */
      case 'card-group':
        return (
          <View key={section.id}>
            {section.cards.map((nested) => renderProductsShelf(nested))}
          </View>
        );
    }
  }

  return <View>{sections.map((section) => renderSection(section))}</View>;
}
