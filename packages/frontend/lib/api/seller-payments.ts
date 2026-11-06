import type {
  AcceptFeeScheduleInput,
  ApiResponse,
  FeeScheduleAcceptanceSummary,
  ProviderOnboardingLink,
  SellerFeeScheduleView,
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

/**
 * The marketplace fee schedule the seller's card sales are charged under, and
 * their acceptance of it (ADR 0018 D3). Empty when no schedule applies.
 */
export async function fetchSellerFeeSchedule(): Promise<SellerFeeScheduleView> {
  const { data } = await apiClient.get<ApiResponse<SellerFeeScheduleView>>('/seller/fees/schedule');
  return unwrap(data, 'Failed to load the marketplace fee');
}

/**
 * Accept the schedule's terms. The body echoes the version the screen showed, so
 * a schedule that moved underneath it is refused rather than accepted blind.
 */
export async function acceptSellerFeeSchedule(
  input: AcceptFeeScheduleInput,
): Promise<FeeScheduleAcceptanceSummary> {
  const { data } = await apiClient.post<ApiResponse<FeeScheduleAcceptanceSummary>>(
    '/seller/fees/accept',
    input,
  );
  return unwrap(data, 'Failed to accept the marketplace fee');
}
