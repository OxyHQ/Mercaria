import type {
  ApiResponse,
  ChannelApiKey,
  ChannelAuditEntry,
  ChannelDisconnectPolicy,
  ChannelDisconnectResult,
  ChannelOnboardingSession,
  ChannelOnboardingStep,
  ChannelPauseScope,
  ChannelPreviewCounts,
  ChannelReadiness,
  ChannelReconciliationSummary,
  ChannelSummary,
  ChannelTypeDescriptor,
  ChannelTypeId,
  Connection,
  ConnectionStatus,
  ConnectorProviderId,
  GenerateChannelApiKeyInput,
  GenerateChannelApiKeyResult,
  SyncRun,
  SyncRunRecordFailurePage,
  UpdateSyncSettingsInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/channels`;
const keysBase = (storeId: string) => `/admin/stores/${storeId}/channel-keys`;

/** Result of `DELETE .../channels/:connectionId` — the connection's final status. */
export interface DisconnectResult {
  id: string;
  status: ConnectionStatus;
}

/** GET the store's channel connections (the credential-free `Connection` DTOs). */
export async function fetchChannels(storeId: string): Promise<Connection[]> {
  const { data } = await apiClient.get<ApiResponse<Connection[]>>(base(storeId));
  return unwrap(data);
}

/**
 * POST to begin an OAuth connect for `provider`. The server validates the
 * `*.myshopify.com` shop domain and returns the platform authorize URL the
 * dashboard opens in a browser to complete authorization.
 */
export async function connectChannel(
  storeId: string,
  provider: ConnectorProviderId,
  input: { shopDomain: string },
): Promise<{ authorizeUrl: string }> {
  const { data } = await apiClient.post<ApiResponse<{ authorizeUrl: string }>>(
    `${base(storeId)}/${provider}/connect`,
    input,
  );
  return unwrap(data);
}

/** Input for an API-key channel connect (WooCommerce): site URL + REST key pair. */
export interface ConnectKeyInput {
  /** The merchant's WooCommerce site URL (must be `https://`). */
  shopDomain: string;
  /** WooCommerce REST API consumer key. */
  consumerKey: string;
  /** WooCommerce REST API consumer secret. */
  consumerSecret: string;
}

/**
 * POST to connect an API-key provider (WooCommerce). Unlike the OAuth `connect`
 * flow there is no browser redirect — the server verifies the credentials against
 * the merchant's site and returns the established (credential-free) `Connection`.
 */
export async function connectKeyChannel(
  storeId: string,
  provider: ConnectorProviderId,
  input: ConnectKeyInput,
): Promise<Connection> {
  const { data } = await apiClient.post<ApiResponse<Connection>>(
    `${base(storeId)}/${provider}/connect-key`,
    input,
  );
  return unwrap(data);
}

/** PATCH a connection's sync settings (whitelisted `UpdateSyncSettingsInput`). */
export async function updateChannelSettings(
  storeId: string,
  connectionId: string,
  settings: UpdateSyncSettingsInput,
): Promise<Connection> {
  const { data } = await apiClient.patch<ApiResponse<Connection>>(
    `${base(storeId)}/${connectionId}/settings`,
    settings,
  );
  return unwrap(data);
}

/** POST to trigger a backfill sync; resolves with the resulting `SyncRun`. */
export async function syncChannel(storeId: string, connectionId: string): Promise<SyncRun> {
  const { data } = await apiClient.post<ApiResponse<SyncRun>>(
    `${base(storeId)}/${connectionId}/sync`,
  );
  return unwrap(data);
}

/**
 * Result of `POST .../channels/:connectionId/webhooks/reregister` — the server
 * ENQUEUED the work (202) rather than doing it in the request (#262).
 *
 * There is nothing to report but that, deliberately: the outcome lands on the
 * CONNECTION (`webhookFailures`, `webhookRegistration`), which the channels query
 * re-reads, so a result carrying a verdict here would be a second answer to what
 * that DTO already gives — and it would be the wrong one, since a registration is
 * a handful of calls to somebody else's platform and has not happened yet.
 */
export interface ReregisterWebhooksResult {
  status: "enqueued";
  connectionId: string;
}

/** POST to register a connection's platform webhooks again, without a reconnect (#262). */
export async function reregisterChannelWebhooks(
  storeId: string,
  connectionId: string,
): Promise<ReregisterWebhooksResult> {
  const { data } = await apiClient.post<ApiResponse<ReregisterWebhooksResult>>(
    `${base(storeId)}/${connectionId}/webhooks/reregister`,
  );
  return unwrap(data);
}

/** DELETE (disconnect) a connection. */
export async function disconnectChannel(
  storeId: string,
  connectionId: string,
): Promise<DisconnectResult> {
  const { data } = await apiClient.delete<ApiResponse<DisconnectResult>>(
    `${base(storeId)}/${connectionId}`,
  );
  return unwrap(data);
}

// ---------------------------------------------------------------------------
// Channel API keys — long-lived credentials the WordPress/WooCommerce plugin
// uses to push its catalog in without a short-lived Oxy access token.
// ---------------------------------------------------------------------------

/** GET the store's active channel keys (metadata only — never the secret). */
export async function fetchChannelKeys(storeId: string): Promise<ChannelApiKey[]> {
  const { data } = await apiClient.get<ApiResponse<ChannelApiKey[]>>(keysBase(storeId));
  return unwrap(data);
}

/**
 * POST to mint a channel key. The plaintext key in the result is returned ONCE —
 * show it immediately and never store it; only its metadata can be listed later.
 */
export async function generateChannelKey(
  storeId: string,
  input: GenerateChannelApiKeyInput,
): Promise<GenerateChannelApiKeyResult> {
  const { data } = await apiClient.post<ApiResponse<GenerateChannelApiKeyResult>>(
    keysBase(storeId),
    input,
  );
  return unwrap(data);
}

/** DELETE (revoke) a channel key. Resolves with the revoked key's metadata. */
export async function revokeChannelKey(
  storeId: string,
  keyId: string,
): Promise<ChannelApiKey> {
  const { data } = await apiClient.delete<ApiResponse<ChannelApiKey>>(
    `${keysBase(storeId)}/${keyId}`,
  );
  return unwrap(data);
}

// ---------------------------------------------------------------------------
// The unified channel surface (#87). The catalog, the readiness result, the
// one-shape channel list, run history, reconciliation, pause and the
// policy-carrying disconnect.
// ---------------------------------------------------------------------------

/** GET what may be connected on this deployment, and what is wrong with each. */
export async function fetchChannelCatalog(storeId: string): Promise<ChannelTypeDescriptor[]> {
  const { data } = await apiClient.get<ApiResponse<ChannelTypeDescriptor[]>>(
    `${base(storeId)}/catalog`,
  );
  return unwrap(data);
}

/** GET connectors, feeds and the native catalogue in ONE shape. */
export async function fetchChannelSummary(storeId: string): Promise<ChannelSummary[]> {
  const { data } = await apiClient.get<ApiResponse<ChannelSummary[]>>(`${base(storeId)}/summary`);
  return unwrap(data);
}

/**
 * GET the ONE authoritative readiness result (#87 acceptance 7).
 *
 * The screen renders this rather than deriving anything from the connection
 * list: a client that computed "can this merchant sell" from provider flags is
 * exactly what this endpoint replaces.
 */
export async function fetchChannelReadiness(storeId: string): Promise<ChannelReadiness> {
  const { data } = await apiClient.get<ApiResponse<ChannelReadiness>>(
    `${base(storeId)}/readiness`,
  );
  return unwrap(data);
}

/** GET one connection's sync history, newest first. */
export async function fetchChannelRuns(storeId: string, connectionId: string): Promise<SyncRun[]> {
  const { data } = await apiClient.get<ApiResponse<SyncRun[]>>(
    `${base(storeId)}/${connectionId}/runs`,
  );
  return unwrap(data);
}

/**
 * GET which records ONE run refused, and why (#303).
 *
 * A separate call from the history rather than a field on it: fifty runs each
 * carrying up to two hundred reasons is a payload nobody asked for, and the
 * trigger a merchant acts on — `counts.failed` — is already on the run.
 */
export async function fetchChannelRunRecordFailures(
  storeId: string,
  connectionId: string,
  runId: string,
): Promise<SyncRunRecordFailurePage> {
  const { data } = await apiClient.get<ApiResponse<SyncRunRecordFailurePage>>(
    `${base(storeId)}/${connectionId}/runs/${runId}/record-failures`,
  );
  return unwrap(data);
}

/** GET what Mercaria already indexed for this connection's merchant. */
export async function fetchChannelReconciliation(
  storeId: string,
  connectionId: string,
): Promise<ChannelReconciliationSummary> {
  const { data } = await apiClient.get<ApiResponse<ChannelReconciliationSummary>>(
    `${base(storeId)}/${connectionId}/reconciliation`,
  );
  return unwrap(data);
}

/** GET who changed what about this store's channels. */
export async function fetchChannelAudit(storeId: string): Promise<ChannelAuditEntry[]> {
  const { data } = await apiClient.get<ApiResponse<ChannelAuditEntry[]>>(`${base(storeId)}/audit`);
  return unwrap(data);
}

/** What a pause change reports back. `changed` is false when it was already so. */
export interface PauseChannelResult {
  connectionId: string;
  scope: ChannelPauseScope;
  paused: boolean;
  changed: boolean;
}

/** POST to pause or resume ONE scope of a connection. */
export async function pauseChannel(
  storeId: string,
  connectionId: string,
  input: { scope: ChannelPauseScope; paused: boolean },
): Promise<PauseChannelResult> {
  const { data } = await apiClient.post<ApiResponse<PauseChannelResult>>(
    `${base(storeId)}/${connectionId}/pause`,
    input,
  );
  return unwrap(data);
}

/**
 * POST to disconnect with an explicit policy for what the channel produced.
 *
 * Distinct from {@link disconnectChannel}, which is the v1 `DELETE` and always
 * keeps listings. A merchant choosing what happens to their catalogue uses this.
 */
export async function disconnectChannelWithPolicy(
  storeId: string,
  connectionId: string,
  policy: ChannelDisconnectPolicy,
): Promise<ChannelDisconnectResult> {
  const { data } = await apiClient.post<ApiResponse<ChannelDisconnectResult>>(
    `${base(storeId)}/${connectionId}/disconnect`,
    { policy },
  );
  return unwrap(data);
}

// ── The connection wizard ───────────────────────────────────────────────────

const onboardingBase = (storeId: string) => `${base(storeId)}/onboarding`;

/** GET this store's onboarding sessions, newest first. */
export async function fetchChannelOnboarding(
  storeId: string,
): Promise<ChannelOnboardingSession[]> {
  const { data } = await apiClient.get<ApiResponse<ChannelOnboardingSession[]>>(
    onboardingBase(storeId),
  );
  return unwrap(data);
}

/** GET one session. */
export async function fetchChannelOnboardingSession(
  storeId: string,
  sessionId: string,
): Promise<ChannelOnboardingSession> {
  const { data } = await apiClient.get<ApiResponse<ChannelOnboardingSession>>(
    `${onboardingBase(storeId)}/${sessionId}`,
  );
  return unwrap(data);
}

/**
 * POST to start (or resume) a wizard for a channel type.
 *
 * Idempotent server-side: a merchant with a live session for this channel gets
 * that session back rather than a second one, so a double tap or a retry cannot
 * create a duplicate.
 */
export async function startChannelOnboarding(
  storeId: string,
  channelType: ChannelTypeId,
): Promise<ChannelOnboardingSession> {
  const { data } = await apiClient.post<ApiResponse<ChannelOnboardingSession>>(
    onboardingBase(storeId),
    { channelType },
  );
  return unwrap(data);
}

/** What a wizard step may record. There is deliberately no credential field. */
export interface AdvanceChannelOnboardingInput {
  step?: ChannelOnboardingStep;
  connectionId?: string;
  feedConfigurationId?: string;
  preview?: ChannelPreviewCounts;
}

/** PATCH a session's step. */
export async function advanceChannelOnboarding(
  storeId: string,
  sessionId: string,
  input: AdvanceChannelOnboardingInput,
): Promise<ChannelOnboardingSession> {
  const { data } = await apiClient.patch<ApiResponse<ChannelOnboardingSession>>(
    `${onboardingBase(storeId)}/${sessionId}`,
    input,
  );
  return unwrap(data);
}

/** POST to activate. Refused, with reasons, when a blocker still applies. */
export async function activateChannelOnboarding(
  storeId: string,
  sessionId: string,
): Promise<ChannelOnboardingSession> {
  const { data } = await apiClient.post<ApiResponse<ChannelOnboardingSession>>(
    `${onboardingBase(storeId)}/${sessionId}/activate`,
  );
  return unwrap(data);
}

/** DELETE (abandon) a session, freeing the live slot for its channel type. */
export async function abandonChannelOnboarding(
  storeId: string,
  sessionId: string,
): Promise<ChannelOnboardingSession> {
  const { data } = await apiClient.delete<ApiResponse<ChannelOnboardingSession>>(
    `${onboardingBase(storeId)}/${sessionId}`,
  );
  return unwrap(data);
}
