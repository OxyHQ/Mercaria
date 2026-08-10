import type {
  ApiResponse,
  SellerDraftDTO,
  SellerDraftEntryPath,
  SellerDraftPreview,
  SellerMatchCandidateDTO,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The "Sell yours" API client (#91).
 *
 * ## The client mints the flow's idempotency key, once
 *
 * `clientDraftKey` is what makes a retried "start selling" tap resume rather
 * than open a second draft, and it has to come from the client because only the
 * client knows that two requests are the same INTENT. It is generated when the
 * flow screen mounts and kept for the life of that screen.
 *
 * ## Publication is idempotent and the client relies on it
 *
 * `POST /publish` answers with `{listingId, created}`. `created: false` means
 * "this draft was already published, here is the listing" — which is what a
 * native client that lost its response gets, and what a double tap produces.
 * The screen shows the same thing either way; there is deliberately no
 * client-side "have I already submitted" flag, because a flag is exactly what a
 * killed app loses.
 */

/**
 * Unwrap the Mercaria envelope, or throw with whatever the server said.
 *
 * `ApiResponse.data` is optional because a failure envelope carries none, so
 * every read has to state what it does when the call did not succeed. Throwing
 * is what React Query turns into an error state; returning a half-built object
 * would render an empty draft that looks like the seller's work was lost.
 */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

export interface StartSellerDraftInput {
  clientDraftKey: string;
  entryPath: SellerDraftEntryPath;
  canonicalProductId?: string;
  canonicalVariantId?: string;
}

/** Start a flow, or resume the one this `clientDraftKey` already opened. */
export async function startSellerDraft(input: StartSellerDraftInput): Promise<SellerDraftDTO> {
  const { data } = await apiClient.post<ApiResponse<SellerDraftDTO>>('/seller/drafts', input);
  return unwrap(data, 'Failed to start your listing');
}

/** The seller's own unfinished flows — the resume surface. */
export async function fetchSellerDrafts(): Promise<SellerDraftDTO[]> {
  const { data } = await apiClient.get<ApiResponse<SellerDraftDTO[]>>('/seller/drafts');
  return unwrap(data, 'Failed to load your drafts');
}

/**
 * The draft, whether it may be published, where it will appear, and the price
 * guidance — one call, because a review screen that fetched them separately
 * would render a publish button before it knew whether publishing was possible.
 */
export async function fetchSellerDraftPreview(
  draftId: string,
  params?: { currency?: string; market?: string },
): Promise<SellerDraftPreview> {
  const { data } = await apiClient.get<ApiResponse<SellerDraftPreview>>(
    `/seller/drafts/${draftId}`,
    { params },
  );
  return unwrap(data, 'Failed to load your draft');
}

/** Everything a step may change. Every field is the SELLER's own statement. */
export interface PatchSellerDraftInput {
  currentStep?: SellerDraftDTO['currentStep'];
  completedSteps?: SellerDraftDTO['currentStep'][];
  /** `null` REMOVES the match — an incorrect product can always be taken off. */
  canonicalProductId?: string | null;
  canonicalVariantId?: string | null;
  matchConfirmed?: boolean;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  conditionKey?: SellerDraftDTO['conditionKey'];
  conditionDetails?: { kind: string; severity?: string; note?: string }[];
  defectsAcknowledged?: boolean;
  includedAccessories?: string[];
  images?: {
    fileId: string;
    alt?: string;
    provenance: string;
    showsDefect?: boolean;
    detailIndex?: number;
  }[];
  quantity?: number;
  price?: { amount: number; currency: string };
  pickup?: SellerDraftDTO['pickup'];
  location?: { longitude: number; latitude: number } | null;
}

export async function patchSellerDraft(
  draftId: string,
  patch: PatchSellerDraftInput,
): Promise<SellerDraftDTO> {
  const { data } = await apiClient.patch<ApiResponse<SellerDraftDTO>>(
    `/seller/drafts/${draftId}`,
    patch,
  );
  return unwrap(data, 'Failed to save your draft');
}

export async function discardSellerDraft(draftId: string): Promise<void> {
  const { data } = await apiClient.delete<ApiResponse<{ discarded: boolean }>>(
    `/seller/drafts/${draftId}`,
  );
  unwrap(data, 'Failed to discard your draft');
}

export interface PublishSellerDraftResult {
  listingId: string;
  created: boolean;
}

export async function publishSellerDraft(draftId: string): Promise<PublishSellerDraftResult> {
  const { data } = await apiClient.post<ApiResponse<PublishSellerDraftResult>>(
    `/seller/drafts/${draftId}/publish`,
    {},
  );
  return unwrap(data, 'Failed to publish your listing');
}

/**
 * Canonical candidates for the identify step.
 *
 * Exactly one of `identifier` (a scan) or `q` (a search) — the server refuses
 * both, because "a barcode AND a phrase" has no single right answer and picking
 * one silently would make a scan sometimes behave like a search.
 */
export async function fetchMatchCandidates(params: {
  identifier?: string;
  q?: string;
}): Promise<SellerMatchCandidateDTO[]> {
  const { data } = await apiClient.get<ApiResponse<SellerMatchCandidateDTO[]>>(
    '/seller/drafts/candidates',
    { params },
  );
  return unwrap(data, 'Failed to find matching products');
}
