import { useQuery } from "@tanstack/react-query";
import type {
  ReportSummary,
  SalesReportPoint,
  SalesReportInterval,
  TopProduct,
} from "@mercaria/shared-types";
import { fetchReportSummary, fetchSalesReport, fetchTopProducts } from "../api/reports";
import { queryKeys } from "../queryKeys";

/** Single-snapshot report summary. */
export function useReportSummary(storeId: string) {
  return useQuery<ReportSummary>({
    queryKey: queryKeys.reports.summary(storeId),
    queryFn: () => fetchReportSummary(storeId),
    enabled: Boolean(storeId),
  });
}

/** Sales-over-time report, bucketed by interval (default: day). */
export function useSalesReport(storeId: string, interval: SalesReportInterval = "day") {
  return useQuery<SalesReportPoint[]>({
    queryKey: queryKeys.reports.sales(storeId, interval),
    queryFn: () => fetchSalesReport(storeId, { interval }),
    enabled: Boolean(storeId),
  });
}

/** Top-products report. */
export function useTopProducts(storeId: string) {
  return useQuery<TopProduct[]>({
    queryKey: queryKeys.reports.topProducts(storeId),
    queryFn: () => fetchTopProducts(storeId, { limit: 10 }),
    enabled: Boolean(storeId),
  });
}
