import type {
  AcceptFeeScheduleInput,
  ApiResponse,
  FeePreview,
  FeePreviewInput,
  FeeScheduleAcceptanceSummary,
  StoreFeeScheduleView,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/fees`;

/**
 * GET the schedule currently applicable to this store, plus this store's
 * acceptance of that exact version when one exists.
 *
 * An EMPTY view is a real answer, not an error: a deployment with no active
 * schedule charges a real zero, and the screen says so rather than implying
 * something failed to load.
 */
export async function fetchFeeSchedule(storeId: string): Promise<StoreFeeScheduleView> {
  const { data } = await apiClient.get<ApiResponse<StoreFeeScheduleView>>(
    `${base(storeId)}/schedule`,
  );
  return unwrap(data);
}

/**
 * POST the owner's acceptance of the schedule version the screen showed.
 *
 * The body echoes what was on screen and the server checks every part of it
 * against the schedule actually in force, so a dialog that went stale is
 * refused with a conflict naming the current version rather than recorded
 * against the wrong one. The caller must refetch and show the new terms.
 */
export async function acceptFeeSchedule(
  storeId: string,
  input: AcceptFeeScheduleInput,
): Promise<FeeScheduleAcceptanceSummary> {
  const { data } = await apiClient.post<ApiResponse<FeeScheduleAcceptanceSummary>>(
    `${base(storeId)}/accept`,
    input,
  );
  return unwrap(data);
}

/**
 * POST a hypothetical basis and get the fee back from the SAME arithmetic
 * checkout applies.
 *
 * Deliberately a server call rather than a client-side calculation of the
 * percentage and clamps this screen already has in hand: two implementations of
 * one fee is exactly the disagreement `services/fees/` exists to prevent, and
 * the one that would drift is the one nothing charges against.
 */
export async function previewFee(
  storeId: string,
  input: FeePreviewInput,
): Promise<FeePreview> {
  const { data } = await apiClient.post<ApiResponse<FeePreview>>(
    `${base(storeId)}/preview`,
    input,
  );
  return unwrap(data);
}
