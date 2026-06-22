import type {
  ApiResponse,
  ReportSummary,
  SalesReportPoint,
  SalesReportInterval,
  TopProduct,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/reports`;

/** GET the single-snapshot report summary. */
export async function fetchReportSummary(storeId: string): Promise<ReportSummary> {
  const { data } = await apiClient.get<ApiResponse<ReportSummary>>(`${base(storeId)}/summary`);
  return unwrap(data);
}

/** GET the sales-over-time report, bucketed by `interval`. */
export async function fetchSalesReport(
  storeId: string,
  params: { from?: string; to?: string; interval?: SalesReportInterval } = {},
): Promise<SalesReportPoint[]> {
  const { data } = await apiClient.get<ApiResponse<SalesReportPoint[]>>(`${base(storeId)}/sales`, {
    params,
  });
  return unwrap(data);
}

/** GET the top-products report, ranked by units/revenue. */
export async function fetchTopProducts(
  storeId: string,
  params: { from?: string; to?: string; limit?: number } = {},
): Promise<TopProduct[]> {
  const { data } = await apiClient.get<ApiResponse<TopProduct[]>>(`${base(storeId)}/top-products`, {
    params,
  });
  return unwrap(data);
}
