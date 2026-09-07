import type { ProductSummary } from '@mercaria/shared-types';
import { FeedGrid, ProductCard } from '@mercaria/ui';

/**
 * The `/categories/:handle/s/:signal` screen's product grid.
 *
 * A wrapping grid rather than `ProductCarousel`: the shelf on the feed and
 * category pages is a preview (`config.discovery.shelfSize`), and this is the
 * "see all" destination every hero card and `SectionCard` links to — the
 * reference's `ListSection`, which is what `FeedGrid` is
 * (`packages/ui/src/components/marketplace/FeedGrid.tsx`).
 *
 * The per-item card is `@mercaria/ui`'s own `ProductCard` (the one
 * `ProductCarousel` renders internally), never a local copy.
 */

/** Two columns on a phone, widening to five from `lg` — the same density
 *  `DiscoveryFeed`'s `category-tiles` section uses for its own wrapping grid. */
const PRODUCT_GRID_SLOT_CLASS = 'px-space-4 md:px-space-8 w-1/2 sm:w-1/3 md:w-1/4 lg:w-1/5';

/** `FeedGrid`'s own documented default shelf rhythm. */
const PRODUCT_GRID_ROW_GAP_CLASS = 'gap-y-space-8 md:gap-y-space-16';

export interface SignalGridProps {
  products: ProductSummary[];
  onPressProduct: (id: string) => void;
  onToggleSaveProduct?: (id: string, nextSaved: boolean) => void;
}

export function SignalGrid({ products, onPressProduct, onToggleSaveProduct }: SignalGridProps) {
  return (
    <FeedGrid
      items={products}
      keyExtractor={(product) => product.id}
      slotClassName={PRODUCT_GRID_SLOT_CLASS}
      rowGapClassName={PRODUCT_GRID_ROW_GAP_CLASS}
      renderItem={(product) => (
        <ProductCard
          product={product}
          onPress={onPressProduct}
          onToggleSave={onToggleSaveProduct}
        />
      )}
    />
  );
}
