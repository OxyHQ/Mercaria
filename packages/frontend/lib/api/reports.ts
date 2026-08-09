import type { ApiResponse, CreateAbuseReportInput } from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Abuse reports — `POST /reports`.
 *
 * NOT the store SALES ANALYTICS at `/admin/stores/:storeId/reports/*`. Same
 * English word, unrelated domains.
 *
 * The reporter is never in the payload: the server takes it from the
 * authenticated session, because a client-supplied reporter is an attribution
 * forgery. `CreateAbuseReportInput` has no field for one.
 */

/** What the server acknowledges when a report is STORED. */
export interface AbuseReportReceipt {
  id: string;
  reportedType: string;
  reportedId: string;
  createdAt: string;
}

/**
 * Submit an abuse report.
 *
 * A success here means STORED, never "reviewed" and never "CrowdSource accepted
 * it" — the server makes no outbound call in the request. The UI must say
 * "thanks, we have it" and nothing about an outcome.
 */
export async function submitAbuseReport(
  input: CreateAbuseReportInput,
): Promise<AbuseReportReceipt> {
  const { data } = await apiClient.post<ApiResponse<AbuseReportReceipt>>('/reports', input);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Could not submit the report');
  }
  return data.data;
}
