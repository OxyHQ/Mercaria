import { useQuery } from '@tanstack/react-query';
import type {
  StorePriceAnalyticsResponse,
  StorePriceTrendGranularity,
  StorePriceTrendResponse,
  StorePriceTrendWindowDays,
} from '@mercaria/shared-types';
import { fetchStorePriceAnalytics, fetchStorePriceTrend } from '../api/price-analytics';
import { queryKeys } from '../queryKeys';

/**
 * A comparison read costs the server one read per listing, so a result is kept
 * for a few minutes rather than refetched on every focus. The figures are a
 * snapshot with their own `computedAt`, which the screen shows.
 */
const STALE_MS = 5 * 60 * 1_000;

/** The store's listings against their comparisons, with the summary. */
export function useStorePriceAnalytics(storeId: string) {
  return useQuery<StorePriceAnalyticsResponse>({
    queryKey: queryKeys.priceAnalytics.overview(storeId),
    queryFn: () => fetchStorePriceAnalytics(storeId),
    enabled: Boolean(storeId),
    staleTime: STALE_MS,
    retry: false,
  });
}

/** One listing variant's price against its comparison over time. */
export function useStorePriceTrend(
  storeId: string,
  productVariantId: string,
  windowDays: StorePriceTrendWindowDays,
  granularity: StorePriceTrendGranularity,
) {
  return useQuery<StorePriceTrendResponse>({
    queryKey: queryKeys.priceAnalytics.trend(storeId, productVariantId, windowDays, granularity),
    queryFn: () => fetchStorePriceTrend(storeId, productVariantId, { windowDays, granularity }),
    enabled: Boolean(storeId) && Boolean(productVariantId),
    staleTime: STALE_MS,
    retry: false,
  });
}
