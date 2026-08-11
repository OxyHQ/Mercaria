import type {
  ApiResponse,
  MerchantBillingSessionView,
  MerchantPlanCatalogEntry,
  MerchantPlanStatusView,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/plan`;

/** This store's plan, effective entitlements and usage. */
export async function fetchPlanStatus(storeId: string): Promise<MerchantPlanStatusView> {
  const { data } = await apiClient.get<ApiResponse<MerchantPlanStatusView>>(base(storeId));
  return unwrap(data);
}

/** The plan comparison, with exact current capabilities. */
export async function fetchPlanCatalog(storeId: string): Promise<MerchantPlanCatalogEntry[]> {
  const { data } = await apiClient.get<ApiResponse<{ plans: MerchantPlanCatalogEntry[] }>>(
    `${base(storeId)}/catalog`,
  );
  return unwrap(data).plans;
}

/**
 * POST to start a paid plan, answering a hosted URL.
 *
 * The URL is single-use and short-lived, so it is never cached and never
 * stored — the caller opens it immediately, in the SYSTEM browser, exactly as
 * the payout-onboarding link is opened and for the same reason: a hosted
 * provider flow does not run inside an embedded webview.
 *
 * The body names a plan, a cadence and a currency and nothing about money. The
 * server resolves the price, the trial and the customer itself, so a client
 * cannot ask to be charged a figure it chose.
 */
export async function startPlanCheckout(
  storeId: string,
  input: { planId: string; interval: "monthly" | "annual"; currency: string },
): Promise<MerchantBillingSessionView> {
  const { data } = await apiClient.post<ApiResponse<MerchantBillingSessionView>>(
    `${base(storeId)}/checkout`,
    input,
  );
  return unwrap(data);
}

/** POST for a hosted billing-portal URL — invoices, cards and cancellation. */
export async function openBillingPortal(storeId: string): Promise<MerchantBillingSessionView> {
  const { data } = await apiClient.post<ApiResponse<MerchantBillingSessionView>>(
    `${base(storeId)}/portal`,
    {},
  );
  return unwrap(data);
}

/** POST to cancel at the end of the paid period. There is no immediate one. */
export async function cancelPlan(storeId: string): Promise<MerchantPlanStatusView> {
  const { data } = await apiClient.post<ApiResponse<MerchantPlanStatusView>>(
    `${base(storeId)}/cancel`,
    {},
  );
  return unwrap(data);
}
