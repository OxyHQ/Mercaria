import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type {
  ProductPageOfferGroupKey,
  ProductPageOffers,
  ProductPageOfferRow as OfferRowDTO,
} from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
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

/**
 * The heading each group carries. Copy, deliberately not a stored value.
 *
 * KEYS rather than sentences: this object is evaluated at import, before the
 * locale store has rehydrated, so a map of English would freeze whichever
 * language happened to load first. The render site resolves them.
 */
const GROUP_TITLE_KEYS: Readonly<Record<ProductPageOfferGroupKey, string>> = {
  official_direct: 'offer.group.title.officialDirect',
  new_retail: 'offer.group.title.newRetail',
  open_box: 'offer.group.title.openBox',
  refurbished: 'offer.group.title.refurbished',
  used: 'offer.group.title.used',
  for_parts: 'offer.group.title.forParts',
  condition_unknown: 'offer.group.title.conditionUnknown',
};
Object.freeze(GROUP_TITLE_KEYS);

/** One sentence saying what the group IS, where the heading alone is ambiguous. */
const GROUP_EXPLANATION_KEYS: Readonly<Partial<Record<ProductPageOfferGroupKey, string>>> =
  Object.freeze({
    official_direct: 'offer.group.explanation.officialDirect',
    condition_unknown: 'offer.group.explanation.conditionUnknown',
    for_parts: 'offer.group.explanation.forParts',
  });

/** How many rows a group shows before the "show all" control appears. */
const COLLAPSED_ROWS = 3;

export interface OfferGroupsProps {
  offers: ProductPageOffers;
  onAddToCart: (input: { listingId: string; productVariantId: string }) => void;
  addToCartPending: boolean;
}

export function OfferGroups({ offers, onAddToCart, addToCartPending }: OfferGroupsProps) {
  const { t } = useTranslation();

  if (offers.available === false) {
    return (
      <View className="gap-space-8 rounded-radius-28 border border-border-secondary p-space-20">
        <Text className="text-sectionTitle text-text">{t('offer.heading')}</Text>
        <Text className="text-bodySmall text-text-secondary">
          {t('offer.comparisonUnavailable')}
        </Text>
      </View>
    );
  }

  if (offers.rows.length === 0) {
    return (
      <View className="gap-space-8 rounded-radius-28 border border-border-secondary p-space-20">
        <Text className="text-sectionTitle text-text">{t('offer.heading')}</Text>
        <Text className="text-bodySmall text-text-secondary">
          {offers.excludedCount > 0
            ? // The count is the ONLY thing carried about the exclusions, and it
              // is what separates "we know of offers, none is currently
              // eligible" from "nobody sells this". Which offers, and why, is a
              // seller's question `/offer-comparison` answers.
              t('offer.noneShowable')
            : t('offer.none')}
        </Text>
      </View>
    );
  }

  const rowsById = new Map(offers.rows.map((row) => [row.offer.id, row]));

  return (
    <View className="gap-space-24">
      {offers.groups.map((group) => {
        const explanationKey = GROUP_EXPLANATION_KEYS[group.key];
        return (
          <OfferGroupSection
            key={group.key}
            title={t(GROUP_TITLE_KEYS[group.key])}
            explanation={explanationKey === undefined ? undefined : t(explanationKey)}
            rows={group.offerIds
              .map((offerId) => rowsById.get(offerId))
              .filter((row): row is OfferRowDTO => row !== undefined)}
            onAddToCart={onAddToCart}
            addToCartPending={addToCartPending}
          />
        );
      })}
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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <View className="gap-space-12">
      <View className="gap-space-2">
        <Text className="text-sectionTitle text-text" accessibilityRole="header">
          {t('offer.group.heading', { title, count: rows.length })}
        </Text>
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
            expanded
              ? t('offer.showFewerA11y', { group: title })
              : t('offer.showAllA11y', { count: rows.length, group: title })
          }
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="self-start rounded-radius-max border border-border-secondary px-space-16 py-space-8"
        >
          <Text className="text-buttonMedium text-text">
            {expanded ? t('offer.showFewer') : t('offer.showAll', { count: rows.length })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
