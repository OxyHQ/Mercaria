import { useQuery } from '@tanstack/react-query';
import type {
  ReportSummary,
  SalesReportPoint,
  SalesReportInterval,
  TopProduct,
} from '@mercaria/shared-types';
import { fetchReportSummary, fetchSalesReport, fetchTopProducts } from '../api/reports';
import type { ReportRange } from '../report-range';
import { queryKeys } from '../queryKeys';

/** Single-snapshot report summary. */
export function useReportSummary(storeId: string) {
  return useQuery<ReportSummary>({
    queryKey: queryKeys.reports.summary(storeId),
    queryFn: () => fetchReportSummary(storeId),
    enabled: Boolean(storeId),
  });
}

/** Sales-over-time report, bucketed by interval (default: day). */
export function useSalesReport(
  storeId: string,
  interval: SalesReportInterval = 'day',
  range?: ReportRange,
) {
  return useQuery<SalesReportPoint[]>({
    queryKey: [...queryKeys.reports.sales(storeId, interval), range],
    queryFn: () => fetchSalesReport(storeId, { interval, ...range }),
    enabled: Boolean(storeId),
  });
}

/** Top-products report. */
export function useTopProducts(storeId: string, range?: ReportRange) {
  return useQuery<TopProduct[]>({
    queryKey: [...queryKeys.reports.topProducts(storeId), range],
    queryFn: () => fetchTopProducts(storeId, { limit: 5, ...range }),
    enabled: Boolean(storeId),
  });
}
