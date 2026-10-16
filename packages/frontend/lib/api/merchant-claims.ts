import axios from 'axios';
import type {
  ApiResponse,
  MerchantClaim,
  MerchantClaimChallengeInstructions,
  MerchantClaimMethod,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The claimant's half of merchant claiming (#83) — `/merchant-claims/*`.
 *
 * Every call is made under the signed-in Oxy session and is scoped by the
 * server to the caller's OWN claims; nothing here names a claimant, a state or
 * a reviewer, because the request schemas are `.strict()` and refuse all three.
 * What the server sends back is the claimant-facing DTO, which carries no
 * evidence and no other person's claim (`docs/merchant-claims.md`).
 *
 * ## The challenge token lives in memory only
 *
 * `issueMerchantClaimChallenge` is the ONE response that carries the one-time
 * token, and the server keeps only its digest. The caller holds it in the query
 * cache for the session so the claimant can come back to the instructions, and
 * persists it nowhere: a lost token is replaced by issuing a new challenge,
 * which supersedes the old one server-side.
 */

/** One evidence reference — a link or a note. Never a document body. */
export interface MerchantClaimEvidenceInput {
  url?: string;
  note?: string;
}

function unwrap<T>(payload: ApiResponse<T>, fallback: string): T {
  if (!payload.success || payload.data === undefined) {
    throw new Error(payload.error ?? payload.message ?? fallback);
  }
  return payload.data;
}

/** The caller's own claims, newest first. */
export async function fetchMyMerchantClaims(): Promise<MerchantClaim[]> {
  const { data } = await apiClient.get<ApiResponse<MerchantClaim[]>>('/merchant-claims');
  return unwrap(data, 'Failed to load your merchant claims');
}

/**
 * Open a claim. `domain` is required by the domain-proof methods and refused by
 * the others; the server's method registry is the authority on which is which.
 */
export async function openMerchantClaim(input: {
  merchantId: string;
  method: MerchantClaimMethod;
  domain?: string;
}): Promise<MerchantClaim> {
  const { data } = await apiClient.post<ApiResponse<MerchantClaim>>('/merchant-claims', input);
  return unwrap(data, 'Failed to open the merchant claim');
}

/** Issue a challenge. The response is the only place the token ever appears. */
export async function issueMerchantClaimChallenge(
  claimId: string,
): Promise<MerchantClaimChallengeInstructions> {
  const { data } = await apiClient.post<ApiResponse<MerchantClaimChallengeInstructions>>(
    `/merchant-claims/${encodeURIComponent(claimId)}/challenge`,
  );
  return unwrap(data, 'Failed to issue the verification challenge');
}

/** Ask the server to look for the published proof. */
export async function verifyMerchantClaim(input: {
  claimId: string;
  token: string;
}): Promise<MerchantClaim> {
  const { data } = await apiClient.post<ApiResponse<MerchantClaim>>(
    `/merchant-claims/${encodeURIComponent(input.claimId)}/verify`,
    { token: input.token },
  );
  return unwrap(data, 'Failed to verify the merchant claim');
}

/** Send a document claim to a person for review. */
export async function submitMerchantClaim(input: {
  claimId: string;
  evidence: readonly MerchantClaimEvidenceInput[];
}): Promise<MerchantClaim> {
  const { data } = await apiClient.post<ApiResponse<MerchantClaim>>(
    `/merchant-claims/${encodeURIComponent(input.claimId)}/submit`,
    { evidence: input.evidence },
  );
  return unwrap(data, 'Failed to submit the merchant claim');
}

/** Contest a merchant's existing verified operator. Decided by a person. */
export async function contestMerchantClaim(input: {
  merchantId: string;
  reason: string;
  evidence?: readonly MerchantClaimEvidenceInput[];
}): Promise<MerchantClaim> {
  const { data } = await apiClient.post<ApiResponse<MerchantClaim>>(
    '/merchant-claims/contest',
    input,
  );
  return unwrap(data, 'Failed to contest the merchant claim');
}

/** The HTTP status a failed claim call answered with, when it reached the server. */
export function merchantClaimErrorStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}
