import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type {
  ProductPageOfferGroupKey,
  ProductPageOffers,
  ProductPageOfferRow as OfferRowDTO,
} from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { OfferRow } from './OfferRow';

/**
 * Every eligible way to acquire this product, grouped (#71 §"Offer groups").
 *
 * ## The groups come from the server and this file does not re-derive them
 *
 * The partition is a tested domain module (`services/product-page/groups.ts`),
 * so three surfaces cannot each hold a slightly different idea of which segment
 * an unlabelled feed item belongs to. This component renders what it is handed,
 * in the order it is handed, and computes nothing about which offer is cheapest
 * or best — that is #74's, under a policy version every impression records.
 *
 * ## Withheld is not empty, and empty is not "nobody sells this"
 *
 * Three distinct states, three distinct sentences. A deployment that has turned
 * offer comparison off says so; a product whose offers all failed eligibility
 * says THAT; and a product genuinely nobody is selling says the third thing.
 * Collapsing them is how a rollout lever starts reading as a dead product.
 */

/** The heading each group carries. Copy, deliberately not a stored value. */
const GROUP_TITLES: Readonly<Record<ProductPageOfferGroupKey, string>> = Object.freeze({
  official_direct: 'Official stores',
  new_retail: 'New from other retailers',
  open_box: 'Open box',
  refurbished: 'Refurbished',
  used: 'Second-hand',
  for_parts: 'For parts or not working',
  condition_unknown: 'Condition not stated',
});

/** One sentence saying what the group IS, where the heading alone is ambiguous. */
const GROUP_EXPLANATIONS: Readonly<Partial<Record<ProductPageOfferGroupKey, string>>> =
  Object.freeze({
    official_direct: 'Channels the brand has verified as its own.',
    condition_unknown: 'These sellers did not say what condition the item is in.',
    for_parts: 'Sold as not working — for repair, salvage or components.',
  });

/** How many rows a group shows before the "show all" control appears. */
const COLLAPSED_ROWS = 3;

export interface OfferGroupsProps {
  offers: ProductPageOffers;
  onAddToCart: (input: { listingId: string; productVariantId: string }) => void;
  addToCartPending: boolean;
}

export function OfferGroups({ offers, onAddToCart, addToCartPending }: OfferGroupsProps) {
  if (offers.available === false) {
    return (
      <View className="gap-space-8 rounded-radius-28 border border-border-secondary p-space-20">
        <Text className="text-sectionTitle text-text">Offers</Text>
        <Text className="text-bodySmall text-text-secondary">
          Price comparison is temporarily unavailable here. This is not a statement about whether
          anybody is selling this product.
        </Text>
      </View>
    );
  }

  if (offers.rows.length === 0) {
    return (
      <View className="gap-space-8 rounded-radius-28 border border-border-secondary p-space-20">
        <Text className="text-sectionTitle text-text">Offers</Text>
        <Text className="text-bodySmall text-text-secondary">
          {offers.excludedCount > 0
            ? // The count is the ONLY thing carried about the exclusions, and it
              // is what separates "we know of offers, none is currently
              // eligible" from "nobody sells this". Which offers, and why, is a
              // seller's question `/offer-comparison` answers.
              'We know of offers for this product, but none can be shown right now.'
            : 'No current offers for this product.'}
        </Text>
      </View>
    );
  }

  const rowsById = new Map(offers.rows.map((row) => [row.offer.id, row]));

  return (
    <View className="gap-space-24">
      {offers.groups.map((group) => (
        <OfferGroupSection
          key={group.key}
          title={GROUP_TITLES[group.key]}
          explanation={GROUP_EXPLANATIONS[group.key]}
          rows={group.offerIds
            .map((offerId) => rowsById.get(offerId))
            .filter((row): row is OfferRowDTO => row !== undefined)}
          onAddToCart={onAddToCart}
          addToCartPending={addToCartPending}
        />
      ))}
    </View>
  );
}

/**
 * One group, bounded.
 *
 * `COLLAPSED_ROWS` then an explicit control, rather than rendering forty rows
 * into the tree at once. #74's comparison is ONE ranked page with no cursor —
 * that is its contract, not an oversight — so there is nothing further to
 * paginate to; what this bounds is how much of the page is built before
 * somebody asks for it.
 */
function OfferGroupSection({
  title,
  explanation,
  rows,
  onAddToCart,
  addToCartPending,
}: {
  title: string;
  explanation?: string;
  rows: readonly OfferRowDTO[];
  onAddToCart: (input: { listingId: string; productVariantId: string }) => void;
  addToCartPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <View className="gap-space-12">
      <View className="gap-space-2">
        <Text
          className="text-sectionTitle text-text"
          accessibilityRole="header"
        >{`${title} (${rows.length})`}</Text>
        {explanation ? (
          <Text className="text-caption text-text-secondary">{explanation}</Text>
        ) : null}
      </View>

      {visible.map((row) => (
        <OfferRow
          key={row.offer.id}
          row={row}
          onAddToCart={onAddToCart}
          addToCartPending={addToCartPending}
        />
      ))}

      {rows.length > COLLAPSED_ROWS ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? `Show fewer ${title} offers` : `Show all ${rows.length} ${title} offers`
          }
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="self-start rounded-radius-max border border-border-secondary px-space-16 py-space-8"
        >
          <Text className="text-buttonMedium text-text">
            {expanded ? 'Show fewer' : `Show all ${rows.length}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
