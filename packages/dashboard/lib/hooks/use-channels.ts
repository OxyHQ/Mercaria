import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Connection,
  ConnectorProviderId,
  UpdateSyncSettingsInput,
} from "@mercaria/shared-types";
import {
  fetchChannels,
  connectChannel,
  connectKeyChannel,
  updateChannelSettings,
  syncChannel,
  disconnectChannel,
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
    mutationFn: (input: { provider: ConnectorProviderId; shopDomain: string }) =>
      connectChannel(storeId, input.provider, { shopDomain: input.shopDomain }),
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

/** Trigger a backfill sync; resolves with the resulting `SyncRun`. */
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
