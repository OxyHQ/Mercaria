import axios from 'axios';
import type {
  ApiResponse,
  ReferralBindingResult,
  ReferralClientSurface,
  ReferralConsentAnswer,
  ReferralStateView,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The BUYER's side of referrals (#143): asking before anything is remembered,
 * and the calls that turn a followed link into an attribution.
 *
 * ## Consent first (ePrivacy Art. 5(3))
 *
 * `GET /r/:token` stores nothing on the device. It puts the click's signed
 * carrier in the destination's URL FRAGMENT, which the storefront takes into
 * memory and strips from the address bar (`use-referral-binding.ts`). Only when
 * the buyer allows it does {@link answerReferralConsent} present that carrier
 * — on the `X-Mercaria-Referral-State` header, the one place the server accepts
 * it — and only then does the server bind it or write its `HttpOnly` cookie.
 *
 * Not the partner surface (`referral-partner.ts`): nothing here names a
 * partner, a program or a code owner, and nothing here could — the server's
 * views carry none.
 */

/** Nothing held, nothing to disclose — also the answer when the edge is off. */
export const NO_REFERRAL_STATE: ReferralStateView = { state: 'none', disclosureRequired: false };

/** The request header the consent call presents the in-memory carrier on. */
const REFERRAL_STATE_HEADER = 'X-Mercaria-Referral-State';

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

/**
 * What an EARLIER, consented click left in this browser's cookie. A fresh
 * click's carrier never reaches the server this way: it is in page memory
 * until the buyer answers.
 */
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
 * The buyer's answer to the consent prompt.
 *
 * `granted` presents the carrier on the request header: the server binds it at
 * once when this request has a subject, or stores it as a cookie and answers
 * `pending` when it does not. `denied` sends no carrier at all — the server
 * verifies nothing, writes nothing and clears any carrier cookie.
 */
export async function answerReferralConsent(input: {
  consent: ReferralConsentAnswer;
  carrier: string | null;
}): Promise<ReferralBindingResult> {
  try {
    const { data } = await apiClient.post<ApiResponse<ReferralBindingResult>>(
      '/referrals/consent',
      { consent: input.consent, surface: 'web' },
      input.consent === 'granted' && input.carrier
        ? { headers: { [REFERRAL_STATE_HEADER]: input.carrier } }
        : undefined,
    );
    return unwrap(data, 'Failed to record the referral consent');
  } catch (error) {
    if (isUnmounted(error)) return { state: 'none', disclosureRequired: false };
    throw error;
  }
}

/**
 * Redeem the consented carrier cookie for whoever this request is: the
 * signed-in account, or the guest commerce session. `pending` means the caller
 * has no subject yet and the server kept the carrier for the next attempt.
 *
 * `consent` is never sent: the carrier itself says the buyer allowed it, and
 * the server records that rather than taking the client's word.
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
