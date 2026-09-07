import type { ProductSummary } from '@mercaria/shared-types';
import { FeedGrid, ProductCard } from '@mercaria/ui';

/**
 * The `/categories/:handle/s/:signal` screen's product grid.
 *
 * A wrapping grid rather than `ProductCarousel`: the shelf on the feed and
 * category pages is a preview (`config.discovery.shelfSize`), and this is the
 * "see all" destination every shelf heading links to — the reference's
 * `ListSection`, which is what `FeedGrid` is
 * (`packages/ui/src/components/marketplace/FeedGrid.tsx`).
 *
 * `FeedGrid` is the only survivor of the nine components the discovery feed
 * briefly added to `@mercaria/ui`, and this is its only caller: it is a
 * layout, not a card, and there was no wrapping grid in the kit before it.
 *
 * The per-item card is `@mercaria/ui`'s own `ProductCard` (the one
 * `ProductCarousel` renders internally), never a local copy.
 */

/** Two columns on a phone, widening to five from `lg`. */
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
