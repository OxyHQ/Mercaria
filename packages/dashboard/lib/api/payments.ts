import type {
  ApiResponse,
  ProviderOnboardingLink,
  SellerPaymentSettings,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

const base = (storeId: string) => `/admin/stores/${storeId}/payments`;

/** GET the store's payment standing, plus whether this deployment can onboard. */
export async function fetchPaymentSettings(storeId: string): Promise<SellerPaymentSettings> {
  const { data } = await apiClient.get<ApiResponse<SellerPaymentSettings>>(
    `${base(storeId)}/account`,
  );
  return unwrap(data);
}

/**
 * POST for a hosted-onboarding link, opening the store's Peable account if this
 * is the first time.
 *
 * The URL is single-use and expires in minutes, so it is never cached and never
 * stored — the caller opens it immediately, in the SYSTEM browser. A hosted
 * provider flow does not run inside an embedded webview.
 */
export async function createOnboardingLink(
  storeId: string,
  country?: string,
): Promise<ProviderOnboardingLink> {
  const { data } = await apiClient.post<ApiResponse<ProviderOnboardingLink>>(
    `${base(storeId)}/account/onboarding-link`,
    country === undefined ? {} : { country },
  );
  return unwrap(data);
}

/** POST to re-read the account from Peable now — the owner is back from the hosted flow. */
export async function refreshPaymentSettings(storeId: string): Promise<SellerPaymentSettings> {
  const { data } = await apiClient.post<ApiResponse<SellerPaymentSettings>>(
    `${base(storeId)}/account/refresh`,
    {},
  );
  return unwrap(data);
}
