/**
 * The store's product-feed surface (#63), which #87 finally gives screens.
 *
 * `docs/feed-importer.md` records the mapping screens as deferred with "every
 * endpoint they need exists", and this module is the client half of that.
 * Everything below is behind `channels:write` — a feed is a sales channel's
 * inventory arriving by file, which is why it lives beside `channels.ts` rather
 * than in an area of its own.
 *
 * ## Three shapes the server owns and this file does not re-derive
 *
 * A version's `feedUrlHost` is a HOST, never the URL: a feed URL is a credential
 * (Awin's download carries the key in the path), so the server redacts it for
 * every reader including the store that typed it. There is no field here to put
 * the full URL in, and none may be added.
 *
 * A mapping SUGGESTION is data, never an applied mapping — the server has no
 * writer for one, so applying it means the merchant sending it back as part of a
 * draft.
 *
 * `deliveryMode` has no default, deliberately: `snapshot` says an omitted row is
 * gone and `delta` says it is evidence of nothing, and the wrong answer either
 * retires a healthy catalogue or leaves delisted products on sale forever.
 */

import type {
  ApiResponse,
  FeedCompression,
  FeedDeliveryMode,
  FeedDryRunCounts,
  FeedEncoding,
  FeedFetchMode,
  FeedFieldMapping,
  FeedFieldRole,
  FeedFormat,
  FeedImportReportMode,
  FeedMappingSuggestion,
  FeedPreviewRecord,
  FeedValueMapping,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/feeds`;

/** One feed configuration, as the server projects it. */
export interface FeedConfiguration {
  id: string;
  sourceId: string;
  ownerKind: "merchant" | "operator";
  storeId: string | null;
  label: string;
  identityKeyFields: string[];
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One mapping version.
 *
 * `feedUrlHost` and not `feedUrl` — see the module header. There is no
 * `authSecret` or any derivative of one.
 */
export interface FeedVersion {
  id: string;
  configurationId: string;
  version: number;
  status: "draft" | "active" | "superseded";
  fetchMode: FeedFetchMode;
  uploadId: string | null;
  format: FeedFormat;
  delimiter: string | null;
  quoteChar: string | null;
  encoding: FeedEncoding | null;
  compression: FeedCompression | null;
  recordPath: string | null;
  hasHeaderRow: boolean | null;
  listSeparator: string | null;
  defaultCurrency: string | null;
  defaultCountry: string | null;
  defaultLanguage: string | null;
  deliveryMode: FeedDeliveryMode;
  authKind: string | null;
  authParamName: string | null;
  validatedReportId: string | null;
  activatedAt: string | null;
  activatedByOxyUserId: string | null;
  supersededAt: string | null;
  supersedesVersion: number | null;
  mappingNote: string | null;
  createdAt: string;
}

/** A feed's last runs, its next scheduled pass and its source health. */
export interface FeedStatus {
  configuration: FeedConfiguration;
  activeVersion: FeedVersion | null;
  source: {
    status: string;
    healthState: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextRunAt: string | null;
    consecutiveFailures: number;
    lastError: string | null;
  } | null;
  runs: {
    id: string;
    kind: string;
    status: string;
    outcome: string | null;
    fetched: number;
    stored: number;
    unchanged: number;
    rejected: number;
    offersUpserted: number;
    offersRetired: number;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

/** A bounded sample, mapped, with suggestions the merchant has NOT accepted. */
export interface FeedPreview {
  counts: FeedDryRunCounts;
  records: FeedPreviewRecord[];
  suggestions: FeedMappingSuggestion[];
  columns: string[];
}

/** One validation or import report. */
export interface FeedReport {
  id: string;
  configurationId: string;
  versionId: string;
  mode: FeedImportReportMode;
  scanned: number;
  valid: number;
  invalid: number;
  createdAt: string;
}

/** What a merchant fills in to create a feed. */
export interface CreateFeedInput {
  sourceName: string;
  label: string;
  /** FROZEN once written — re-keying is a NEW feed, never an edit. */
  identityKeyFields: string[];
  merchantId?: string;
  territories?: string[];
  fetchCadenceSeconds?: number;
  freshnessTtlSeconds?: number;
}

/** What a merchant fills in to draft a mapping version. */
export interface DraftFeedVersionInput {
  fetchMode: FeedFetchMode;
  feedUrl?: string;
  uploadId?: string;
  format: FeedFormat;
  delimiter?: string;
  quoteChar?: string;
  encoding?: FeedEncoding;
  compression?: FeedCompression;
  recordPath?: string;
  hasHeaderRow?: boolean;
  listSeparator?: string;
  defaultCurrency?: string;
  defaultCountry?: string;
  defaultLanguage?: string;
  /** No default: see the module header. */
  deliveryMode: FeedDeliveryMode;
  fieldMappings: FeedFieldMapping[];
  valueMappings?: FeedValueMapping[];
  mappingNote?: string;
}

/** GET this store's feeds. */
export async function fetchFeeds(storeId: string): Promise<FeedConfiguration[]> {
  const { data } = await apiClient.get<ApiResponse<FeedConfiguration[]>>(base(storeId));
  return unwrap(data);
}

/** POST to create a feed and its #62 source, in `draft` with NO rights. */
export async function createFeed(
  storeId: string,
  input: CreateFeedInput,
): Promise<FeedConfiguration> {
  const { data } = await apiClient.post<ApiResponse<FeedConfiguration>>(base(storeId), input);
  return unwrap(data);
}

/** GET one feed and its mapping versions. */
export async function fetchFeed(
  storeId: string,
  configurationId: string,
): Promise<{ configuration: FeedConfiguration; versions: FeedVersion[] }> {
  const { data } = await apiClient.get<
    ApiResponse<{ configuration: FeedConfiguration; versions: FeedVersion[] }>
  >(`${base(storeId)}/${configurationId}`);
  return unwrap(data);
}

/** GET the last runs, the next run, the counts and the failures. */
export async function fetchFeedStatus(
  storeId: string,
  configurationId: string,
): Promise<FeedStatus> {
  const { data } = await apiClient.get<ApiResponse<FeedStatus>>(
    `${base(storeId)}/${configurationId}/status`,
  );
  return unwrap(data);
}

/** POST to draft a mapping version. */
export async function draftFeedVersion(
  storeId: string,
  configurationId: string,
  input: DraftFeedVersionInput,
): Promise<FeedVersion> {
  const { data } = await apiClient.post<ApiResponse<FeedVersion>>(
    `${base(storeId)}/${configurationId}/versions`,
    input,
  );
  return unwrap(data);
}

/** POST to read a bounded sample, mapped, with suggestions. Writes nothing. */
export async function previewFeedVersion(
  storeId: string,
  configurationId: string,
  versionId: string,
): Promise<FeedPreview> {
  const { data } = await apiClient.post<ApiResponse<FeedPreview>>(
    `${base(storeId)}/${configurationId}/versions/${versionId}/preview`,
  );
  return unwrap(data);
}

/** POST to read the WHOLE feed and write a validation report. */
export async function validateFeedVersion(
  storeId: string,
  configurationId: string,
  versionId: string,
): Promise<FeedReport> {
  const { data } = await apiClient.post<ApiResponse<FeedReport>>(
    `${base(storeId)}/${configurationId}/versions/${versionId}/validate`,
  );
  return unwrap(data);
}

/**
 * POST to activate a version, CITING the validation report that justified it.
 *
 * The report id is required by the server, not by politeness: a version
 * activated against no evidence is a mapping nobody read applied to a live
 * catalogue.
 */
export async function activateFeedVersion(
  storeId: string,
  configurationId: string,
  versionId: string,
  reportId: string,
): Promise<{ activated: boolean }> {
  const { data } = await apiClient.post<ApiResponse<{ activated: boolean }>>(
    `${base(storeId)}/${configurationId}/versions/${versionId}/activate`,
    { reportId },
  );
  return unwrap(data);
}

/** GET this feed's reports. */
export async function fetchFeedReports(
  storeId: string,
  configurationId: string,
): Promise<FeedReport[]> {
  const { data } = await apiClient.get<ApiResponse<FeedReport[]>>(
    `${base(storeId)}/${configurationId}/reports`,
  );
  return unwrap(data);
}

/** POST to open a MANUAL pass. Resolves with the run it enqueued. */
export async function syncFeed(
  storeId: string,
  configurationId: string,
): Promise<{ runId: string; status: string }> {
  const { data } = await apiClient.post<ApiResponse<{ runId: string; status: string }>>(
    `${base(storeId)}/${configurationId}/sync`,
  );
  return unwrap(data);
}

/**
 * The URL a merchant downloads an error report from.
 *
 * A plain URL rather than a fetch, because the response is a CSV the browser
 * should save rather than JSON this client should parse. The report carries a
 * record INDEX, an issue code, a severity, a role and the merchant's own column
 * NAME — and no VALUES: they have the file, so the index is what they need.
 */
export function feedReportDownloadUrl(
  storeId: string,
  configurationId: string,
  reportId: string,
): string {
  return `${base(storeId)}/${configurationId}/reports/${reportId}/download`;
}

/** The roles a merchant maps a column onto, for the mapping form. */
export type FeedRole = FeedFieldRole;
