import type { ReactElement, ReactNode } from 'react';
import type { ProductLinkRenderer } from './ProductCard';
import { View } from 'react-native';
import { ProductCarousel } from './ProductCarousel';
import { SectionHeader } from './SectionHeader';
import type { ProductSummary } from '../../lib/format';

export interface ProductShelfProps {
  cardVariant?: 'standard' | 'image-only';
  title: string;
  items: ProductSummary[];
  /**
   * Makes the heading a link to the shelf's "see all", with the trailing
   * chevron `SectionHeader` already draws for that mode. Omitted, the heading
   * is the plain text node it has always been — a shelf whose whole content is
   * already on screen has nowhere to send anyone.
   */
  renderTitleLink?: (child: ReactElement) => ReactNode;
  renderProductLink: ProductLinkRenderer;
  onToggleSaveItem?: (id: string, nextSaved: boolean) => void;
}

/**
 * A titled marketplace section: a bold heading above a horizontally scrollable
 * product carousel. Bloom aligns the heading with its carousel controls.
 * Returns `null` when there are no items or they are unavailable, so the heading
 * never appears over an empty row — safe to render always.
 */
export function ProductShelf({
  title,
  items,
  renderTitleLink,
  renderProductLink,
  onToggleSaveItem,
  cardVariant,
}: ProductShelfProps) {
  if (!items || items.length === 0) return null;

  return (
    <View className={cardVariant === 'image-only' ? 'mb-3 md:mb-6' : 'mb-10 md:mb-16'}>
      <ProductCarousel
        title={title}
        cardVariant={cardVariant}
        header={
          <SectionHeader
            title={title}
            renderLink={renderTitleLink}
            showChevron={renderTitleLink !== undefined}
            inset={false}
            chevronPosition="after-title"
          />
        }
        items={items}
        renderProductLink={renderProductLink}
        onToggleSaveItem={onToggleSaveItem}
      />
    </View>
  );
}
