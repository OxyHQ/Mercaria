import { Pressable, View } from 'react-native';
import type {
  Facet,
  FacetBucket,
  FacetOrigin,
  FacetSelectionEntry,
} from '@mercaria/shared-types';
import { formatMoney, Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { FacetReadResult } from '@/lib/api/facets';
import { toggleFacetValue, unofferedSelections } from '@/lib/catalog/facet-selection';

/**
 * The filter rail (#367 workstream 10 §"Facets and filter UI").
 *
 * ## There is no filter list in this file, and there is nowhere to put one
 *
 * Every facet, its label, its group, its ordering, its buckets, its counts and
 * its suppressions arrive in `FacetReadResult`. This component maps over them.
 * It has no category parameter, no product-type parameter and no branch on any
 * facet key — the props are a response and two callbacks, so a per-category
 * filter set has no argument it could be passed through.
 *
 * ## The three shapes are the SERVER's three shapes
 *
 * `FacetValues` is a discriminated union of `buckets`, `range` and
 * `money_range`, and the switch below is over that discriminant. Switching on a
 * VOCABULARY is exactly what a schema-driven renderer must do; switching on a
 * facet's identity is what it must never do, and the two are different subjects.
 *
 * ## An unknown count is stated, never folded into zero
 *
 * `Facet.unknownCount` is how many products in scope carry NO value for this
 * attribute. Adding it to a bucket would claim they answered; hiding it would
 * make a filter that excludes them look like one that does not. It is shown as
 * its own line, with the facet's own `missingDataPolicy` deciding whether
 * selecting a value excludes them — which the server decides, not this file.
 *
 * ## A selected filter the current results cannot offer stays REMOVABLE
 *
 * `unofferedSelections` are the entries the server echoed back with
 * `facetOffered: false`. They render as their own chips above the rail, because
 * the remedy for "no results" is to remove one and a shopper cannot remove a
 * chip from a rail that has stopped listing it.
 */

export interface FacetRailProps {
  response: FacetReadResult;
  selection: readonly FacetSelectionEntry[];
  onSelectionChange: (next: readonly FacetSelectionEntry[]) => void;
}

export function FacetRail({ response, selection, onSelectionChange }: FacetRailProps) {
  const { t } = useTranslation();
  const stranded = unofferedSelections(response);

  if (response.facets.length === 0 && stranded.length === 0) {
    return (
      <View className="gap-space-8">
        <Text className="text-captionBold text-text">{t('catalog.filters.title')}</Text>
        <Text className="text-caption text-text-tertiary">{t('catalog.filters.none')}</Text>
      </View>
    );
  }

  return (
    <View className="gap-space-24">
      <View className="flex-row items-center justify-between">
        <Text className="text-captionBold text-text">{t('catalog.filters.title')}</Text>
        {selection.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('catalog.filters.clear')}
            onPress={() => onSelectionChange([])}
          >
            <Text className="text-caption text-text-secondary">{t('catalog.filters.clear')}</Text>
          </Pressable>
        ) : null}
      </View>

      {stranded.length > 0 ? (
        <View className="gap-space-8">
          <Text className="text-caption text-text-tertiary">
            {t('catalog.filters.unavailableHere')}
          </Text>
          <View className="flex-row flex-wrap gap-space-8">
            {stranded.map((entry) =>
              (entry.values ?? []).map((value) => (
                <Pressable
                  key={`${entry.origin}~${entry.facetKey}~${value}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('catalog.filters.removeFilter')}
                  onPress={() =>
                    onSelectionChange(
                      toggleFacetValue(selection, entry.origin, entry.facetKey, value, true),
                    )
                  }
                  className="rounded-radius-max border border-border-secondary px-space-12 py-space-6"
                >
                  {/* The stable key is what the server echoed; there is no label
                      for a facet it did not offer, so the key is shown as the
                      key it is rather than dressed up as a word. */}
                  <Text className="text-caption text-text-secondary">{value} ✕</Text>
                </Pressable>
              )),
            )}
          </View>
        </View>
      ) : null}

      {response.facets.map((facet) => (
        <FacetBlock
          key={`${facet.origin}~${facet.key}`}
          facet={facet}
          selection={selection}
          onSelectionChange={onSelectionChange}
        />
      ))}
    </View>
  );
}

function FacetBlock({
  facet,
  selection,
  onSelectionChange,
}: {
  facet: Facet;
  selection: readonly FacetSelectionEntry[];
  onSelectionChange: (next: readonly FacetSelectionEntry[]) => void;
}) {
  const { t } = useTranslation();

  return (
    <View className="gap-space-8">
      {facet.groupLabel === undefined ? null : (
        <Text className="text-caption text-text-tertiary">{facet.groupLabel.text}</Text>
      )}
      <Text className="text-captionBold text-text">{facet.label.text}</Text>

      {facet.values.shape === 'buckets' ? (
        <View
          className="flex-row flex-wrap gap-space-8"
          accessibilityRole={facet.multiSelect ? 'none' : 'radiogroup'}
          accessibilityLabel={facet.label.text}
        >
          {facet.values.buckets.map((bucket) => (
            <FacetBucketChip
              key={bucket.key}
              facetKey={facet.key}
              origin={facet.origin}
              bucket={bucket}
              multiSelect={facet.multiSelect}
              selection={selection}
              onSelectionChange={onSelectionChange}
            />
          ))}
        </View>
      ) : (
        // A range facet needs a two-handle control this workstream did not
        // build. Its BOUNDS are still stated, because a shopper reading "from
        // 4.7 to 6.9 in" learns something true, where an absent block would say
        // the attribute does not exist. Named in `docs/storefront-catalog.md`.
        <Text className="text-caption text-text-secondary">
          {facet.values.shape === 'range'
            ? `${String(facet.values.range.min)} – ${String(facet.values.range.max)}${
                facet.values.range.unit === undefined ? '' : ` ${facet.values.range.unit}`
              }`
            : `${formatMoney({
                amount: facet.values.range.minMinor,
                currency: facet.values.range.currency,
              })} – ${formatMoney({
                amount: facet.values.range.maxMinor,
                currency: facet.values.range.currency,
              })}`}
        </Text>
      )}

      {/*
        Prices the scope contained and this facet could not include (#463).

        `FacetMoneyRange.unconvertibleCurrencies` is `string`, not
        `CurrencyCode`, precisely so a currency Mercaria does not model can be
        NAMED — and a rail that read the bound and dropped that list would
        restore the silence #463 exists to end, one layer up. A shopper reading
        "from 10 € to 900 €" with no note has no way to know some offers were
        left out of it. `unmodelledCurrencies` is a subset of this list and is
        deliberately not rendered separately: permanent-versus-transient is an
        operator's distinction, and both mean the same thing to somebody
        choosing a price bound.
      */}
      {facet.values.shape === 'money_range' &&
      facet.values.range.unconvertibleCurrencies !== undefined &&
      facet.values.range.unconvertibleCurrencies.length > 0 ? (
        <Text className="text-caption text-text-tertiary">
          {t('catalog.filters.pricesNotConverted', {
            currencies: facet.values.range.unconvertibleCurrencies.join(', '),
          })}
        </Text>
      ) : null}

      {facet.unknownCount > 0 ? (
        <Text className="text-caption text-text-tertiary">
          {t('catalog.filters.unknownCount', { count: facet.unknownCount })}
        </Text>
      ) : null}
    </View>
  );
}

function FacetBucketChip({
  facetKey,
  origin,
  bucket,
  multiSelect,
  selection,
  onSelectionChange,
}: {
  facetKey: string;
  origin: FacetOrigin;
  bucket: FacetBucket;
  multiSelect: boolean;
  selection: readonly FacetSelectionEntry[];
  onSelectionChange: (next: readonly FacetSelectionEntry[]) => void;
}) {
  return (
    <Pressable
      accessibilityRole={multiSelect ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: bucket.selected }}
      // The COUNT is in the announced label rather than in a second element:
      // "Black, 12 products" is one thing to hear, and a count rendered as its
      // own node is a second focus stop that reads as another control.
      accessibilityLabel={`${bucket.label.text}, ${String(bucket.count)}`}
      onPress={() =>
        onSelectionChange(
          toggleFacetValue(selection, origin, facetKey, bucket.key, multiSelect),
        )
      }
      className={
        bucket.selected
          ? 'rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6'
          : 'rounded-radius-max border border-border-secondary px-space-12 py-space-6'
      }
    >
      {/* The selected state is spelled as well as announced, never colour alone. */}
      <Text className="text-caption text-text">
        {bucket.selected ? `${bucket.label.text} ✓` : bucket.label.text} ({bucket.count})
      </Text>
    </Pressable>
  );
}
