import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import {
  discardSellerDraft,
  fetchMatchCandidates,
  fetchSellerDraftPreview,
  fetchSellerDrafts,
  patchSellerDraft,
  publishSellerDraft,
  startSellerDraft,
  type PatchSellerDraftInput,
  type StartSellerDraftInput,
} from '../api/sell-yours';
import { queryKeys } from './query-keys';

/**
 * The "Sell yours" flow (#91) — one seller's own drafts.
 *
 * ## Everything is gated on the session having settled, not on `isAuthenticated`
 *
 * The device-first cold boot can take seconds to restore a session and every
 * call here is user-delegated, so the hooks render nothing rather than firing a
 * request that would 401 — the same gate `use-saves` and the cart hooks use.
 *
 * ## The PREVIEW is the source of truth for the whole flow
 *
 * A patch answers with the draft and nothing else; whether the draft may be
 * published, where it will appear and what the price guidance says are all
 * DERIVED server-side from four tables in three domains, so re-deriving any of
 * them on the client would be a second answer that goes stale the moment an
 * operator restricts a condition in a category. Every mutation therefore
 * invalidates the preview rather than patching a cached copy of it.
 */

/** Five seconds — a draft is a personal surface being actively edited. */
const STALE_TIME = 1000 * 5;

/** The seller's own unfinished flows, for the resume list. */
export function useSellerDrafts() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.sellerDrafts(),
    queryFn: fetchSellerDrafts,
    enabled: isAuthenticated,
    staleTime: STALE_TIME,
  });
}

/** One draft, with its readiness, placement and guidance. */
export function useSellerDraftPreview(
  draftId: string | undefined,
  params?: { currency?: string; market?: string },
) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.sellerDraftPreview(draftId ?? '', params),
    queryFn: () => fetchSellerDraftPreview(draftId ?? '', params),
    enabled: isAuthenticated && Boolean(draftId),
    staleTime: STALE_TIME,
  });
}

/**
 * Start or resume the flow.
 *
 * A retry with the same `clientDraftKey` resumes rather than opening a second
 * draft, which is what makes the resume list show one entry instead of a column
 * of abandoned attempts after a flaky connection.
 */
export function useStartSellerDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: StartSellerDraftInput) => startSellerDraft(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.sellerDrafts() });
    },
  });
}

/** Save one step's worth of edits. */
export function usePatchSellerDraft(draftId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: PatchSellerDraftInput) => patchSellerDraft(draftId ?? '', patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.sellerDraftPreviewRoot(draftId ?? '') });
      void client.invalidateQueries({ queryKey: queryKeys.sellerDrafts() });
    },
  });
}

/** Abandon a flow. The match assertions it produced survive it. */
export function useDiscardSellerDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) => discardSellerDraft(draftId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.sellerDrafts() });
    },
  });
}

/**
 * Publish, idempotently.
 *
 * There is deliberately no client-side "have I already submitted" flag: a flag
 * is exactly what a killed app loses, and the server answers a repeat with the
 * SAME listing id and `created: false`. The screen shows the same thing either
 * way.
 */
export function usePublishSellerDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) => publishSellerDraft(draftId),
    onSuccess: (_result, draftId) => {
      void client.invalidateQueries({ queryKey: queryKeys.sellerDraftPreviewRoot(draftId) });
      void client.invalidateQueries({ queryKey: queryKeys.sellerDrafts() });
    },
  });
}

/**
 * Canonical candidates for the identify step.
 *
 * A QUERY rather than a mutation, keyed on what was asked, so a seller who
 * re-scans the same barcode gets the cached answer instead of a second call.
 */
export function useMatchCandidates(params: { identifier?: string; q?: string }) {
  const { isAuthenticated } = useOxy();
  const hasExactlyOne = (params.identifier ? 1 : 0) + (params.q ? 1 : 0) === 1;
  return useQuery({
    queryKey: queryKeys.sellerMatchCandidates(params),
    queryFn: () => fetchMatchCandidates(params),
    enabled: isAuthenticated && hasExactlyOne,
    staleTime: STALE_TIME,
  });
}
