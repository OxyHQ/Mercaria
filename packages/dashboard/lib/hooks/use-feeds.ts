import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  activateFeedVersion,
  createFeed,
  draftFeedVersion,
  fetchFeed,
  fetchFeedReports,
  fetchFeedStatus,
  fetchFeeds,
  previewFeedVersion,
  syncFeed,
  validateFeedVersion,
  type CreateFeedInput,
  type DraftFeedVersionInput,
  type FeedConfiguration,
  type FeedPreview,
  type FeedReport,
  type FeedStatus,
  type FeedVersion,
} from "../api/feeds";
import { queryKeys } from "../queryKeys";

/**
 * Invalidate a feed's own views after a write.
 *
 * The detail and the status describe the same feed from two angles — the
 * versions and the runs — so activating a version without refreshing the status
 * leaves the screen showing the previous active version's last pass as if it
 * were the new one's.
 */
function invalidateFeed(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
  configurationId: string,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.feed(storeId, configurationId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.feedStatus(storeId, configurationId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.feedReports(storeId, configurationId) });
}

/** This store's feeds. */
export function useFeeds(storeId: string) {
  return useQuery<FeedConfiguration[]>({
    queryKey: queryKeys.feeds(storeId),
    queryFn: () => fetchFeeds(storeId),
    enabled: Boolean(storeId),
  });
}

/** One feed and its mapping versions. */
export function useFeed(storeId: string, configurationId: string) {
  return useQuery<{ configuration: FeedConfiguration; versions: FeedVersion[] }>({
    queryKey: queryKeys.feed(storeId, configurationId),
    queryFn: () => fetchFeed(storeId, configurationId),
    enabled: Boolean(storeId) && Boolean(configurationId),
  });
}

/** The last runs, the next run, the counts and the failures. */
export function useFeedStatus(storeId: string, configurationId: string) {
  return useQuery<FeedStatus>({
    queryKey: queryKeys.feedStatus(storeId, configurationId),
    queryFn: () => fetchFeedStatus(storeId, configurationId),
    enabled: Boolean(storeId) && Boolean(configurationId),
  });
}

/** This feed's validation and import reports. */
export function useFeedReports(storeId: string, configurationId: string) {
  return useQuery<FeedReport[]>({
    queryKey: queryKeys.feedReports(storeId, configurationId),
    queryFn: () => fetchFeedReports(storeId, configurationId),
    enabled: Boolean(storeId) && Boolean(configurationId),
  });
}

/** Create a feed and its source, in `draft` with no rights. */
export function useCreateFeed(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFeedInput) => createFeed(storeId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.feeds(storeId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelSummary(storeId) });
    },
  });
}

/** Draft a mapping version. */
export function useDraftFeedVersion(storeId: string, configurationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DraftFeedVersionInput) =>
      draftFeedVersion(storeId, configurationId, input),
    onSuccess: () => invalidateFeed(queryClient, storeId, configurationId),
  });
}

/**
 * Preview a version.
 *
 * Deliberately does NOT invalidate: a preview writes nothing, so refreshing the
 * feed after one would be a round trip for an answer that cannot have changed.
 */
export function usePreviewFeedVersion(storeId: string, configurationId: string) {
  return useMutation<FeedPreview, Error, string>({
    mutationFn: (versionId: string) => previewFeedVersion(storeId, configurationId, versionId),
  });
}

/** Read the WHOLE feed and write a validation report. */
export function useValidateFeedVersion(storeId: string, configurationId: string) {
  const queryClient = useQueryClient();
  return useMutation<FeedReport, Error, string>({
    mutationFn: (versionId: string) => validateFeedVersion(storeId, configurationId, versionId),
    onSuccess: () => invalidateFeed(queryClient, storeId, configurationId),
  });
}

/** Activate a version, citing the validation report that justified it. */
export function useActivateFeedVersion(storeId: string, configurationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { versionId: string; reportId: string }) =>
      activateFeedVersion(storeId, configurationId, input.versionId, input.reportId),
    onSuccess: () => {
      invalidateFeed(queryClient, storeId, configurationId);
      queryClient.invalidateQueries({ queryKey: queryKeys.channelSummary(storeId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelReadiness(storeId) });
    },
  });
}

/** Open a MANUAL pass. */
export function useSyncFeed(storeId: string, configurationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncFeed(storeId, configurationId),
    onSuccess: () => invalidateFeed(queryClient, storeId, configurationId),
  });
}
