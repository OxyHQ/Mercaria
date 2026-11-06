import type {
  ApiResponse,
  MerchantBillingSessionView,
  MerchantPlanCheckoutView,
  MerchantPlanCatalogEntry,
  MerchantPlanStatusView,
  StoreCapabilitiesView,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';
import { withBillingIntent } from '../billing/persisted-intent';

const base = (storeId: string) => `/admin/stores/${storeId}/plan`;

/** This store's plan, effective entitlements and usage. */
export async function fetchPlanStatus(storeId: string): Promise<MerchantPlanStatusView> {
  const { data } = await apiClient.get<ApiResponse<MerchantPlanStatusView>>(base(storeId));
  return unwrap(data);
}

/** Which paid tools this store holds — readable by any member. */
export async function fetchStoreCapabilities(storeId: string): Promise<StoreCapabilitiesView> {
  const { data } = await apiClient.get<ApiResponse<StoreCapabilitiesView>>(
    `${base(storeId)}/capabilities`,
  );
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
 * POST to start a paid plan, answering the Peable Checkout Session the merchant
 * pays in the dashboard's Peable sheet — its payer `clientSecret` and the price
 * it was created for. Short-lived, so it is never cached and never stored.
 *
 * The body names a plan, a cadence and a currency and nothing about money. The
 * server resolves the price, the trial and the customer itself, so a client
 * cannot ask to be charged a figure it chose.
 */
export async function startPlanCheckout(
  storeId: string,
  input: { planId: string; interval: 'monthly' | 'annual'; currency: string },
): Promise<MerchantPlanCheckoutView> {
  return withBillingIntent(
    [storeId, 'checkout', input.planId, input.interval, input.currency],
    async (key) => {
      const { data } = await apiClient.post<ApiResponse<MerchantPlanCheckoutView>>(
        `${base(storeId)}/checkout`,
        input,
        { headers: { 'Idempotency-Key': key } },
      );
      return unwrap(data);
    },
  );
}

/**
 * POST to move a live subscription to another paid plan or billing period.
 * Answers the plan status the rail's answer produced — the change is applied
 * synchronously, so this is the new state rather than a prediction of it.
 */
export async function changePlan(
  storeId: string,
  input: { planId: string; interval: 'monthly' | 'annual'; currency: string },
): Promise<MerchantPlanStatusView> {
  return withBillingIntent(
    [storeId, 'change', input.planId, input.interval, input.currency],
    async (key) => {
      const { data } = await apiClient.post<ApiResponse<MerchantPlanStatusView>>(
        `${base(storeId)}/change`,
        input,
        { headers: { 'Idempotency-Key': key } },
      );
      return unwrap(data);
    },
  );
}

/** POST for a hosted billing-portal URL — invoices, cards and cancellation. */
export async function openBillingPortal(storeId: string): Promise<MerchantBillingSessionView> {
  return withBillingIntent([storeId, 'portal'], async (key) => {
    const { data } = await apiClient.post<ApiResponse<MerchantBillingSessionView>>(
      `${base(storeId)}/portal`,
      {},
      { headers: { 'Idempotency-Key': key } },
    );
    return unwrap(data);
  });
}

/** POST to cancel at the end of the paid period. There is no immediate one. */
export async function cancelPlan(storeId: string): Promise<MerchantPlanStatusView> {
  return withBillingIntent([storeId, 'cancel'], async (key) => {
    const { data } = await apiClient.post<ApiResponse<MerchantPlanStatusView>>(
      `${base(storeId)}/cancel`,
      {},
      { headers: { 'Idempotency-Key': key } },
    );
    return unwrap(data);
  });
}
