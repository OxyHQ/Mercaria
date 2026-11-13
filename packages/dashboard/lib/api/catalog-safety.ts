import type {
  ApiResponse,
  CatalogSafetyReviewCandidate,
  CatalogSafetyReviewDecision,
} from '@mercaria/shared-types';
import apiClient from './client';

export async function catalogSafetyAccess(): Promise<boolean> {
  const { data } = await apiClient.get<ApiResponse<{ allowed: boolean }>>(
    '/internal/catalog-safety/access',
  );
  return data.success === true && data.data?.allowed === true;
}
export async function catalogSafetyCandidates(cursor?: string) {
  const { data } = await apiClient.get<
    ApiResponse<{ items: CatalogSafetyReviewCandidate[]; nextCursor: string | null }>
  >('/internal/catalog-safety', { params: cursor ? { cursor } : {} });
  if (!data.data) throw new Error(data.message ?? data.error);
  return data.data;
}
export async function saveCatalogSafetyReview(
  listingId: string,
  contentDigest: string,
  decision: CatalogSafetyReviewDecision,
) {
  const { data } = await apiClient.post<ApiResponse<CatalogSafetyReviewCandidate>>(
    `/internal/catalog-safety/${listingId}/reviews`,
    { contentDigest, decision },
  );
  if (!data.data) throw new Error(data.message ?? data.error);
  return data.data;
}
