import axios from 'axios';
import type {
  ApiResponse,
  ReferralBindingResult,
  ReferralClientSurface,
  ReferralStateView,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The BUYER's side of referrals (#143): what a referral link left in this
 * browser, and the calls that turn it into an attribution.
 *
 * `GET /r/:token` leaves the click in an `HttpOnly` cookie on the API host, so
 * this code can never read or replay it; it only asks the server what it is
 * holding and asks it to bind. Not the partner surface (`referral-partner.ts`):
 * nothing here names a partner, a program or a code owner, and nothing here
 * could — the server's views carry none.
 *
 * ## `consent` is never sent
 *
 * Mercaria operates no consent framework, so the only honest declaration is
 * none at all: the server records `unknown`, which is what is true.
 */

/** Nothing held, nothing to disclose — also the answer when the edge is off. */
export const NO_REFERRAL_STATE: ReferralStateView = { state: 'none', disclosureRequired: false };

/** Unwrap the Mercaria envelope, or throw with whatever the server said. */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

/**
 * `/referrals/*` is always mounted on a current API, but the storefront deploys
 * independently of it, so a 404 (an API that predates the edge) reads as "no
 * referral" — an ordinary state, not an error to retry or show.
 */
function isUnmounted(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404;
}

export async function fetchReferralState(): Promise<ReferralStateView> {
  try {
    const { data } = await apiClient.get<ApiResponse<ReferralStateView>>('/referrals/state');
    return unwrap(data, 'Failed to read the referral state');
  } catch (error) {
    if (isUnmounted(error)) return NO_REFERRAL_STATE;
    throw error;
  }
}

/**
 * Redeem the carried click for whoever this request is: the signed-in account,
 * or the guest commerce session. `pending` means the caller has no subject yet
 * and the server kept the carrier for the next attempt.
 */
export async function bindReferral(): Promise<ReferralBindingResult> {
  try {
    const { data } = await apiClient.post<ApiResponse<ReferralBindingResult>>('/referrals/bind', {
      surface: 'web',
    });
    return unwrap(data, 'Failed to bind the referral');
  } catch (error) {
    if (isUnmounted(error)) return { state: 'none', disclosureRequired: false };
    throw error;
  }
}

/** A code the buyer typed themselves, outside checkout (ADR 0005 D4 `in_app`). */
export async function enterReferralCode(input: {
  code: string;
  surface: ReferralClientSurface;
}): Promise<ReferralBindingResult> {
  const { data } = await apiClient.post<ApiResponse<ReferralBindingResult>>(
    '/referrals/code-entry',
    {
      code: input.code,
      moment: 'in_app',
      surface: input.surface,
    },
  );
  return unwrap(data, 'Failed to apply the referral code');
}

/**
 * Bind a carried click to a merchant the caller has just opened a claim on
 * (#83) — `POST /referrals/merchant-binding`. The claim never waits on it and it
 * never throws: `null` means nothing was bound, and the carrier stays put.
 *
 * Here rather than beside the claim calls: the merchant-page isolation gate
 * scans every `lib/api` file named after the merchant domain for referral
 * inputs, and this is one.
 */
export async function bindMerchantReferral(input: {
  merchantId: string;
  surface: ReferralClientSurface;
}): Promise<ReferralBindingResult | null> {
  try {
    const { data } = await apiClient.post<ApiResponse<ReferralBindingResult>>(
      '/referrals/merchant-binding',
      { merchantId: input.merchantId, surface: input.surface },
    );
    return data.success && data.data !== undefined ? data.data : null;
  } catch {
    return null;
  }
}
