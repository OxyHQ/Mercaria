import type {
  ApiResponse,
  ConversionReportExport,
  ConversionReportInterval,
  ConversionReportWindow,
  ConversionTrendReport,
  ListingConversionReport,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

/**
 * The checkout conversion report — the paid `advanced_demand_analytics` tool.
 * Every route answers 403 `PLAN_CAPABILITY_REQUIRED` when the store's plan does
 * not include it (`planRefusalOf`).
 */
const base = (storeId: string) => `/admin/stores/${storeId}/analytics/advanced`;

/** GET the per-listing conversion report over a window. */
export async function fetchListingConversion(
  storeId: string,
  window: ConversionReportWindow,
): Promise<ListingConversionReport> {
  const { data } = await apiClient.get<ApiResponse<ListingConversionReport>>(
    `${base(storeId)}/listings`,
    { params: window },
  );
  return unwrap(data);
}

/** GET the conversion trend, with the comparison against the previous period. */
export async function fetchConversionTrend(
  storeId: string,
  window: ConversionReportWindow,
  interval: ConversionReportInterval,
): Promise<ConversionTrendReport> {
  const { data } = await apiClient.get<ApiResponse<ConversionTrendReport>>(
    `${base(storeId)}/trend`,
    { params: { ...window, interval } },
  );
  return unwrap(data);
}

/**
 * GET one report as CSV text. Fetched through the authenticated client rather
 * than opened as a URL, because the request needs the member's session.
 */
export async function fetchConversionCsv(
  storeId: string,
  report: ConversionReportExport,
  window: ConversionReportWindow,
  interval: ConversionReportInterval,
): Promise<string> {
  const { data } = await apiClient.get<string>(`${base(storeId)}/export`, {
    params: { ...window, interval, report },
    responseType: 'text',
    transformResponse: (raw: unknown) => raw,
  });
  return data;
}
