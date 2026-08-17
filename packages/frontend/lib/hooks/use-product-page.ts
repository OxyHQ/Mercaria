import { useQuery } from '@tanstack/react-query';
import type {
  CanonicalProductPage,
  ConditionGroup,
  CurrencyCode,
  OfferComparisonIntent,
  PriceHistoryResponse,
} from '@mercaria/shared-types';
import {
  fetchProductPage,
  fetchProductPriceHistory,
  type ProductPageParams,
} from '../api/product-page';
import { queryKeys } from './query-keys';

/**
 * The canonical product page (#71) and the chart beside it (#78).
 *
 * ## The variant is part of the KEY, not a filter applied afterwards
 *
 * A variant-scoped page is a different server read — the comparison is scoped
 * to one configuration and cannot contain another's offer — so it is a
 * different cache entry. Filtering one cached product-wide answer down would
 * put the wrong configuration's price on screen for as long as it took the
 * refetch to land, which is #71 acceptance 4 failing in the window nobody
 * watches.
 */

/** One minute — offers move, and a stale price is the one thing a comparison must not show. */
const PAGE_STALE_TIME = 1000 * 60;

/** Ten minutes — a chart of finished days does not move while somebody reads it. */
const HISTORY_STALE_TIME = 1000 * 60 * 10;

/** How many days of history the panel asks for. */
const HISTORY_WINDOW_DAYS = 90;

/**
 * One canonical product page.
 *
 * A 404 is a legitimate outcome and is not retried past the first attempt: an
 * unknown handle, a product this deployment has not rolled canonical reads out
 * for, and a cohort this product is outside of all answer the same 404, and
 * retrying turns none of them into a page.
 */
export function useProductPage(
  handle: string | undefined,
  params?: ProductPageParams,
): ReturnType<typeof useQuery<CanonicalProductPage>> {
  return useQuery<CanonicalProductPage>({
    // The key is built from NAMED fields rather than the params object itself,
    // so a field added to the request without being added here fails `tsc`
    // instead of quietly sharing a cache entry with the request that lacks it.
    queryKey: queryKeys.productPage.detail(handle ?? '', {
      variant: params?.canonicalVariantId,
      market: params?.market,
      currency: params?.currency,
      intent: params?.intent,
      limit: params?.limit,
    }),
    queryFn: () => fetchProductPage(handle ?? '', params),
    enabled: Boolean(handle),
    staleTime: PAGE_STALE_TIME,
    retry: 1,
  });
}

/**
 * One product's price history, in ONE segment (#78, #90).
 *
 * The segment is required by the contract and is passed through rather than
 * defaulted here: new, refurbished and used histories are different series
 * about different things, and a chart that blended them would be the one shape
 * #78 exists to refuse.
 *
 * `retry: false` because the ordinary answer on a deployment that has not
 * enabled public price-history reads is a 404 from an unmounted router. That is
 * a configuration fact, not a transient failure, and the panel renders nothing
 * rather than an error a shopper cannot act on.
 */
export function useProductPriceHistory(input: {
  canonicalProductId: string | undefined;
  segment: ConditionGroup | undefined;
  currency: CurrencyCode | undefined;
  enabled?: boolean;
}): ReturnType<typeof useQuery<PriceHistoryResponse>> {
  const to = new Date();
  const from = new Date(to.getTime() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const canonicalProductId = input.canonicalProductId ?? '';
  const segment = input.segment;
  const currency = input.currency;

  return useQuery<PriceHistoryResponse>({
    queryKey: queryKeys.productPage.priceHistory(canonicalProductId, segment ?? '', currency ?? ''),
    queryFn: () =>
      fetchProductPriceHistory({
        canonicalProductId,
        segment: segment ?? 'new',
        measure: 'lowest_item_price',
        currency: currency ?? 'EUR',
        from: from.toISOString(),
        to: to.toISOString(),
      }),
    enabled:
      (input.enabled ?? true) &&
      Boolean(input.canonicalProductId) &&
      segment !== undefined &&
      currency !== undefined,
    staleTime: HISTORY_STALE_TIME,
    retry: false,
  });
}

/**
 * What an intent control offers, in the order a shopper reads them (#74).
 *
 * KEYS rather than the labels themselves: this is a module-scope `const`,
 * evaluated at import, so a sentence here would freeze into whichever language
 * loaded first. Declared and THEN frozen rather than `Object.freeze({ … })`,
 * because the i18n guard's key reader matches a `const X = { … }` initializer
 * and a call expression is not one — freezing inline would hide all five keys
 * from its referential check and they would read as dead copy.
 */
export const OFFER_INTENT_LABEL_KEYS: Readonly<Record<OfferComparisonIntent, string>> = {
  balanced: 'product.intent.balanced',
  cheapest: 'product.intent.cheapest',
  fastest: 'product.intent.fastest',
  official: 'product.intent.official',
  used: 'product.intent.used',
};
Object.freeze(OFFER_INTENT_LABEL_KEYS);
