import type {
  ApiResponse,
  ProviderOnboardingLink,
  SellerPaymentSettings,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The signed-in P2P seller's own payment account on Peable — `/seller/payments`.
 *
 * The owner is the caller on every route; nothing here names an account.
 */

function unwrap<T>(data: ApiResponse<T>, fallback: string): T {
  if (!data.success || data.data === undefined) {
    throw new Error(data.error ?? data.message ?? fallback);
  }
  return data.data;
}

/** The seller's payment standing, plus whether this deployment can onboard. */
export async function fetchSellerPaymentSettings(): Promise<SellerPaymentSettings> {
  const { data } = await apiClient.get<ApiResponse<SellerPaymentSettings>>(
    '/seller/payments/account',
  );
  return unwrap(data, 'Failed to load payment settings');
}

/**
 * A single-use hosted-onboarding link, opening the seller's Peable account the
 * first time. Never cached or stored: the caller opens it at once, in the
 * SYSTEM browser.
 */
export async function createSellerOnboardingLink(
  country?: string,
): Promise<ProviderOnboardingLink> {
  const { data } = await apiClient.post<ApiResponse<ProviderOnboardingLink>>(
    '/seller/payments/account/onboarding-link',
    country === undefined ? {} : { country },
  );
  return unwrap(data, 'Failed to start payment onboarding');
}

/** Ask Peable to re-read the account now — the seller is back from the hosted flow. */
export async function refreshSellerPaymentSettings(): Promise<SellerPaymentSettings> {
  const { data } = await apiClient.post<ApiResponse<SellerPaymentSettings>>(
    '/seller/payments/account/refresh',
    {},
  );
  return unwrap(data, 'Failed to refresh payment settings');
}
