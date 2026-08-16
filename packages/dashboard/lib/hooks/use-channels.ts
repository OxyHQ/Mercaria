import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ChannelApiKey,
  ChannelAuditEntry,
  ChannelDisconnectPolicy,
  ChannelOnboardingSession,
  ChannelPauseScope,
  ChannelReadiness,
  ChannelReconciliationSummary,
  ChannelSummary,
  ChannelTypeDescriptor,
  ChannelTypeId,
  Connection,
  ConnectorProviderId,
  GenerateChannelApiKeyInput,
  SyncRun,
  SyncRunRecordFailurePage,
  UpdateSyncSettingsInput,
} from "@mercaria/shared-types";
import {
  fetchChannels,
  connectChannel,
  connectKeyChannel,
  updateChannelSettings,
  syncChannel,
  disconnectChannel,
  fetchChannelKeys,
  generateChannelKey,
  revokeChannelKey,
  abandonChannelOnboarding,
  activateChannelOnboarding,
  advanceChannelOnboarding,
  disconnectChannelWithPolicy,
  fetchChannelAudit,
  fetchChannelCatalog,
  fetchChannelOnboarding,
  fetchChannelOnboardingSession,
  fetchChannelReadiness,
  fetchChannelReconciliation,
  fetchChannelRunRecordFailures,
  fetchChannelRuns,
  fetchChannelSummary,
  pauseChannel,
  reregisterChannelWebhooks,
  startChannelOnboarding,
  type AdvanceChannelOnboardingInput,
  type ConnectKeyInput,
} from "../api/channels";
import { queryKeys } from "../queryKeys";

/** The store's channel connections. */
export function useChannels(storeId: string) {
  return useQuery<Connection[]>({
    queryKey: queryKeys.channels(storeId),
    queryFn: () => fetchChannels(storeId),
    enabled: Boolean(storeId),
  });
}

function invalidateChannels(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.channels(storeId) });
}

/**
 * Begin an OAuth connect. Resolves with `{ authorizeUrl }`; the caller opens it
 * in a browser and refetches once the out-of-band OAuth callback has created the
 * connection — so this mutation does NOT invalidate on its own.
 */
export function useConnectChannel(storeId: string) {
  return useMutation({
    mutationFn: (input: {
      provider: ConnectorProviderId;
      shopDomain: string;
      onboardingSessionId?: string;
    }) =>
      connectChannel(storeId, input.provider, {
        shopDomain: input.shopDomain,
        onboardingSessionId: input.onboardingSessionId,
      }),
  });
}

/**
 * Connect an API-key provider (WooCommerce). The connection is created
 * synchronously by the server (no browser redirect), so this invalidates the
 * channels list on success to surface the new connection immediately.
 */
export function useConnectKeyChannel(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: ConnectorProviderId } & ConnectKeyInput) =>
      connectKeyChannel(storeId, input.provider, {
        shopDomain: input.shopDomain,
        consumerKey: input.consumerKey,
        consumerSecret: input.consumerSecret,
      }),
    onSuccess: () => invalidateChannels(queryClient, storeId),
  });
}

/** Update a connection's sync settings. */
export function useUpdateChannelSettings(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; settings: UpdateSyncSettingsInput }) =>
      updateChannelSettings(storeId, input.connectionId, input.settings),
    onSuccess: () => invalidateChannels(queryClient, storeId),
  });
}

/** Enqueue a backfill for a connection; resolves once the server has ACCEPTED it. */
export function useSyncChannel(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => syncChannel(storeId, connectionId),
    onSuccess: () => invalidateChannels(queryClient, storeId),
  });
}

/** Disconnect a connection. */
export function useDisconnectChannel(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => disconnectChannel(storeId, connectionId),
    onSuccess: () => invalidateChannels(queryClient, storeId),
  });
}

function invalidateChannelKeys(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.channelKeys(storeId) });
}

/** The store's active channel API keys (metadata only). */
export function useChannelKeys(storeId: string) {
  return useQuery<ChannelApiKey[]>({
    queryKey: queryKeys.channelKeys(storeId),
    queryFn: () => fetchChannelKeys(storeId),
    enabled: Boolean(storeId),
  });
}

/**
 * Mint a channel key. The mutation resolves with the plaintext key (shown once);
 * it invalidates the keys list so the new key's metadata appears immediately.
 */
export function useGenerateChannelKey(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateChannelApiKeyInput) => generateChannelKey(storeId, input),
    onSuccess: () => invalidateChannelKeys(queryClient, storeId),
  });
}

/** Revoke a channel key. */
export function useRevokeChannelKey(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => revokeChannelKey(storeId, keyId),
    onSuccess: () => invalidateChannelKeys(queryClient, storeId),
  });
}

// ---------------------------------------------------------------------------
// The unified channel surface (#87).
// ---------------------------------------------------------------------------

/**
 * Invalidate everything a channel WRITE can move.
 *
 * The list, the summary and the readiness result all describe the same
 * connections from three angles, so a pause that refreshed only the list would
 * leave the readiness banner claiming a catalogue is live while the row beside
 * it says paused. One helper rather than three call sites remembering.
 */
function invalidateChannelSurface(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.channels(storeId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.channelSummary(storeId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.channelReadiness(storeId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.channelAudit(storeId) });
}

/**
 * What may be connected on this deployment, and what is wrong with each.
 *
 * `staleTime` is generous because a descriptor changes when the DEPLOYMENT
 * changes — a new connector, an OAuth app configured — not when a merchant does
 * anything. Refetching it on every focus would be a request per tab switch for
 * an answer that is the same all day.
 */
export function useChannelCatalog(storeId: string) {
  return useQuery<ChannelTypeDescriptor[]>({
    queryKey: queryKeys.channelCatalog(storeId),
    queryFn: () => fetchChannelCatalog(storeId),
    enabled: Boolean(storeId),
    staleTime: 5 * 60 * 1000,
  });
}

/** Connectors, feeds and the native catalogue in ONE shape. */
export function useChannelSummary(storeId: string) {
  return useQuery<ChannelSummary[]>({
    queryKey: queryKeys.channelSummary(storeId),
    queryFn: () => fetchChannelSummary(storeId),
    enabled: Boolean(storeId),
  });
}

/** The ONE authoritative readiness result (#87 acceptance 7). */
export function useChannelReadiness(storeId: string) {
  return useQuery<ChannelReadiness>({
    queryKey: queryKeys.channelReadiness(storeId),
    queryFn: () => fetchChannelReadiness(storeId),
    enabled: Boolean(storeId),
  });
}

/** One connection's sync history, newest first. */
export function useChannelRuns(storeId: string, connectionId: string) {
  return useQuery<SyncRun[]>({
    queryKey: queryKeys.channelRuns(storeId, connectionId),
    queryFn: () => fetchChannelRuns(storeId, connectionId),
    enabled: Boolean(storeId) && Boolean(connectionId),
  });
}

/**
 * WHICH records one run refused, and why (#303).
 *
 * `enabled` is the caller's, so nothing is fetched until a merchant opens one
 * run: a history page carrying fifty of these would download every reason for
 * every run to render a control most people never press.
 */
export function useChannelRunRecordFailures(
  storeId: string,
  connectionId: string,
  runId: string,
  enabled: boolean,
) {
  return useQuery<SyncRunRecordFailurePage>({
    queryKey: queryKeys.channelRunRecordFailures(storeId, connectionId, runId),
    queryFn: () => fetchChannelRunRecordFailures(storeId, connectionId, runId),
    enabled: enabled && Boolean(storeId) && Boolean(connectionId) && Boolean(runId),
  });
}

/** What Mercaria already indexed for this connection's merchant. */
export function useChannelReconciliation(storeId: string, connectionId: string) {
  return useQuery<ChannelReconciliationSummary>({
    queryKey: queryKeys.channelReconciliation(storeId, connectionId),
    queryFn: () => fetchChannelReconciliation(storeId, connectionId),
    enabled: Boolean(storeId) && Boolean(connectionId),
  });
}

/** Who changed what about this store's channels. */
export function useChannelAudit(storeId: string) {
  return useQuery<ChannelAuditEntry[]>({
    queryKey: queryKeys.channelAudit(storeId),
    queryFn: () => fetchChannelAudit(storeId),
    enabled: Boolean(storeId),
  });
}

/** Pause or resume ONE scope. */
export function usePauseChannel(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      connectionId: string;
      scope: ChannelPauseScope;
      paused: boolean;
    }) => pauseChannel(storeId, input.connectionId, { scope: input.scope, paused: input.paused }),
    onSuccess: () => invalidateChannelSurface(queryClient, storeId),
  });
}

/**
 * Register a connection's platform webhooks again, without a reconnect (#262).
 *
 * Invalidates the whole channel surface rather than just the connections list: a
 * successful registration clears `connection_webhook_failures`, which is one of
 * the inputs `ChannelReadiness` derives its `degraded` catalogue axis from — so
 * the readiness banner has to be re-read or the merchant fixes the problem and is
 * still told they have one.
 *
 * The server answers 202 and the registration happens on the sync queue, so the
 * connection this invalidation re-reads may still show the old refusals for a
 * moment. That is honest rather than awkward: the alternative is a client
 * pretending to know an outcome only the platform can give it.
 */
export function useReregisterChannelWebhooks(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => reregisterChannelWebhooks(storeId, connectionId),
    onSuccess: () => invalidateChannelSurface(queryClient, storeId),
  });
}

/** Disconnect with an explicit policy for what the channel produced. */
export function useDisconnectChannelWithPolicy(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; policy: ChannelDisconnectPolicy }) =>
      disconnectChannelWithPolicy(storeId, input.connectionId, input.policy),
    onSuccess: () => invalidateChannelSurface(queryClient, storeId),
  });
}

// ── The connection wizard ───────────────────────────────────────────────────

function invalidateOnboarding(
  queryClient: ReturnType<typeof useQueryClient>,
  storeId: string,
  sessionId?: string,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.channelOnboarding(storeId) });
  if (sessionId) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.channelOnboardingSession(storeId, sessionId),
    });
  }
}

/** This store's onboarding sessions, newest first. */
export function useChannelOnboardingSessions(storeId: string) {
  return useQuery<ChannelOnboardingSession[]>({
    queryKey: queryKeys.channelOnboarding(storeId),
    queryFn: () => fetchChannelOnboarding(storeId),
    enabled: Boolean(storeId),
  });
}

/**
 * How often the wizard re-reads its session while an OAuth handoff is out.
 *
 * Three seconds: the merchant is watching a screen that says it is waiting, and
 * the request is one indexed row.
 */
const OAUTH_HANDOFF_POLL_INTERVAL_MS = 3_000;

/**
 * How long that poll may run.
 *
 * Bounded by the server's OAuth `state` TTL (`connectors/oauth-state.ts`, ten
 * minutes): past it the callback answers "OAuth state expired" and creates no
 * connection, so a longer poll cannot observe anything. Overshooting costs a few
 * requests in a forgotten tab; undershooting costs the merchant the update this
 * exists to deliver, so it tracks the TTL rather than sitting under it.
 */
const OAUTH_HANDOFF_POLL_WINDOW_MS = 10 * 60 * 1000;

/**
 * One session, with its LIVE activation blockers.
 *
 * ## Why this polls at all
 *
 * A Shopify connect LEAVES this tab: the merchant authorizes on Shopify, and the
 * callback — which creates the connection and links it onto this session — answers
 * into a DIFFERENT tab on web. So the tab holding the wizard is never navigated,
 * and nothing in it observes the connect finishing.
 *
 * Nor does anything else. The shared Oxy `QueryClient` sets
 * `refetchOnWindowFocus: false` with a five-minute `staleTime`, so switching back
 * to the wizard tab refetches NOTHING and even a remount inside that window is
 * served from cache. Without the poll the merchant's own report — "nothing
 * reacted" — stays true after the server-side fix, which is exactly the failure
 * being closed.
 *
 * `refetchInterval` overrides `staleTime`, which is what makes it work here.
 *
 * ## What arms it, and what disarms it
 *
 * ARMED by the screen, and only by an actual handoff (`awaitingConnectionSince` is
 * the instant the merchant was sent to the platform) — an idle wizard polls
 * nothing. DISARMED by the DATA rather than by the screen: the moment the session
 * carries a connection, or stops being live, the interval returns `false`. Putting
 * the stop condition on the answer rather than on a second piece of screen state
 * is what keeps the poll from outliving the thing it is waiting for.
 */
export function useChannelOnboardingSession(
  storeId: string,
  sessionId: string,
  options?: { awaitingConnectionSince?: number | null },
) {
  const awaitingSince = options?.awaitingConnectionSince ?? null;
  return useQuery<ChannelOnboardingSession>({
    queryKey: queryKeys.channelOnboardingSession(storeId, sessionId),
    queryFn: () => fetchChannelOnboardingSession(storeId, sessionId),
    enabled: Boolean(storeId) && Boolean(sessionId),
    refetchInterval: (query) => {
      if (awaitingSince === null) return false;
      if (Date.now() - awaitingSince > OAUTH_HANDOFF_POLL_WINDOW_MS) return false;
      const session = query.state.data;
      // Nothing read yet: keep asking rather than deciding off an absence.
      if (!session) return OAUTH_HANDOFF_POLL_INTERVAL_MS;
      if (session.state !== "in_progress") return false;
      if (session.connectionId !== undefined) return false;
      return OAUTH_HANDOFF_POLL_INTERVAL_MS;
    },
  });
}

/** Start (or resume) a wizard. Idempotent server-side. */
export function useStartChannelOnboarding(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelType: ChannelTypeId) => startChannelOnboarding(storeId, channelType),
    onSuccess: (session) => invalidateOnboarding(queryClient, storeId, session.id),
  });
}

/** Record a wizard step. */
export function useAdvanceChannelOnboarding(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string } & AdvanceChannelOnboardingInput) => {
      const { sessionId, ...patch } = input;
      return advanceChannelOnboarding(storeId, sessionId, patch);
    },
    onSuccess: (session) => invalidateOnboarding(queryClient, storeId, session.id),
  });
}

/** Activate. Refused, with reasons, when a blocker still applies. */
export function useActivateChannelOnboarding(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => activateChannelOnboarding(storeId, sessionId),
    onSuccess: (session) => {
      invalidateOnboarding(queryClient, storeId, session.id);
      invalidateChannelSurface(queryClient, storeId);
    },
  });
}

/** Abandon a session, freeing the live slot for its channel type. */
export function useAbandonChannelOnboarding(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => abandonChannelOnboarding(storeId, sessionId),
    onSuccess: (session) => invalidateOnboarding(queryClient, storeId, session.id),
  });
}
