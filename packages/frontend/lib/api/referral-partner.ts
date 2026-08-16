import type {
  ApiResponse,
  ReferralCodePartnerView,
  ReferralLinkPartnerView,
  ReferralPartnerDashboard,
  ReferralPartnerEarnings,
  ReferralPartnerPerformance,
  ReferralPerformanceDimension,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The referral PARTNER surface (#147).
 *
 * ## No call here names a partner, and there is no parameter that could
 *
 * Every path is `/referral-partner/...` with no id in it, because the server
 * resolves the owner from the credential the request already carries — #146's
 * two-mount shape. A client function taking a `partnerId` would be the field a
 * future screen passes somebody else's, so none of them has one.
 *
 * ## The dashboard is ONE call, deliberately
 *
 * The parts are separate pages in different orders over different tables; a
 * client joining them drops whatever fell outside its own window, silently, as
 * a hole in a figure somebody is being paid on. `fetchReferralDashboard` is the
 * composed read, and the narrower calls below exist for the interactions that
 * genuinely re-fetch one section (changing the breakdown dimension, paging the
 * instrument list) rather than as a way to assemble the page.
 */

/** Unwrap the Mercaria envelope, or throw with whatever the server said. */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

export async function fetchReferralDashboard(): Promise<ReferralPartnerDashboard> {
  const { data } = await apiClient.get<ApiResponse<ReferralPartnerDashboard>>(
    '/referral-partner/dashboard',
  );
  return unwrap(data, 'Failed to load your referral dashboard');
}

/**
 * One breakdown, by ONE dimension.
 *
 * A POST, because the server validates it with a `.strict()` schema and that is
 * where "no cross-tabs" is enforced — the request has one `dimension` field and
 * no array, so a client cannot ask for market × date, which at a count of one
 * is a person even when both margins clear the floor.
 */
export async function fetchReferralPerformance(input: {
  dimension: ReferralPerformanceDimension;
  from: string;
  through: string;
}): Promise<ReferralPartnerPerformance> {
  const { data } = await apiClient.post<ApiResponse<ReferralPartnerPerformance>>(
    '/referral-partner/performance',
    input,
  );
  return unwrap(data, 'Failed to load your referral performance');
}

export async function fetchReferralEarnings(): Promise<ReferralPartnerEarnings> {
  const { data } = await apiClient.get<ApiResponse<ReferralPartnerEarnings>>(
    '/referral-partner/earnings',
  );
  return unwrap(data, 'Failed to load your referral earnings');
}

export interface ReferralInstruments {
  codes: readonly ReferralCodePartnerView[];
  links: readonly ReferralLinkPartnerView[];
}

export async function fetchReferralInstruments(before?: string): Promise<ReferralInstruments> {
  const { data } = await apiClient.get<ApiResponse<ReferralInstruments>>(
    '/referral-partner/instruments',
    { params: before ? { before } : undefined },
  );
  return unwrap(data, 'Failed to load your referral links and codes');
}

/**
 * Create a code.
 *
 * There is no `destinationUrl` and no `url` on this input, and that is the
 * point rather than an omission: an instrument names a destination TYPE and the
 * destination's own id, and the server composes the redirect from a configured
 * origin. A client that could supply a URL would be the arbitrary-redirect
 * injector #143's edge exists to make unrepresentable.
 */
export interface CreateReferralCodeInput {
  programId: string;
  requestedCode?: string;
  destinationType?: 'home' | 'listing' | 'collection' | 'store';
  destinationRef?: string;
  campaignRef?: string;
  contentKey?: string;
  market?: string;
  locale?: string;
}

export async function createReferralCode(
  input: CreateReferralCodeInput,
): Promise<ReferralCodePartnerView> {
  const { data } = await apiClient.post<ApiResponse<{ code: ReferralCodePartnerView }>>(
    '/referral-partner/codes',
    input,
  );
  return unwrap(data, 'Failed to create the referral code').code;
}

export interface CreateReferralLinkInput {
  codeId: string;
  destinationType?: 'home' | 'listing' | 'collection' | 'store';
  destinationRef?: string;
  campaignRef?: string;
  contentKey?: string;
}

export async function createReferralLink(
  input: CreateReferralLinkInput,
): Promise<ReferralLinkPartnerView> {
  const { data } = await apiClient.post<ApiResponse<{ link: ReferralLinkPartnerView }>>(
    '/referral-partner/links',
    input,
  );
  return unwrap(data, 'Failed to create the referral link').link;
}

/**
 * Retire a code.
 *
 * A REASON is required by the server, on a partner's own instrument, because
 * every referral transition records one — and the alternative is a trail of
 * retirements with no explanation for whoever later asks why a partner's
 * attribution stopped. There is deliberately no delete: a retired code keeps
 * its row and its namespace reservation forever (ADR 0005 D3), so a recycled
 * code can never let a new owner inherit somebody else's history.
 */
export async function retireReferralCode(input: {
  codeId: string;
  reason: string;
}): Promise<ReferralCodePartnerView> {
  const { data } = await apiClient.post<ApiResponse<{ code: ReferralCodePartnerView }>>(
    `/referral-partner/codes/${encodeURIComponent(input.codeId)}/retire`,
    { reason: input.reason },
  );
  return unwrap(data, 'Failed to retire the referral code').code;
}

export async function revokeReferralLink(input: {
  linkId: string;
  reason: string;
}): Promise<ReferralLinkPartnerView> {
  const { data } = await apiClient.post<ApiResponse<{ link: ReferralLinkPartnerView }>>(
    `/referral-partner/links/${encodeURIComponent(input.linkId)}/revoke`,
    { reason: input.reason },
  );
  return unwrap(data, 'Failed to revoke the referral link').link;
}
