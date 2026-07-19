import type {
  ApiResponse,
  ChannelApiKey,
  Connection,
  ConnectionStatus,
  ConnectorProviderId,
  GenerateChannelApiKeyInput,
  GenerateChannelApiKeyResult,
  SyncRun,
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
