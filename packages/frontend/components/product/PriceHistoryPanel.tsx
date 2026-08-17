import { View } from 'react-native';
import type { ConditionGroup, CurrencyCode, PriceHistoryResponse } from '@mercaria/shared-types';
import { Text, conditionGroupLabelKey, formatMoney } from '@mercaria/ui';
import { useProductPriceHistory } from '@/lib/hooks/use-product-page';
import { useTranslation } from '@/lib/i18n';

/**
 * What this product has cost (#78), rendered honestly.
 *
 * ## The gaps are the feature
 *
 * #78 returns POINTS, GAPS and UNCOVERED ranges as three different things
 * because they mean three different things: a price was observed, nobody was
 * offering the thing, and the series has not been built that far back. A chart
 * that drew a line through the second is inventing prices, and one that drew it
 * through the third is inventing a fact about the world from a fact about a
 * rebuild queue. This panel renders the server's own accessible summary and
 * table, and reports both kinds of absence as ranges.
 *
 * ## No canvas, and no line drawn between two points
 *
 * A visual chart is deferred deliberately rather than approximated: a
 * connecting line IS an interpolation claim, and the honest version needs the
 * gaps rendered as breaks. What ships here is the accessible half #78 already
 * composes server-side — the sentences and the table — which is the part a
 * screen reader and a print view need anyway (#71 UX rule 5's spirit and #78
 * API rule 7's letter).
 *
 * ## One segment, never blended
 *
 * New, refurbished and used are different series about different things (#90).
 * The panel asks for ONE, named, and says which one it is showing.
 */

export interface PriceHistoryPanelProps {
  canonicalProductId: string | undefined;
  segment: ConditionGroup | undefined;
  currency: CurrencyCode | undefined;
}

export function PriceHistoryPanel({
  canonicalProductId,
  segment,
  currency,
}: PriceHistoryPanelProps) {
  const { t } = useTranslation();
  const history = useProductPriceHistory({ canonicalProductId, segment, currency });

  // A 404 is the ordinary answer on a deployment that has not enabled public
  // price-history reads — the router is not mounted at all. Rendering nothing
  // is right: an error a shopper cannot act on is noise, and a "chart
  // unavailable" box would advertise a feature this deployment does not have.
  if (history.isError || history.data === undefined || segment === undefined) return null;

  const response: PriceHistoryResponse = history.data;
  if (response.points.length === 0 && response.gaps.length === 0) return null;

  return (
    <View className="gap-space-12 rounded-radius-28 border border-border-secondary p-space-20">
      <Text className="text-sectionTitle text-text" accessibilityRole="header">
        {/* The heading is this app's own copy; the segment name is
            `@mercaria/ui`'s, resolved through the SAME `t` because #437 merges
            the shared bundle into this app's i18n instance. */}
        {t('product.priceHistoryHeading', { segment: t(conditionGroupLabelKey(segment)) })}
      </Text>

      {/* The server composes these, so three clients cannot each summarise a
          gap differently — and the one that gets it wrong is the one nobody is
          looking at (#78 API rule 7). */}
      {response.summary.sentences.map((sentence) => (
        <Text key={sentence} className="text-bodySmall text-text">
          {sentence}
        </Text>
      ))}

      {response.summary.lowest !== undefined && response.summary.lowest.value.basis !== undefined ? (
        <Text className="text-caption text-text-secondary">
          {t('product.priceHistory.lowestInWindow', {
            amount: formatMoney(response.summary.lowest.value.money),
          })}
        </Text>
      ) : null}

      {response.gaps.length > 0 ? (
        <Text className="text-caption text-text-secondary">
          {t('product.priceHistory.noOffersObserved', {
            count: response.gaps.reduce((total, gap) => total + gap.buckets, 0),
          })}
        </Text>
      ) : null}

      {response.uncovered.length > 0 ? (
        // NOT a gap, and never drawn as one: "we have not built this far back"
        // is a fact about Mercaria, and "nobody was selling it" is a fact about
        // the world.
        <Text className="text-caption text-text-secondary">
          {t('product.priceHistory.notFullyBuilt')}
        </Text>
      ) : null}

      {response.notice.conversionIsDisplayOnly ? (
        <Text className="text-caption text-text-tertiary">
          {t('product.priceHistory.conversionDisplayOnly')}
        </Text>
      ) : null}
    </View>
  );
}
