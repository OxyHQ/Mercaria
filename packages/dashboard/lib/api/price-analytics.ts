import type {
  ApiResponse,
  StorePriceAnalyticsResponse,
  StorePriceTrendGranularity,
  StorePriceTrendResponse,
  StorePriceTrendWindowDays,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

/**
 * The store's competitive price analytics (#89's paid tool). Read-only: there
 * is no write here, and nothing a screen does with these figures changes a price.
 */
const base = (storeId: string) => `/admin/stores/${storeId}/price-analytics`;

/** GET every live, matched listing against its comparison, with the summary. */
export async function fetchStorePriceAnalytics(
  storeId: string,
): Promise<StorePriceAnalyticsResponse> {
  const { data } = await apiClient.get<ApiResponse<StorePriceAnalyticsResponse>>(
    `${base(storeId)}/listings`,
  );
  return unwrap(data);
}

/** GET one listing variant's price against its comparison over time. */
export async function fetchStorePriceTrend(
  storeId: string,
  productVariantId: string,
  params: { windowDays: StorePriceTrendWindowDays; granularity: StorePriceTrendGranularity },
): Promise<StorePriceTrendResponse> {
  const { data } = await apiClient.get<ApiResponse<StorePriceTrendResponse>>(
    `${base(storeId)}/listings/${encodeURIComponent(productVariantId)}/trend`,
    { params },
  );
  return unwrap(data);
}

/**
 * GET the same report as CSV text. Fetched with the session rather than opened
 * as a URL, because the route needs the caller's credential.
 */
export async function fetchStorePriceAnalyticsCsv(storeId: string): Promise<string> {
  const { data } = await apiClient.get<string>(`${base(storeId)}/listings`, {
    params: { format: 'csv' },
    responseType: 'text',
  });
  return data;
}
